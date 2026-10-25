/**
 * Menu dismissal: a press outside closes, a press inside keeps it, and a press
 * on the menu's own trigger is ignored so the trigger can toggle.
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
  useEffect(fn) {
    hookCursor++
    currentEffects.push(fn)
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

let currentEffects = []

function collect(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  if (typeof node.type === 'function') {
    const savedHooks = currentHooks
    const savedCursor = hookCursor
    const savedEffects = currentEffects
    currentHooks = []
    currentEffects = []
    hookCursor = 0
    let rendered
    try {
      rendered = node.type(node.props ?? {})
    } finally {
      const effects = currentEffects
      currentHooks = savedHooks
      hookCursor = savedCursor
      currentEffects = savedEffects
      for (const effect of effects) effect()
    }
    return collect(rendered, out)
  }
  const element = { type: node.type, props: node.props, contains: (target) => target === node }
  if (typeof node.props?.ref === 'function') node.props.ref(element)
  out.push(element)
  return collect(node.props?.children, out)
}

const registrations = []
const listeners = { mousedown: [], keydown: [] }
let factoryExports

globalThis.document = {
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
  documentElement: { style: { setProperty: () => {} } },
  addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  removeEventListener: (type, fn) => {
    listeners[type] = (listeners[type] ?? []).filter((item) => item !== fn)
  },
  dispatch: (type, event) => {
    for (const fn of [...(listeners[type] ?? [])]) fn(event)
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ entries: [], archivedIds: [] }) })

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

const entryComponent = registrations.find((r) => r.options.id === 'dsh-trash-can.entry').Component
const entry = {
  sessionId: 'session-a',
  title: '演示会话',
  summary: '垃圾桶 · 菜单',
  workspacePath: 'E:\\DSH工作区',
  movedAt: Date.now(),
  msLeft: 300 * 3600_000,
  daysLeft: 13,
  hoursLeft: 300,
}
let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const snap = () => factoryExports.__test.snapshot()

function renderEntry() {
  return collect({ type: entryComponent, props: { wide: true } })
}

/* -------------------------------------------------- row menu (per session) */

factoryExports.__test.set({
  loaded: true,
  configured: true,
  open: true,
  entries: [entry],
  menuFor: 'session-a',
  menuAt: { x: 100, y: 100 },
})
let nodes = renderEntry()
const rowMenu = nodes.find((n) => n.props?.className === 'dsh-trash-menu')
check('row menu rendered', Boolean(rowMenu))

document.dispatch('mousedown', { target: { closest: (sel) => (String(sel).includes('row') ? {} : null) } })
check('row menu: press on its trigger keeps it open', snap().menuFor === 'session-a', snap().menuFor)

document.dispatch('mousedown', { target: { closest: () => null } })
check('row menu: press elsewhere closes it', snap().menuFor === '', snap().menuFor)

/* ------------------------------------------------------- panel menu (trash) */

factoryExports.__test.set({
  open: true,
  entries: [entry],
  menuFor: '',
  panelMenu: true,
  panelMenuAt: { x: 100, y: 100 },
})
nodes = renderEntry()
const panelMenu = nodes.find((n) => n.props?.className === 'dsh-trash-panel-menu')
check('panel menu rendered', Boolean(panelMenu))

document.dispatch('mousedown', { target: { closest: (sel) => (String(sel).includes('panel') ? {} : null) } })
check('panel menu: press on its trigger keeps it open', snap().panelMenu === true)

document.dispatch('mousedown', { target: { closest: () => null } })
check('panel menu: press elsewhere closes it', snap().panelMenu === false)

/* -------------------------------------------------------------- escape key */

factoryExports.__test.set({ panelMenu: true, panelMenuAt: { x: 10, y: 10 } })
renderEntry()
document.dispatch('keydown', { key: 'Escape' })
check('panel menu: Escape closes it', snap().panelMenu === false)

process.exit(failures ? 1 : 0)
