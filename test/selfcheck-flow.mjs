/**
 * Host-flow test for the post-delete self-check engine.
 *
 * Runs without a DSH host: it points DSH_HOME at a throwaway tree that contains
 * every failure the engine claims to detect, calls `runSelfCheck` with a stub
 * workspace registry, and asserts both the verdict per check and the files the
 * repairs actually changed.
 *
 *   node test/selfcheck-flow.mjs
 *
 * Exit code 0 = every check matched and every repair landed.
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'

const entryPoint = pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'trash-selfcheck-'))
// The trash dir must live OUTSIDE DSH_HOME — the engine enforces that rule, so a
// fixture that put it inside would only exercise the guard.
const trashDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trash-outside-'))
const project = path.join(root, 'sessions', '--fixture--')

async function write(file, body) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, body, 'utf8')
}

const entry = (id, extra = {}) => ({
  sessionId: id,
  title: `title-${id}`,
  summary: `summary-${id}`,
  workspacePath: 'D:\\Fixture',
  movedAt: Date.now() - 60_000,
  sizeBytes: 10,
  productsDeleted: 0,
  ...extra,
})

// Two entries with healthy trash dirs, one of them also still on disk (conflict),
// one entry whose dir vanished, one whose meta file is missing.
await fsp.mkdir(path.join(trashDir, 'session-dup'), { recursive: true })
await write(path.join(trashDir, 'session-dup', 'trash-meta.json'), JSON.stringify(entry('session-dup')))
await fsp.mkdir(path.join(trashDir, 'session-meta'), { recursive: true })
await fsp.mkdir(path.join(trashDir, 'orphan-dir'), { recursive: true })
const partial = path.join(trashDir, 'session-dup.partial-4242-1700000000000')
await fsp.mkdir(partial, { recursive: true })
const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
await fsp.utimes(partial, old, old)

await fsp.mkdir(path.join(project, 'session-dup'), { recursive: true })
await fsp.mkdir(path.join(project, 'session-ok'), { recursive: true })

await write(
  path.join(root, 'storages', 'dsh-trash-can.json'),
  JSON.stringify({
    version: 1,
    trashDir,
    opacity: 75,
    cardWidth: 360,
    syncRegistry: false,
    requireArchived: true,
    entries: [entry('session-dup'), entry('session-meta'), entry('session-gone')],
  }),
)

await write(
  path.join(root, 'storages', 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['w1'],
      archivedSessionIds: ['session-dup', 'session-meta'],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        w1: {
          path: 'D:\\Fixture',
          title: 'Fixture',
          sessionIds: ['session-dup', 'session-meta', 'session-ok'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }),
)

await write(path.join(root, 'storages', 'session_projcache', 'sessions', 'session-dup.json'), '{"record":{"rows":{}}}')

process.env.DSH_HOME = root
const mod = await import(entryPoint)

const calls = []
const workspaceStub = {
  detachSession: async (id) => {
    calls.push(`detach:${id}`)
  },
  attachSession: async (id) => {
    calls.push(`attach:${id}`)
  },
  sessionIds: [],
}
const registryStub = {
  unarchiveSession: async (id) => {
    calls.push(`unarchive:${id}`)
  },
  resolveByPath: async () => workspaceStub,
}
const ctx = { get: (name) => (name === 'workspaceRegistry' ? registryStub : undefined) }

const report = await mod.__internals.runSelfCheck(ctx, { trigger: 'move', round: 1, sessionId: 'session-dup' })
const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]))

const failures = []
function expect(id, status) {
  const got = byId[id]
  if (!got) return failures.push(`${id}: missing check`)
  if (got.status !== status) failures.push(`${id}: expected ${status}, got ${got.status} (${got.detail})`)
}
expect('trash-dir', 'ok')
expect('expiry', 'ok')
expect('data-left', 'fail')
expect('entry-dir', 'fail')
expect('meta', 'fixed')
expect('registry', 'fixed')
expect('orphan-dir', 'warn')
expect('staging', 'fixed')
expect('projection', 'warn')

// The repairs must actually have landed on disk.
const metaNow = JSON.parse(await fsp.readFile(path.join(trashDir, 'session-meta', 'trash-meta.json'), 'utf8'))
if (metaNow.sessionId !== 'session-meta') failures.push('meta rebuild wrote the wrong sessionId')
if (await fsp.stat(partial).then(() => true).catch(() => false)) failures.push('partial staging dir not removed')
const workspaceNow = JSON.stringify(JSON.parse(await fsp.readFile(path.join(root, 'storages', 'workspace.json'), 'utf8')))
if (workspaceNow.includes('session-dup')) failures.push('workspace.json still lists session-dup')
if (workspaceNow.includes('session-meta')) failures.push('workspace.json still lists session-meta')
if (!calls.includes('detach:session-dup')) failures.push('did not detach through the live registry service')

const reportsDir = path.join(root, 'storages', 'dsh-trash-can-selfcheck')
const saved = await fsp.readdir(reportsDir).catch(() => [])
if (saved.length !== 1) failures.push(`expected 1 persisted report, found ${saved.length}`)

console.log(`fixture: ${root}`)
console.log(`summary: ${JSON.stringify(report.summary)}`)
for (const check of report.checks) console.log(`  ${check.status.padEnd(5)} ${check.id.padEnd(11)} ${check.detail}`)
console.log(`registry calls: ${calls.join(', ') || '(none)'}`)
if (failures.length) {
  console.error('\nFAILED:')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('\nPASS: every check matched and every repair landed')
