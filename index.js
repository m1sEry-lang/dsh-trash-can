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
  return { located, text, title, summary, products }
}

async function moveSession(ctx, state, sessionId, options = {}) {
  if (!state.trashDir) throw new Error('还没有设置垃圾桶目录')
  if (state.entries.some((entry) => entry.sessionId === sessionId)) throw new Error('这个会话已经在垃圾桶里了')
  const plan = await planSession(ctx, state, sessionId)
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
    workspacePath: decodeProjectPath(plan.located.project),
    projectDir: plan.located.project,
    movedAt: Date.now(),
    sizeBytes: totals.bytes,
    productsDeleted,
  }
  await fsp.writeFile(path.join(trashDir, sessionId, 'trash-meta.json'), JSON.stringify(meta, null, 2), 'utf8')

  state.entries = state.entries.filter((entry) => entry.sessionId !== sessionId)
  state.entries.push(meta)
  await writeState(state)

  await dropProjection(sessionId)
  if (state.syncRegistry) await dropFromRegistry(sessionId)
  const attachments = await gcAttachments(extractAttachmentIds(plan.text), plan.text).catch(() => [])
  return { entry: entryView(meta), attachmentsRemoved: attachments.length }
}

async function restoreSession(state, sessionId) {
  const entry = state.entries.find((item) => item.sessionId === sessionId)
  if (!entry) throw new Error('垃圾桶里没有这个会话')
  const source = path.join(state.trashDir, sessionId)
  const projectDir = entry.projectDir || '--restored--'
  const target = path.join(SESSIONS_ROOT, projectDir, sessionId)
  await moveDir(source, target)
  state.entries = state.entries.filter((item) => item.sessionId !== sessionId)
  await writeState(state)
  return { sessionId, projectDir }
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
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      if (action === 'restore') {
        const result = await restoreSession(state, body.sessionId)
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
