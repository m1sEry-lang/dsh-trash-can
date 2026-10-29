/**
 * dsh-trash-can — Host half.
 *
 * Owns everything that touches the filesystem: moving an archived Session into
 * the configured trash directory, restoring it, purging it, the 360-hour
 * expiry scan, produced-file detection, content summaries, and the JSON state
 * file. The browser half only renders and calls these routes.
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as zlib from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const PROJECTION_CACHE = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const WORKSPACE_REGISTRY = path.join(DSH_HOME, 'storages', 'workspace.json')
const ATTACHMENTS_ROOT = path.join(DSH_HOME, 'attachments', 'v1', 'objects')
const REQUEST_IMAGES_ROOT = path.join(DSH_HOME, 'cache', 'attachments', 'request-images')
const PROVIDER_FILE_REGISTRY = path.join(DSH_HOME, 'llm-deepseek', 'files-v3.json')
const STATE_FILE = path.join(DSH_HOME, 'storages', 'dsh-trash-can.json')

/** 15 days, exact hours. */
const TTL_MS = 360 * 60 * 60 * 1000
const ROUTE_PREFIX = '/api/dsh-trash'

export const name = 'dsh-trash-can'
export const inject = ['webServer']

/** Diagnostics only: lets `test/plan.mjs` exercise the Host logic without a booted profile. */
export const __internals = {
  findSessionDir,
  loadSessionText,
  parseEvents,
  extractUserTexts,
  extractProductPaths,
  buildSummary,
  extractAttachmentIds,
  planSession,
  readState,
  writeState,
  moveSession,
  restoreSession,
  purgeEntry,
  purgeExpired,
  entryView,
  dropFromRegistry,
  reconcileRegistry,
  readArchivedIds,
  registerInWorkspace,
  findWorkspaceEntry,
  addToWorkspaceRegistry,
  inspectAndRepair,
  runSelfCheck,
  readReports,
  scheduleSelfCheck,
  TTL_MS,
}

/* ------------------------------------------------------------------ state */

function defaultState() {
  return {
    version: 1,
    trashDir: '',
    opacity: 75,
    cardWidth: 360,
    syncRegistry: false,
    requireArchived: true,
    entries: [],
  }
}

async function readState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...defaultState(), ...parsed, entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
  } catch {
    return defaultState()
  }
}

async function writeState(state) {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  await fsp.rename(tmp, STATE_FILE)
}

/* -------------------------------------------------------------- fs helpers */

async function exists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

function volumeOf(target) {
  return path.parse(path.resolve(target)).root.toUpperCase()
}

async function dirTotals(dir) {
  let files = 0
  let bytes = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let items
    try {
      items = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) stack.push(full)
      else if (item.isFile()) {
        files += 1
        try {
          bytes += (await fsp.stat(full)).size
        } catch {}
      }
    }
  }
  return { files, bytes }
}

/** Move a directory across volumes: copy, verify, then drop the source. */
async function moveDir(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  if (volumeOf(from) === volumeOf(to)) {
    await fsp.rename(from, to)
    return
  }
  const before = await dirTotals(from)
  const staging = `${to}.partial-${process.pid}-${Date.now()}`
  await fsp.cp(from, staging, { recursive: true, force: true, errorOnExist: false })
  const after = await dirTotals(staging)
  if (after.files !== before.files || after.bytes !== before.bytes) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw new Error(`复制校验失败：源 ${before.files} 个文件 / ${before.bytes} 字节，副本 ${after.files} / ${after.bytes}`)
  }
  await fsp.rename(staging, to)
  await fsp.rm(from, { recursive: true, force: true })
}

/** Locate `<sessions>/<project>/<sessionId>` across every project directory. */
async function findSessionDir(sessionId) {
  let projects
  try {
    projects = await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = path.join(SESSIONS_ROOT, project.name, sessionId)
    if (await exists(candidate)) return { dir: candidate, project: project.name }
  }
  return undefined
}

/* -------------------------------------------------------- read the session */

/**
 * Stored logs concatenate independent zstd frames (one per durable batch);
 * node's one-shot and streaming decoders both stop after the first frame. Walk
 * the frame magics and decode each slice; a failing slice is not a boundary, so
 * the search widens.
 */
function zstdDecodeAll(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = buffer.indexOf(magic); i >= 0; i = buffer.indexOf(magic, i + 1)) offsets.push(i)
  if (!offsets.length) return buffer.toString('utf8')
  offsets.push(buffer.length)
  const parts = []
  let i = 0
  while (i < offsets.length - 1) {
    let advanced = false
    for (let j = i + 1; j < offsets.length; j++) {
      try {
        parts.push(zlib.zstdDecompressSync(buffer.subarray(offsets[i], offsets[j])))
        i = j
        advanced = true
        break
      } catch {}
    }
    if (!advanced) i += 1
  }
  return Buffer.concat(parts).toString('utf8')
}

async function loadSessionText(ctx, sessionId, sessionDir) {
  // Preferred: the Host's own persistence reader (no format guessing).
  try {
    const persistence = ctx.sessionPersistence
    if (persistence) {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const page = await handle.read(0, 200000)
        const events = page?.events ?? []
        if (Array.isArray(events) && events.length) {
          return events.map((event) => JSON.stringify(event)).join('\n')
        }
      } finally {
        await handle.close?.()
      }
    }
  } catch {}
  // Fallback: decompress the newest stored generation and read it as text.
  try {
    const names = await fsp.readdir(sessionDir)
    const logs = names.filter((n) => n.endsWith('.zstd')).sort().reverse()
    for (const log of logs) {
      const raw = await fsp.readFile(path.join(sessionDir, log))
      return zstdDecodeAll(raw)
    }
  } catch {}
  return ''
}

/** Parse the stored log lines into Session event objects. */
function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {}
  }
  return events
}

/** Tools whose arguments name a file this conversation produced. */
const PRODUCT_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'create_file', 'write_file'])

/** What the human actually typed, ignoring injected context and approvals. */
function extractUserTexts(events) {
  const texts = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const kind = event?.data?.source?.kind
    if (kind && kind !== 'user') continue
    for (const block of event?.data?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) texts.push(block.text.trim())
    }
  }
  return texts
}

/** Absolute paths the conversation wrote or edited. */
function extractProductPaths(events) {
  const found = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    if (!PRODUCT_TOOLS.has(String(event?.data?.name ?? ''))) continue
    let args = event?.data?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    const target = args?.file_path ?? args?.path
    if (typeof target === 'string' && target.trim()) found.set(path.resolve(target), true)
  }
  return [...found.keys()]
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'can', 'all', 'not', 'but', 'have',
  '现在', '然后', '就是', '可以', '需要', '如果', '因为', '所以', '这个', '那个', '我们', '你们',
  '一下', '一个', '什么', '怎么', '还是', '已经', '没有', '不是', '但是', '或者', '以及',
])

/** A short reminder line: keywords taken from what the user actually asked. */
function buildSummary(userTexts, title) {
  const keywords = []
  for (const source of userTexts.slice(0, 4)) {
    const tokens = source
      .split(/[\s,，。；;：:、/\\|()（）\[\]{}"'`~!@#$%^&*+=<>?？!！—\-_]+/)
      .filter((token) => token.length >= 2 && token.length <= 12 && !STOPWORDS.has(token.toLowerCase()))
    for (const token of tokens) {
      if (keywords.length >= 6) break
      if (!keywords.includes(token)) keywords.push(token)
    }
    if (keywords.length >= 6) break
  }
  let summary = keywords.join(' · ')
  if (!summary) summary = title || ''
  if (summary.length > 50) summary = `${summary.slice(0, 49)}…`
  return summary
}

async function describeProducts(candidates) {
  const products = []
  for (const candidate of candidates) {
    if (candidate.toLowerCase().startsWith(path.resolve(DSH_HOME).toLowerCase())) continue
    try {
      const info = await fsp.stat(candidate)
      if (!info.isFile()) continue
      products.push({ path: candidate, bytes: info.size, modifiedAt: info.mtimeMs })
    } catch {}
  }
  return products.slice(0, 200)
}

/* -------------------------------------------------------------- attachments */

function extractAttachmentIds(text) {
  const ids = new Set()
  const pattern = /sha256:([0-9a-f]{64})/g
  let match
  while ((match = pattern.exec(text)) !== null) ids.add(match[1])
  return [...ids]
}

/** Drop attachment objects nothing else references; returns what was removed. */
async function gcAttachments(ids, keepSessionText) {
  if (!ids.length) return []
  let others = ''
  try {
    const projects = await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const sessions = await fsp.readdir(path.join(SESSIONS_ROOT, project.name), { withFileTypes: true })
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const dir = path.join(SESSIONS_ROOT, project.name, session.name)
        let names = []
        try {
          names = await fsp.readdir(dir)
        } catch {
          continue
        }
        for (const log of names.filter((n) => n.endsWith('.zstd'))) {
          try {
            const raw = await fsp.readFile(path.join(dir, log))
            others += zstdDecodeAll(raw)
          } catch {}
        }
      }
    }
  } catch {}
  const removed = []
  for (const id of ids) {
    if (keepSessionText.includes(id)) continue
    if (others.includes(id)) continue
    const objectPath = path.join(ATTACHMENTS_ROOT, id.slice(0, 2), id)
    if (await exists(objectPath)) {
      await fsp.rm(objectPath, { force: true }).catch(() => {})
      removed.push(objectPath)
    }
    // Request-sized copies derived from the object live under a content hash of
    // their own; prune the whole request-image cache entry that names it.
    try {
      const shards = await fsp.readdir(REQUEST_IMAGES_ROOT)
      for (const shard of shards) {
        const dir = path.join(REQUEST_IMAGES_ROOT, shard)
        const files = await fsp.readdir(dir).catch(() => [])
        for (const file of files) {
          const full = path.join(dir, file)
          if (await exists(full)) {
            // The variant id is stored in the provider registry, not here; a
            // file whose bytes hash to a stale variant is left for DSH's own
            // expiry. Only objects directly named by the session are removed.
          }
        }
      }
    } catch {}
  }
  // Prune provider-upload records that name a removed attachment.
  try {
    const raw = await fsp.readFile(PROVIDER_FILE_REGISTRY, 'utf8')
    const doc = JSON.parse(raw)
    const kept = (doc.records ?? []).filter((record) => {
      const id = String(record.attachmentId ?? '').replace(/^sha256:/, '')
      return id ? !removed.some((p) => path.basename(p) === id) : true
    })
    if (kept.length !== (doc.records ?? []).length) {
      await fsp.writeFile(PROVIDER_FILE_REGISTRY, JSON.stringify({ ...doc, records: kept }, null, 2), 'utf8')
    }
  } catch {}
  return removed
}

/* ------------------------------------------------------------- registry ops */

/** Remove a Session id from the Workspace registry's sets and Workspace lists. */
async function dropFromRegistry(sessionId) {
  try {
    const raw = await fsp.readFile(WORKSPACE_REGISTRY, 'utf8')
    if (!raw.includes(sessionId)) return
    const doc = JSON.parse(raw)
    const global = doc.global ?? {}
    let changed = false
    const prune = (list) => {
      if (!Array.isArray(list)) return list
      const next = list.filter((id) => id !== sessionId)
      if (next.length !== list.length) changed = true
      return next
    }
    global.archivedSessionIds = prune(global.archivedSessionIds ?? [])
    global.pinnedSessionIds = prune(global.pinnedSessionIds ?? [])
    for (const workspace of Object.values(doc.tables?.workspaces ?? {})) {
      workspace.sessionIds = prune(workspace.sessionIds ?? [])
    }
    doc.global = global
    if (!changed) return
    const tmp = `${WORKSPACE_REGISTRY}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
    await fsp.rename(tmp, WORKSPACE_REGISTRY)
  } catch {}
}

async function dropProjection(sessionId) {
  try {
    await fsp.rm(path.join(PROJECTION_CACHE, `${sessionId}.json`), { force: true })
  } catch {}
}

/** The registry-global archived set, so the row menu knows which rows may be deleted. */
async function readArchivedIds() {
  try {
    const doc = JSON.parse(await fsp.readFile(WORKSPACE_REGISTRY, 'utf8'))
    const ids = doc?.global?.archivedSessionIds
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

/**
 * Re-apply the registry removal for every Session already in the trash.
 *
 * Runs on each state read so a row that survived an older build — or that the
 * live Host re-added from its in-memory registry — disappears on the next open
 * instead of staying broken forever.
 */
async function reconcileRegistry(state) {
  const ids = state.entries.map((entry) => entry.sessionId)
  for (const id of ids) await dropFromRegistry(id)
}

/**
 * The live Workspace registry service (`ctx.workspaceRegistry`), or undefined
 * when this profile does not mount it. Reached through `ctx.get` because this
 * plugin only injects `webServer`; the service is optional at runtime.
 */
function workspaceRegistryOf(ctx) {
  try {
    return ctx?.get?.('workspaceRegistry') ?? undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------ trash actions */

function entryView(entry) {
  const age = Date.now() - entry.movedAt
  const left = TTL_MS - age
  return {
    sessionId: entry.sessionId,
    title: entry.title,
    summary: entry.summary,
    workspacePath: entry.workspacePath,
    movedAt: entry.movedAt,
    sizeBytes: entry.sizeBytes ?? 0,
    productsDeleted: entry.productsDeleted ?? 0,
    msLeft: left,
    hoursLeft: Math.max(0, Math.ceil(left / 3_600_000)),
    daysLeft: Math.max(0, Math.ceil(left / 86_400_000)),
    expired: left <= 0,
  }
}

async function purgeEntry(state, sessionId) {
  const entry = state.entries.find((item) => item.sessionId === sessionId)
  if (!entry) return { removed: false }
  const dir = path.join(state.trashDir, sessionId)
  await fsp.rm(dir, { recursive: true, force: true })
  // The projection is the only remaining trace; keep it until the Session is
  // really gone so a restore still knows its title.
  await dropProjection(sessionId)
  state.entries = state.entries.filter((item) => item.sessionId !== sessionId)
  await writeState(state)
  return { removed: true }
}

async function purgeExpired(state) {
  if (!state.trashDir) return []
  const expired = state.entries.filter((entry) => Date.now() - entry.movedAt >= TTL_MS)
  const purged = []
  for (const entry of expired) {
    const result = await purgeEntry(state, entry.sessionId).catch(() => ({ removed: false }))
    if (result.removed) purged.push(entry.sessionId)
  }
  return purged
}

async function planSession(ctx, state, sessionId) {
  const located = await findSessionDir(sessionId)
  if (!located) throw new Error('找不到这个会话的存储目录（可能已被删除）')
  const text = await loadSessionText(ctx, sessionId, located.dir)
  const events = parseEvents(text)
  const products = await describeProducts(extractProductPaths(events))
  let title = sessionId
  try {
    const cached = JSON.parse(await fsp.readFile(path.join(PROJECTION_CACHE, `${sessionId}.json`), 'utf8'))
    const value = cached?.record?.rows?.title?.val
    if (typeof value === 'string' && value.trim()) title = value.trim()
  } catch {}
  const summary = buildSummary(extractUserTexts(events), title)
  const cwd = typeof events[0]?.cwd === 'string' && events[0].cwd ? events[0].cwd : decodeProjectPath(located.project)
  return { located, text, events, title, summary, products, cwd }
}

async function moveSession(ctx, state, sessionId, options = {}) {
  if (!state.trashDir) throw new Error('还没有设置垃圾桶目录')
  if (state.entries.some((entry) => entry.sessionId === sessionId)) throw new Error('这个会话已经在垃圾桶里了')
  // Only an archived Session may be moved: it cannot be open, so no writer can
  // be appending to the log while it leaves the sessions root.
  if (state.requireArchived !== false) {
    const archived = await readArchivedIds()
    if (!archived.includes(sessionId)) throw new Error('只有已归档的会话才能移入垃圾桶，请先归档')
  }
  const plan = await planSession(ctx, state, sessionId)
  // "Archived" does not mean "closed". A blank Session (created by the New-session
  // button, no events yet) can be archived while the Host still holds it in memory;
  // moving its files then leaves a live object with no log, which the sidebar can
  // only render as an empty "未分组" row. Refuse that one case instead of half-doing it.
  if (liveSessionLookup(ctx)(sessionId) && plan.events.length <= 1) {
    throw new Error('这个会话是空的、但还活在宿主内存里：删掉会在侧栏留下一条打不开的空行。请先切换到别的会话，或重启桌面端后再删。')
  }
  const trashDir = path.resolve(state.trashDir)
  await fsp.mkdir(trashDir, { recursive: true })

  const totals = await dirTotals(plan.located.dir)
  await moveDir(plan.located.dir, path.join(trashDir, sessionId))

  const removeProducts = Array.isArray(options.removeProducts) ? options.removeProducts : []
  let productsDeleted = 0
  for (const target of removeProducts) {
    try {
      await fsp.rm(target, { force: true, recursive: true })
      productsDeleted += 1
    } catch {}
  }

  const meta = {
    sessionId,
    title: plan.title,
    summary: plan.summary,
    workspacePath: plan.cwd,
    projectDir: plan.located.project,
    movedAt: Date.now(),
    sizeBytes: totals.bytes,
    productsDeleted,
  }
  await fsp.writeFile(path.join(trashDir, sessionId, 'trash-meta.json'), JSON.stringify(meta, null, 2), 'utf8')

  state.entries = state.entries.filter((entry) => entry.sessionId !== sessionId)
  state.entries.push(meta)
  await writeState(state)

  // The projection cache stays: it is the only place the Session's title
  // survives a round trip through the trash. It is dropped on purge instead.
  // Dropping the Session from the archive set through the Host's own service is
  // what removes the "archived" row from the sidebar; editing the registry file
  // behind a live Host would only race with its in-memory state.
  // Remove the Session from the live archive set through the Host's own service,
  // then from the persisted registry: the service only knows about archiving,
  // while a trashed Session must also leave its Workspace's member list or the
  // sidebar keeps rendering the row from a log that no longer exists.
  await releaseArchive(ctx, sessionId, plan.cwd)
  await dropFromRegistry(sessionId)
  const attachments = await gcAttachments(extractAttachmentIds(plan.text), plan.text).catch(() => [])
  return { entry: entryView(meta), attachmentsRemoved: attachments.length }
}

/**
 * Remove one Session from the live registry: the archive set and its Workspace
 * member list. Both go through the Host's own service so its in-memory snapshot
 * and the persisted domain record move together — writing the file alone leaves
 * the sidebar rendering the row until the next boot.
 */
async function releaseArchive(ctx, sessionId, workspacePath) {
  let changed = false
  const registry = workspaceRegistryOf(ctx)
  if (!registry) return false
  try {
    if (typeof registry.unarchiveSession === 'function') {
      await registry.unarchiveSession(sessionId)
      changed = true
    }
  } catch {}
  try {
    if (workspacePath && typeof registry.resolveByPath === 'function') {
      const workspace = await registry.resolveByPath(workspacePath)
      if (workspace && typeof workspace.detachSession === 'function') {
        await workspace.detachSession(sessionId)
        changed = true
      }
    }
  } catch {}
  return changed
}

/** Rewrite only the cached title so a restored Session keeps a readable name. */
async function patchProjectionTitle(sessionId, title) {
  const target = path.join(PROJECTION_CACHE, `${sessionId}.json`)
  try {
    const doc = JSON.parse(await fsp.readFile(target, 'utf8'))
    const rows = doc?.record?.rows
    if (!rows?.title) return false
    rows.title = { ...rows.title, val: title }
    const tmp = `${target}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(doc), 'utf8')
    await fsp.rename(tmp, target)
    return true
  } catch {
    return false
  }
}

async function restoreSession(ctx, state, sessionId) {
  const entry = state.entries.find((item) => item.sessionId === sessionId)
  if (!entry) throw new Error('垃圾桶里没有这个会话')
  const source = path.join(state.trashDir, sessionId)
  const projectDir = entry.projectDir || '--restored--'
  const target = path.join(SESSIONS_ROOT, projectDir, sessionId)
  await moveDir(source, target)

  // The trash marker belongs to the trash, not to the Session.
  await fsp.rm(path.join(target, 'trash-meta.json'), { force: true }).catch(() => {})

  // The Session's own workspace may be gone on this machine; the title carries
  // that fact so the restored row is recognizable after it lands in Ungrouped.
  const workspaceMissing = !entry.workspacePath || !(await exists(entry.workspacePath))
  let title = entry.title
  if (workspaceMissing) {
    const name = entry.workspacePath ? path.basename(entry.workspacePath) : '原工作区'
    title = `${entry.title}（${name}）`
    await patchProjectionTitle(sessionId, title)
  }

  // Deleting removed the Session from its Workspace's member list, so restoring
  // has to put it back — otherwise the files return but no row does.
  const registered = await registerInWorkspace(ctx, entry.workspacePath, sessionId)

  state.entries = state.entries.filter((item) => item.sessionId !== sessionId)
  await writeState(state)
  // Files back on disk is not the same as "visible in the sidebar": the Host's
  // Session list and its Workspace registry are separate live state. Ask both
  // and report the truth instead of promising a row the UI may not have yet.
  const visible = await sessionVisibleToHost(ctx, sessionId)
  const listed = await workspaceAccountsFor(ctx, entry.workspacePath, sessionId)
  return { sessionId, projectDir, title, workspaceMissing, registered, visible, listed }
}

/**
 * Does the Host's own Session list already contain this Session?
 * `undefined` means the list service is not mounted, so nothing can be claimed.
 */
async function sessionVisibleToHost(ctx, sessionId) {
  try {
    const query = ctx?.get?.('sessionQuery')
    if (!query || typeof query.listSessions !== 'function') return undefined
    const rows = await query.listSessions()
    if (!Array.isArray(rows)) return undefined
    return rows.some((row) => String(row?.id ?? row?.sessionId ?? '') === sessionId)
  } catch {
    return undefined
  }
}

/** Does the live Workspace registry already count this Session as a member? */
async function workspaceAccountsFor(ctx, workspacePath, sessionId) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (!registry || typeof registry.resolveByPath !== 'function' || !workspacePath) return undefined
    const workspace = await registry.resolveByPath(workspacePath)
    if (!workspace) return false
    return Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Put a Session back into the Workspace that owns it.
 *
 * The live registry is the only layer the sidebar groups by, so a file-level
 * repair alone lands the row under "未分组" until the next boot. Therefore:
 * resolve the Workspace entity by the Session's own header cwd first (the
 * authoritative value), fall back to the path recorded at delete time, and only
 * then write the persisted registry directly.
 */
async function registerInWorkspace(ctx, workspacePath, sessionId) {
  const registry = workspaceRegistryOf(ctx)
  const candidates = []
  const header = await restoredHeader(sessionId)
  if (header && typeof header.cwd === 'string' && header.cwd) candidates.push(header.cwd)
  if (workspacePath) candidates.push(workspacePath)
  if (registry) {
    for (const candidate of candidates) {
      try {
        let workspace = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(candidate) : undefined
        if (!workspace) workspace = workspaceEntityByPath(registry, candidate)
        if (!workspace || typeof workspace.attachSession !== 'function') continue
        await workspace.attachSession(sessionId)
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return true
      } catch {}
    }
  }
  const workspace = await findWorkspaceEntry(candidates[0] ?? workspacePath)
  if (!workspace) return false
  if (await workspaceHasSession(workspace.workspaceId, sessionId)) return true
  return addToWorkspaceRegistry(workspace.workspaceId, sessionId)
}

/** The restored Session's persisted header, or undefined when unreadable. */
async function restoredHeader(sessionId) {
  try {
    const located = await findSessionDir(sessionId)
    if (!located) return undefined
    const text = await loadSessionText(undefined, sessionId, located.dir)
    const events = parseEvents(text)
    const first = events.find((event) => event && event.type === 'session')
    return first ?? events[0]
  } catch {
    return undefined
  }
}

/**
 * Match a Workspace entity by path when `resolveByPath` (which realpaths both
 * sides) disagrees: drive-letter case, a trailing separator, or a directory that
 * moved all produce the same entity to a human and different strings to code.
 */
function workspaceEntityByPath(registry, wanted) {
  try {
    if (typeof registry.list !== 'function' || !wanted) return undefined
    const normalize = (value) => String(value).replace(/[\\/]+$/, '').toLowerCase()
    const target = normalize(path.resolve(wanted))
    for (const entity of registry.list()) {
      if (entity && typeof entity.path === 'string' && normalize(entity.path) === target) return entity
    }
  } catch {}
  return undefined
}

async function readWorkspaceRegistry() {
  try {
    return JSON.parse(await fsp.readFile(WORKSPACE_REGISTRY, 'utf8'))
  } catch {
    return undefined
  }
}

async function findWorkspaceEntry(workspacePath) {
  const doc = await readWorkspaceRegistry()
  if (!doc || !workspacePath) return undefined
  const wanted = path.resolve(workspacePath).toLowerCase()
  for (const [workspaceId, value] of Object.entries(doc.tables?.workspaces ?? {})) {
    if (typeof value?.path === 'string' && path.resolve(value.path).toLowerCase() === wanted) {
      return { workspaceId, doc, value }
    }
  }
  return undefined
}

async function workspaceHasSession(workspaceId, sessionId) {
  const doc = await readWorkspaceRegistry()
  const list = doc?.tables?.workspaces?.[workspaceId]?.sessionIds
  return Array.isArray(list) && list.includes(sessionId)
}

async function addToWorkspaceRegistry(workspaceId, sessionId) {
  try {
    const doc = await readWorkspaceRegistry()
    const workspace = doc?.tables?.workspaces?.[workspaceId]
    if (!workspace) return false
    const list = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    if (list.includes(sessionId)) return true
    // First in the list is where the sidebar expects the most recent Session.
    workspace.sessionIds = [sessionId, ...list]
    const tmp = `${WORKSPACE_REGISTRY}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
    await fsp.rename(tmp, WORKSPACE_REGISTRY)
    return true
  } catch {
    return false
  }
}

function decodeProjectPath(projectDir) {
  // `--E-DSH~5DE5~4F5C~533A--` keeps the cwd only as a lossy escape; the real
  // path rides in trash-meta.json when we have it, so this stays a best effort.
  const trimmed = String(projectDir).replace(/^--/, '').replace(/--$/, '')
  if (!trimmed) return ''
  try {
    return trimmed.replace(/~([0-9A-F]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  } catch {
    return trimmed
  }
}

/* ------------------------------------------------------- self-check engine */

/**
 * Post-delete self-check.
 *
 * Moving a Session is one `rename`; what it leaves behind is the interesting
 * part. The Workspace registry may still carry the id (the sidebar then renders
 * a row whose log is gone), `trash-meta.json` may never have been written, or a
 * cross-volume move may have left a `.partial-*` staging directory behind. None
 * of that is provable at move time — the Host is still doing its own bookkeeping
 * — so the engine runs twice, ten seconds apart.
 *
 * Repair policy, deliberately narrow: it may (a) drop registry ids for Sessions
 * that already sit in the trash, (b) rewrite `trash-meta.json` from the ledger,
 * (c) delete this plugin's own `.partial-*` staging leftovers, (d) purge entries
 * past their TTL. Anything that would delete user data, or choose between two
 * surviving copies, is reported to the human instead.
 */
const SELFCHECK_DIR = path.join(DSH_HOME, 'storages', 'dsh-trash-can-selfcheck')
const SELFCHECK_KEEP = 20
const CHECK_DELAYS_MS = [10_000, 20_000]
const PARTIAL_STAGE = /\.partial-\d+-\d+$/
const PARTIAL_MIN_AGE_MS = 60 * 60 * 1000

function makeCheck(id, label, status, detail, fix) {
  const check = { id, label, status, detail }
  if (fix) check.fix = fix
  return check
}

function newReportId() {
  return `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function listDirs(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true })
    return items.filter((item) => item.isDirectory()).map((item) => item.name)
  } catch {
    return []
  }
}

async function sessionsOnDisk() {
  const ids = new Set()
  for (const project of await listDirs(SESSIONS_ROOT)) {
    for (const name of await listDirs(path.join(SESSIONS_ROOT, project))) ids.add(name)
  }
  return ids
}

/** Does the persisted Workspace registry still account for this Session? */
async function workspaceListsSession(sessionId) {
  const doc = await readWorkspaceRegistry()
  if (!doc) return false
  const archived = Array.isArray(doc.global?.archivedSessionIds) && doc.global.archivedSessionIds.includes(sessionId)
  let member = false
  for (const value of Object.values(doc.tables?.workspaces ?? {})) {
    if (Array.isArray(value?.sessionIds) && value.sessionIds.includes(sessionId)) member = true
  }
  return archived || member
}

/** Inspect the trash, repair what is provably safe, and return the evidence. */
async function inspectAndRepair(ctx) {
  const state = await readState()
  const checks = []
  const entries = state.entries
  const known = new Set(entries.map((entry) => entry.sessionId))
  const live = liveSessionLookup(ctx)

  /* 1. The trash directory rule that the configure route enforces. */
  let scanTrash = false
  if (!state.trashDir) {
    checks.push(makeCheck('trash-dir', '垃圾桶目录', 'warn', '还没有设置垃圾桶目录，跳过桶内检查'))
  } else {
    const resolved = path.resolve(state.trashDir)
    const home = path.resolve(DSH_HOME)
    const violates = resolved === path.parse(resolved).root ||
      resolved.toLowerCase() === home.toLowerCase() ||
      resolved.toLowerCase().startsWith(`${home.toLowerCase()}${path.sep}`)
    if (violates) {
      checks.push(makeCheck('trash-dir', '垃圾桶目录规则', 'fail', `目录 ${resolved} 违反「必须在 DSH 主目录之外」的规则，本次不做任何桶内修改`))
    } else {
      scanTrash = true
      checks.push(makeCheck('trash-dir', '垃圾桶目录规则', 'ok', resolved))
    }
  }

  /* 2. Entries past their 360-hour TTL are supposed to disappear on their own. */
  const purged = await purgeExpired(state).catch(() => [])
  if (purged.length) {
    checks.push(makeCheck('expiry', '过期条目清理', 'fixed', `彻底删除 ${purged.length} 条超过 360 小时的条目`, '这是既定的自动清理，删除后不可恢复'))
  } else {
    checks.push(makeCheck('expiry', '过期条目清理', 'ok', '没有超过 360 小时的条目'))
  }

  /* 3. Ledger ↔ trash directory, both directions, plus each entry's meta file. */
  const disk = await sessionsOnDisk()
  const leftBehind = []
  const missingDirs = []
  const rebuilt = []
  const noProjection = []
  for (const entry of entries) {
    if (disk.has(entry.sessionId)) leftBehind.push(entry.sessionId)
    const dir = state.trashDir ? path.join(state.trashDir, entry.sessionId) : ''
    if (!dir || !(await exists(dir))) {
      missingDirs.push(entry.sessionId)
      continue
    }
    const metaPath = path.join(dir, 'trash-meta.json')
    let meta
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
    } catch {
      meta = undefined
    }
    if (!meta || meta.sessionId !== entry.sessionId) {
      const wrote = await fsp.writeFile(metaPath, JSON.stringify(entry, null, 2), 'utf8').then(() => true).catch(() => false)
      if (wrote) rebuilt.push(entry.sessionId)
    }
    if (!(await exists(path.join(PROJECTION_CACHE, `${entry.sessionId}.json`)))) noProjection.push(entry.sessionId)
  }

  if (leftBehind.length) {
    checks.push(makeCheck('data-left', '数据已搬离 sessions/', 'fail', `这些会话仍能在 sessions/ 下找到，同时也在垃圾桶账本里：${leftBehind.join(', ')}`, '不自动删除：两份副本需要你决定保留哪一份'))
  } else {
    checks.push(makeCheck('data-left', '数据已搬离 sessions/', 'ok', '垃圾桶里的会话在 sessions/ 下都无残留目录'))
  }

  if (missingDirs.length) {
    checks.push(makeCheck('entry-dir', '账本条目有对应目录', 'fail', `账本里有、垃圾桶里找不到目录：${missingDirs.join(', ')}`, '不自动修复：数据可能被手工移动或删除'))
  } else if (entries.length) {
    checks.push(makeCheck('entry-dir', '账本条目有对应目录', 'ok', '每条账本条目都能在垃圾桶里找到目录'))
  }

  if (rebuilt.length) {
    checks.push(makeCheck('meta', 'trash-meta.json', 'fixed', `从账本重建了 ${rebuilt.length} 份元数据：${rebuilt.join(', ')}`, '只补写元数据，不碰会话日志本身'))
  } else if (entries.length) {
    checks.push(makeCheck('meta', 'trash-meta.json', 'ok', '每条条目的元数据都在且 sessionId 一致'))
  }

  /* 4. The bug that started all of this: ids left in the Workspace registry. */
  const registryFixed = []
  const registryStuck = []
  for (const entry of entries) {
    if (!(await workspaceListsSession(entry.sessionId))) continue
    const released = await releaseArchive(ctx, entry.sessionId, entry.workspacePath)
    await dropFromRegistry(entry.sessionId)
    if (released || !(await workspaceListsSession(entry.sessionId))) registryFixed.push(entry.sessionId)
    else registryStuck.push(entry.sessionId)
  }
  if (registryFixed.length) {
    checks.push(makeCheck('registry', '注册表残留', 'fixed', `已从归档集合与工作区成员表摘除 ${registryFixed.length} 条：${registryFixed.join(', ')}`, '摘要：这一步就是幽灵行的成因，修复后侧栏不再渲染'))
  } else if (registryStuck.length) {
    checks.push(makeCheck('registry', '注册表残留', 'fail', `清理失败，仍在注册表里：${registryStuck.join(', ')}`, '需要重启宿主后再试'))
  } else {
    checks.push(makeCheck('registry', '注册表残留', 'ok', '垃圾桶里的会话都不在归档集合或工作区成员表中'))
  }

  if (scanTrash) {
    /* 5. Directories the ledger knows nothing about — never ours to delete. */
    const dirs = await listDirs(state.trashDir)
    const orphans = dirs.filter((name) => !known.has(name) && !PARTIAL_STAGE.test(name))
    if (orphans.length) {
      checks.push(makeCheck('orphan-dir', '垃圾桶内孤立目录', 'warn', `${orphans.length} 个目录不在账本里：${orphans.slice(0, 5).join(', ')}`, '不自动删除：可能是手工放进去的文件，请自行确认'))
    } else {
      checks.push(makeCheck('orphan-dir', '垃圾桶内孤立目录', 'ok', '桶内没有账本之外的目录'))
    }

    /* 6. This plugin's own staging leftovers from an interrupted cross-volume move. */
    const partials = []
    for (const name of dirs) {
      if (!PARTIAL_STAGE.test(name)) continue
      const full = path.join(state.trashDir, name)
      const info = await fsp.stat(full).catch(() => undefined)
      if (!info || Date.now() - info.mtimeMs < PARTIAL_MIN_AGE_MS) continue
      const removed = await fsp.rm(full, { recursive: true, force: true }).then(() => true).catch(() => false)
      if (removed) partials.push(name)
    }
    if (partials.length) {
      checks.push(makeCheck('staging', '跨盘复制残留', 'fixed', `清理了 ${partials.length} 个中断的 .partial-* 暂存目录`, '暂存目录是复制未完成的中间态，不是已入库的数据'))
    } else {
      checks.push(makeCheck('staging', '跨盘复制残留', 'ok', '没有超期未清理的 .partial-* 暂存目录'))
    }
  }

  if (noProjection.length) {
    checks.push(makeCheck('projection', '投影缓存', 'warn', `缺投影缓存（恢复后标题可能丢失）：${noProjection.join(', ')}`, '不自动重建：投影只能由宿主重新折叠产生'))
  } else if (entries.length) {
    checks.push(makeCheck('projection', '投影缓存', 'ok', '每条条目都还有投影缓存，恢复后标题可带回'))
  }

  /* 7. A trashed Session that the Host still holds in memory cannot be repaired
     by moving files: the live object is what the sidebar renders. Report only. */
  const liveEntries = entries.filter((entry) => live(entry.sessionId)).map((entry) => entry.sessionId)
  if (liveEntries.length) {
    checks.push(makeCheck('live-entry', '条目仍活在内存中', 'warn', `这些已移入垃圾桶的会话还活在宿主内存里：${liveEntries.slice(0, 5).join(', ')}`, '不自动处理：内存中的 Session 不归本插件释放，重启桌面端后它不会再出现'))
  } else if (entries.length) {
    checks.push(makeCheck('live-entry', '条目仍活在内存中', 'ok', '垃圾桶里的会话在宿主内存中都已释放'))
  }

  /* 8. The archive set must only name Sessions that still exist somewhere. */
  checks.push(await pruneDeadArchive(ctx, disk))

  return checks
}

/**
 * Split the archived ids into "still on disk", "live in the Host's memory only"
 * and "gone". Only the last group is pruned: an id with no log and no live
 * Session cannot be unarchived by anyone, so leaving it there means the sidebar
 * keeps trying to render a Session whose data does not exist.
 */
async function pruneDeadArchive(ctx, disk) {
  const archived = await readArchivedIds()
  if (!archived.length) return makeCheck('dead-archive', '归档集合死 id', 'ok', '归档集合是空的')
  const live = liveSessionLookup(ctx)
  const dead = []
  const liveOnly = []
  for (const id of archived) {
    if (disk.has(id)) continue
    if (live(id)) {
      liveOnly.push(id)
      continue
    }
    dead.push(id)
  }
  if (!dead.length) {
    if (liveOnly.length) {
      return makeCheck('dead-archive', '归档集合死 id', 'warn', `这些已归档会话没有日志文件，但仍活在宿主内存中：${liveOnly.slice(0, 5).join(', ')}`, '重启桌面端后它们会消失；不自动处理，因为内存中的 Session 不归本插件释放')
    }
    return makeCheck('dead-archive', '归档集合死 id', 'ok', '归档集合里的会话都还有日志文件')
  }
  const registry = workspaceRegistryOf(ctx)
  const pruned = []
  for (const id of dead) {
    let released = false
    try {
      if (registry && typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(id)
        released = true
      }
    } catch {}
    await dropFromRegistry(id)
    if (released || !(await workspaceListsSession(id))) pruned.push(id)
  }
  const detail = `从归档集合摘除 ${pruned.length} 条已不存在的会话：${pruned.slice(0, 5).join(', ')}`
  const fix = '这些 id 的日志与内存对象都不存在了，属于文件级删除时代留下的残留；摘除只影响侧栏归档列表'
  if (liveOnly.length) {
    return makeCheck('dead-archive', '归档集合死 id', 'fixed', `${detail}；另有 ${liveOnly.length} 条无日志但仍在内存中（重启后消失）：${liveOnly.slice(0, 3).join(', ')}`, fix)
  }
  return makeCheck('dead-archive', '归档集合死 id', 'fixed', detail, fix)
}

/** `(id) => boolean`: does the Host still hold this Session in memory? */
function liveSessionLookup(ctx) {
  let sessions
  try {
    sessions = ctx?.get?.('sessions')
  } catch {
    sessions = undefined
  }
  if (!sessions || typeof sessions.get !== 'function') return () => false
  return (id) => {
    try {
      return Boolean(sessions.get(id))
    } catch {
      return false
    }
  }
}

/** Run one inspection round, summarise it, and persist the report. */
async function runSelfCheck(ctx, options = {}) {
  const startedAt = Date.now()
  let checks
  try {
    checks = await inspectAndRepair(ctx)
  } catch (error) {
    checks = [makeCheck('engine', '自检引擎', 'fail', String(error?.message ?? error))]
  }
  const summary = { ok: 0, fixed: 0, warn: 0, fail: 0 }
  for (const check of checks) summary[check.status] = (summary[check.status] ?? 0) + 1
  const report = {
    id: newReportId(),
    at: startedAt,
    finishedAt: Date.now(),
    trigger: options.trigger ?? 'manual',
    round: options.round ?? 0,
    sessionId: options.sessionId ?? '',
    checks,
    summary,
  }
  await writeReport(report).catch(() => {})
  return report
}

async function writeReport(report) {
  await fsp.mkdir(SELFCHECK_DIR, { recursive: true })
  await fsp.writeFile(path.join(SELFCHECK_DIR, `${report.id}.json`), JSON.stringify(report, null, 2), 'utf8')
  const names = (await fsp.readdir(SELFCHECK_DIR)).filter((name) => name.endsWith('.json')).sort()
  const overflow = names.length - SELFCHECK_KEEP
  for (const name of names.slice(0, Math.max(0, overflow))) {
    await fsp.rm(path.join(SELFCHECK_DIR, name), { force: true }).catch(() => {})
  }
}

async function readReports(limit = SELFCHECK_KEEP) {
  let names = []
  try {
    names = await fsp.readdir(SELFCHECK_DIR)
  } catch {
    return []
  }
  const reports = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      reports.push(JSON.parse(await fsp.readFile(path.join(SELFCHECK_DIR, name), 'utf8')))
    } catch {}
  }
  return reports.sort((a, b) => b.at - a.at).slice(0, limit)
}

const checkTimers = new Set()

/** Two delayed rounds after a move: +10s and +20s. */
function scheduleSelfCheck(ctx, sessionId) {
  CHECK_DELAYS_MS.forEach((delay, index) => {
    const timer = setTimeout(() => {
      checkTimers.delete(timer)
      runSelfCheck(ctx, { trigger: 'move', round: index + 1, sessionId }).catch(() => {})
    }, delay)
    timer.unref?.()
    checkTimers.add(timer)
  })
}

/* -------------------------------------------------------------- http bridge */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, _config) {
  const route = async (req, res) => {
    if (req.headers['x-dsh-trash'] !== '1') {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '') || 'state'
    const state = await readState()

    try {
      if (req.method === 'GET' && (action === 'state' || action === '')) {
        const purged = await purgeExpired(state)
        await reconcileRegistry(state)
        sendJson(res, 200, {
          configured: Boolean(state.trashDir),
          trashDir: state.trashDir,
          opacity: state.opacity,
          cardWidth: state.cardWidth,
          entries: state.entries.map(entryView),
          archivedIds: await readArchivedIds(),
          purged,
          now: Date.now(),
        })
        return
      }

      if (req.method === 'GET' && action === 'reports') {
        sendJson(res, 200, { reports: await readReports(), delays: CHECK_DELAYS_MS })
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }

      const body = await readJson(req)

      if (action === 'config') {
        if (typeof body.trashDir === 'string') {
          const next = body.trashDir.trim()
          if (!next) throw new Error('垃圾桶目录不能为空')
          const resolved = path.resolve(next)
          if (resolved === path.parse(resolved).root) throw new Error('不能用磁盘根目录做垃圾桶')
          if (resolved.toLowerCase() === path.resolve(DSH_HOME).toLowerCase()) throw new Error('不能用 DSH 主目录做垃圾桶')
          if (resolved.toLowerCase().startsWith(path.resolve(DSH_HOME).toLowerCase() + path.sep)) {
            throw new Error('垃圾桶必须放在 DSH 主目录之外')
          }
          state.trashDir = resolved
          await fsp.mkdir(resolved, { recursive: true })
        }
        if (typeof body.opacity === 'number') {
          state.opacity = Math.min(100, Math.max(0, Math.round(body.opacity)))
        }
        if (typeof body.cardWidth === 'number') {
          state.cardWidth = Math.min(1200, Math.max(240, Math.round(body.cardWidth)))
        }
        if (typeof body.syncRegistry === 'boolean') state.syncRegistry = body.syncRegistry
        await writeState(state)
        sendJson(res, 200, { ok: true, trashDir: state.trashDir, opacity: state.opacity, cardWidth: state.cardWidth })
        return
      }

      if (action === 'plan') {
        const plan = await planSession(ctx, state, body.sessionId)
        sendJson(res, 200, {
          sessionId: body.sessionId,
          title: plan.title,
          summary: plan.summary,
          products: plan.products,
        })
        return
      }

      if (action === 'move') {
        const result = await moveSession(ctx, state, body.sessionId, {
          removeProducts: body.removeProducts,
        })
        // The two delayed rounds start only once the move really happened.
        scheduleSelfCheck(ctx, body.sessionId)
        sendJson(res, 200, { ok: true, ...result, checkDelays: CHECK_DELAYS_MS })
        return
      }

      if (action === 'selfcheck') {
        const report = await runSelfCheck(ctx, { trigger: 'manual' })
        sendJson(res, 200, { ok: true, report })
        return
      }

      if (action === 'restore') {
        const result = await restoreSession(ctx, state, body.sessionId)
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (action === 'purge') {
        const result = await purgeEntry(state, body.sessionId)
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (action === 'clear') {
        const ids = state.entries.map((entry) => entry.sessionId)
        for (const id of ids) await purgeEntry(state, id)
        sendJson(res, 200, { ok: true, purged: ids })
        return
      }

      sendJson(res, 404, { error: 'unknown-action' })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message ?? error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: route }), 'dsh-trash-can.routes')
}
