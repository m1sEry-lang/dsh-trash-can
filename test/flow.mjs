/**
 * End-to-end Host flow without a booted profile: build a throwaway Session,
 * move it into the trash, restore it, move again and purge it. Uses portable
 * temp paths and a stub Workspace registry so it runs on any machine.
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { __internals as H } from '../index.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const sessions = path.join(DSH_HOME, 'sessions')
const projectionCache = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

const sessionId = 'session-11111111-1111-4111-8111-111111111111'
const project = '--flowtest--'
const sessionDir = path.join(sessions, project, sessionId)
const scratch = path.join(os.tmpdir(), 'flowtest-' + process.pid)
const product = path.join(scratch, 'flowtest-product.txt')

let failures = 0
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

await fsp.mkdir(sessionDir, { recursive: true })
await fsp.writeFile(
  path.join(sessionDir, 'session.v4.jsonl.zstd'),
  [
    '{"type":"session","version":4,"id":"' + sessionId + '"}',
    JSON.stringify({
      type: 'user/message',
      seq: 1,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我测试垃圾桶的流程' }] },
    }),
    JSON.stringify({
      type: 'tool/call',
      seq: 2,
      data: { name: 'write', arguments: JSON.stringify({ file_path: product }) },
    }),
  ].join('\n'),
  'utf8',
)
await fsp.mkdir(scratch, { recursive: true })
await fsp.writeFile(product, 'flow test', 'utf8')
await fsp.mkdir(projectionCache, { recursive: true })
await fsp.writeFile(
  path.join(projectionCache, `${sessionId}.json`),
  JSON.stringify({ version: 7, record: { rows: { title: { ver: 1, seq: 2, val: '流程自测会话' } } } }),
  'utf8',
)

const state = await H.readState()
const savedTrashDir = state.trashDir
state.trashDir = path.join(scratch, 'trash')

try {
  // 0.2.0 resolves services through ctx.get(); the stub mirrors that shape so the
  // move path really unarchives + detaches instead of silently writing files.
  const releases = []
  const detaches = []
  const registrations = []
  const workspaceStub = {
    path: 'D:\\Fixture',
    sessionIds: [],
    detachSession: async (id) => {
      detaches.push(id)
      workspaceStub.sessionIds = workspaceStub.sessionIds.filter((value) => value !== id)
    },
    attachSession: async (id) => {
      registrations.push(id)
      if (!workspaceStub.sessionIds.includes(id)) workspaceStub.sessionIds = [id, ...workspaceStub.sessionIds]
    },
  }
  const registryStub = {
    unarchiveSession: async (id) => {
      releases.push(id)
    },
    resolveByPath: async () => workspaceStub,
    list: () => [workspaceStub],
  }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registryStub : undefined) }

  const plan = await H.planSession(null, state, sessionId)
  check('plan.title', plan.title === '流程自测会话', plan.title)
  check('plan.summary non-empty', plan.summary.length > 0, plan.summary)
  check('plan.products finds the file', plan.products.some((p) => p.path === product), `${plan.products.length} found`)

  // The safety gate: a Session that is not in the archived set must be refused.
  state.requireArchived = true
  let refused = ''
  try {
    await H.moveSession(ctx, state, sessionId, {})
  } catch (error) {
    refused = String(error?.message ?? error)
  }
  check('guard: non-archived Session refused', refused.includes('已归档'), refused || 'no error')
  check('guard: nothing moved', await fsp.access(sessionDir).then(() => true).catch(() => false))
  state.requireArchived = false

  const moved = await H.moveSession(ctx, state, sessionId, { removeProducts: [] })
  check('move: entry recorded', moved.entry.sessionId === sessionId)
  check('move: unarchived through the live service', releases.includes(sessionId), releases.join(','))
  check('move: detached from the workspace membership', detaches.includes(sessionId), detaches.join(','))
  check('move: source gone', !(await fsp.access(sessionDir).then(() => true).catch(() => false)))
  check('move: trash copy exists', await fsp.access(path.join(state.trashDir, sessionId, 'trash-meta.json')).then(() => true).catch(() => false))
  check('move: product kept when not requested', await fsp.access(product).then(() => true).catch(() => false))
  check('move: projection kept for the title', await fsp.access(path.join(projectionCache, `${sessionId}.json`)).then(() => true).catch(() => false))

  workspaceStub.sessionIds = []
  const restored = await H.restoreSession(ctx, state, sessionId)
  check('restore: back in sessions root', await fsp.access(sessionDir).then(() => true).catch(() => false), restored.projectDir)
  check('restore: entry removed', !state.entries.some((e) => e.sessionId === sessionId))
  check('restore: re-registered in the workspace', registrations.includes(sessionId), registrations.join(','))
  check('restore: title annotated when the workspace is gone', restored.title.includes('（'), restored.title)
  const cachedTitle = JSON.parse(await fsp.readFile(path.join(projectionCache, `${sessionId}.json`), 'utf8'))?.record?.rows?.title?.val
  check('restore: cached title updated', cachedTitle === restored.title, cachedTitle)

  await H.moveSession(ctx, state, sessionId, { removeProducts: [product] })
  check('move again: product deleted when requested', !(await fsp.access(product).then(() => true).catch(() => false)))

  // Age the entry past 15 days and let the scan purge it.
  const entry = state.entries.find((e) => e.sessionId === sessionId)
  entry.movedAt = Date.now() - H.TTL_MS - 1000
  await H.writeState(state)
  const purgedIds = await H.purgeExpired(state)
  check('expiry: 360h entry purged by scan', purgedIds.includes(sessionId), purgedIds.join(','))
  check('expiry: entry removed', !state.entries.some((e) => e.sessionId === sessionId))
  check('expiry: trash dir gone', !(await fsp.access(path.join(state.trashDir, sessionId)).then((status) => true).catch(() => false)))
} finally {
  state.trashDir = savedTrashDir
  state.entries = state.entries.filter((e) => e.sessionId !== sessionId)
  await H.writeState(state)
  await fsp.rm(sessionDir, { recursive: true, force: true })
  await fsp.rm(path.join(sessions, project), { recursive: true, force: true })
  await fsp.rm(path.join(scratch, 'trash', sessionId), { recursive: true, force: true }).catch(() => {})
  await fsp.rm(product, { force: true })
  await fsp.rm(path.join(projectionCache, `${sessionId}.json`), { force: true })
  console.log('cleaned')
}

process.exit(failures ? 1 : 0)
