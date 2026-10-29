/**
 * Guard test: a blank Session that the Host still holds in memory must not be
 * moved into the trash.
 *
 * That combination is what produced an empty "未分组" row: the files left, the
 * live Session object stayed, and the sidebar had nothing to render but a row.
 * The guard must refuse BEFORE touching the filesystem.
 *
 *   node test/live-guard.mjs
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'

const entryPoint = pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'trash-live-'))
const trashDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trash-live-out-'))
const project = '--live--'
const sessionId = 'session-00000000-0000-4000-8000-000000000001'
const sessionDir = path.join(root, 'sessions', project, sessionId)

const write = async (file, body) => {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, body, 'utf8')
}

// A blank Session: one header line, no events.
await write(
  path.join(sessionDir, 'session.v4.jsonl.zstd'),
  JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd: 'D:\\Fixture', createdAt: Date.now(), isSeeded: false }),
)
await write(
  path.join(root, 'storages', 'dsh-trash-can.json'),
  JSON.stringify({
    version: 1,
    trashDir,
    opacity: 75,
    cardWidth: 360,
    syncRegistry: false,
    requireArchived: true,
    entries: [],
  }),
)
await write(
  path.join(root, 'storages', 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [sessionId], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }),
)

process.env.DSH_HOME = root
const { __internals: H } = await import(entryPoint)

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const state = await H.readState()

// 1. Live + blank: refused, and nothing moved.
const liveCtx = { get: (name) => (name === 'sessions' ? { get: (id) => (id === sessionId ? { id } : undefined) } : undefined) }
let refused = ''
try {
  await H.moveSession(liveCtx, state, sessionId, {})
} catch (error) {
  refused = String(error?.message ?? error)
}
check('refuses a live blank Session', refused.includes('空') && refused.includes('内存'), refused || 'no error')
check('refused before touching files', await fsp.access(sessionDir).then(() => true).catch(() => false))
check('nothing entered the trash ledger', !(await H.readState()).entries.some((entry) => entry.sessionId === sessionId))

// 2. Same blank Session, but the Host no longer holds it: the move is allowed.
const coldCtx = { get: () => undefined }
const moved = await H.moveSession(coldCtx, state, sessionId, {})
check('moves the same Session once it is cold', moved.entry.sessionId === sessionId)
check('source directory left the sessions root', !(await fsp.access(sessionDir).then(() => true).catch(() => false)))
check('trash holds the log', await fsp.access(path.join(trashDir, sessionId, 'session.v4.jsonl.zstd')).then(() => true).catch(() => false))

if (failures.length) {
  console.error(`\nFAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nPASS: live blank Sessions are refused before any file moves')
