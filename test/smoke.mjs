/**
 * Headless smoke test for client.js.
 *
 * The browser supplies React from its module table; this test supplies a tiny
 * hook-capable stand-in so the factory, `apply`, and every registered slot
 * component can be executed without a real React install. It catches
 * registration and first-render crashes before the page ever loads the bundle.
 */
import { readFileSync } from 'node:fs'

/* ------------------------------------------------------------ mini react */

let hookCursor = 0
let hookStore = []
let currentHooks = []

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useRef(value) {
    const index = hookCursor++
    if (!(index in currentHooks)) currentHooks[index] = { current: value }
    return currentHooks[index]
  },
  useState(initial) {
    const index = hookCursor++
    if (!(index in currentHooks)) currentHooks[index] = [typeof initial === 'function' ? initial() : initial, () => {}]
    return currentHooks[index]
  },
  useEffect() {
    hookCursor++
  },
  useMemo(factory) {
    hookCursor++
    return factory()
  },
  useCallback(fn) {
    hookCursor++
    return fn
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    hookCursor++
    return getSnapshot()
  },
}

function renderNode(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node.type === 'function') {
    const Component = node.type
    const parent = currentHooks
    currentHooks = []
    const savedCursor = hookCursor
    hookCursor = 0
    let output
    try {
      output = Component(node.props ?? {})
    } finally {
      currentHooks = parent
      hookCursor = savedCursor
    }
    return renderNode(output)
  }
  return renderNode(node.props?.children)
}

/* --------------------------------------------------------- browser stubs */

const registrations = []
let factoryExports
const styleSink = []

const documentListeners = { mousedown: [], keydown: [] }

globalThis.document = {
  head: { appendChild: (node) => styleSink.push(node) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
  documentElement: { style: { setProperty: () => {} } },
  addEventListener: (type, fn) => (documentListeners[type] ??= []).push(fn),
  removeEventListener: (type, fn) => {
    documentListeners[type] = (documentListeners[type] ?? []).filter((item) => item !== fn)
  },
  dispatch: (type, event) => {
    for (const fn of [...(documentListeners[type] ?? [])]) fn(event)
  },
}
globalThis.window = {
  innerWidth: 1500,
  innerHeight: 900,
  __ModuleLoader__: {
    load: (entry) => {
      factoryExports = entry.factory((specifier) => {
        if (specifier === 'react') return React
        throw new Error(`unexpected require: ${specifier}`)
      })
    },
  },
}

const entry = {
  sessionId: 'session-a',
  title: '图片识别能力询问',
  summary: '图片 识别 垃圾桶 插件',
  workspacePath: 'E:\\DSH工作区',
  movedAt: Date.now() - 3600_000,
  msLeft: 300 * 3600_000,
  daysLeft: 13,
  hoursLeft: 300,
}

globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () =>
    url.endsWith('/state')
      ? {
          configured: true,
          trashDir: 'E:\\DSH工作区\\垃圾桶',
          opacity: 75,
          cardWidth: 360,
          archivedIds: ['session-a'],
          entries: [entry],
        }
      : { ok: true, products: [] },
})

/* ------------------------------------------------------------------ run */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'fetch', 'console', source)(
  globalThis.window,
  globalThis.document,
  globalThis.fetch,
  console,
)

if (!factoryExports) throw new Error('factory did not run')
console.log('exports:', Object.keys(factoryExports).join(', '))

const uiCalls = []
const ctx = {
  sessions: { refresh: async () => {} },
  uiWorkspace: {
    startSession: (workspaceId, options) => {
      uiCalls.push({ workspaceId, options })
    },
  },
  slots: {
    inject(_name, install) {
      install()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
}

factoryExports.apply(ctx)
console.log('slots:', registrations.map((r) => `${r.options.name}#${r.options.id}@${r.options.order}`).join('\n        '))

let failures = 0
for (const { options, Component } of registrations) {
  try {
    const html = renderNode({ type: Component, props: { wide: true, sessionId: 'session-a', displayTitle: '图片识别能力询问' } })
    const label = html.length ? `OK   ${html.length} bytes` : 'OK   empty (dialog host)'
    console.log(`${label}  ${options.id}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${options.id}: ${error?.stack ?? error}`)
  }
}

console.log('styles:', styleSink.length)

// "修改配置 → 让智能体帮我改" must hand the request to the workspace service.
factoryExports.__test.openAssistantDraft()
const draft = uiCalls[0]?.options?.prompt ?? ''
console.log('draft session call:', uiCalls.length, '| prompt:', draft.slice(0, 36))
if (!uiCalls.length || !draft.includes('改动')) {
  console.log('FAIL  draft session was not opened')
  failures += 1
} else {
  console.log('OK    draft session opened with the config request')
}

process.exit(failures ? 1 : 0)
