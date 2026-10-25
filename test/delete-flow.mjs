/**
 * Clicks through the delete flow without a browser: renders the real slot
 * components, invokes their real onClick handlers, and asserts the dialog
 * chain and the HTTP calls they produce.
 */
import { readFileSync } from 'node:fs'

let hookCursor = 0
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

/** Resolve every function component into a flat list of host nodes. */
function collect(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  if (typeof node.type === 'function') {
    const saved = currentHooks
    const savedCursor = hookCursor
    currentHooks = []
    hookCursor = 0
    let rendered
    try {
      rendered = node.type(node.props ?? {})
    } finally {
      currentHooks = saved
      hookCursor = savedCursor
    }
    return collect(rendered, out)
  }
  out.push(node)
  return collect(node.props?.children, out)
}

function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return ''
  return textOf(node.props?.children)
}

function findButton(nodes, label) {
  return nodes.find((n) => n.type === 'button' && textOf(n).includes(label))
}

/* --------------------------------------------------------- browser stubs */

const registrations = []
const calls = []
let factoryExports

globalThis.document = {
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
  documentElement: { style: { setProperty: () => {} } },
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

const productPath = 'E:\\DSH工作区\\built-thing.js'
globalThis.fetch = async (url, init) => {
  const action = url.split('/').pop()
  calls.push({ action, body: init?.body ? JSON.parse(init.body) : undefined })
  const bodies = {
    plan: { sessionId: 'session-a', title: '演示会话', summary: '垃圾桶 · 插件', products: [{ path: productPath, bytes: 10 }] },
    move: { ok: true },
    state: { configured: true, trashDir: 'E:\\DSH工作区\\垃圾桶', opacity: 75, cardWidth: 360, entries: [], archivedIds: [] },
  }
  return { ok: true, status: 200, json: async () => bodies[action] ?? { ok: true } }
}

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'fetch', 'console', source)(globalThis.window, globalThis.document, globalThis.fetch, console)

factoryExports.apply({
  sessions: { refresh: async () => {} },
  uiWorkspace: { startSession: () => {} },
  slots: {
    inject: (_name, install) => install(),
    register: (options, Component) => {
      registrations.push({ options, Component })
      return () => {}
    },
  },
})

const byId = (id) => registrations.find((r) => r.options.id === id)
const snap = () => factoryExports.__test.snapshot()
let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function click(component, props, label) {
  const nodes = collect({ type: component, props })
  const button = findButton(nodes, label)
  if (!button) throw new Error(`button not found: ${label}`)
  await button.props.onClick({ preventDefault() {}, stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, right: 120, bottom: 30 }) } })
}

/* ------------------------------------------------------------------ run */

factoryExports.__test.set({ loaded: true, configured: true, archivedIds: ['session-a'], entries: [] })

const menu = byId('dsh-trash-can.delete')
const menuProps = { sessionId: 'session-a', displayTitle: '演示会话', useMenuOpenState: () => [true, () => {}] }
const menuNodes = collect({ type: menu.Component, props: menuProps })
const deleteEntry = menuNodes.find((n) => n.type === 'button' && textOf(n).includes('确认删除'))
check('menu: red entry renders for an archived Session', Boolean(deleteEntry), deleteEntry ? 'present' : 'missing')
check('menu: entry is styled as danger', deleteEntry?.props?.['data-danger'] === 'true')

await deleteEntry.props.onClick({ preventDefault() {}, stopPropagation() {} })
check('flow: plan requested', calls.some((c) => c.action === 'plan'))
check('flow: product dialog opened', snap().dialog?.kind === 'products', snap().dialog?.kind)

const host = byId('dsh-trash-can.dialogs')
let nodes = collect({ type: host.Component, props: {} })
check('dialog: product paths listed', nodes.some((n) => textOf(n).includes(productPath)))

await click(host.Component, {}, '否')
check('flow: declining files asks about the conversation', snap().dialog?.kind === 'keepAsk', snap().dialog?.kind)

await click(host.Component, {}, '是')
const move = calls.find((c) => c.action === 'move')
check('flow: conversation moved without deleting files', Boolean(move) && Array.isArray(move.body.removeProducts) && move.body.removeProducts.length === 0)

// Second pass: accept deleting the produced files.
calls.length = 0
factoryExports.__test.set({ dialog: null, archivedIds: ['session-a'] })
await deleteEntry.props.onClick({ preventDefault() {}, stopPropagation() {} })
await click(host.Component, {}, '是')
const moveWithFiles = calls.find((c) => c.action === 'move')
check(
  'flow: accepting files moves them with the conversation',
  Boolean(moveWithFiles) && moveWithFiles.body.removeProducts?.length === 1 && moveWithFiles.body.removeProducts[0] === productPath,
  JSON.stringify(moveWithFiles?.body?.removeProducts ?? []),
)

process.exit(failures ? 1 : 0)
