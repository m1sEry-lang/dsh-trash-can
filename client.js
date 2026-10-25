/**
 * dsh-trash-can — browser half.
 *
 * Registers the fixed trash row above the account block
 * (`sidebar.footer.action`) and the red "Delete session" entry in the Session
 * row menu (`sidebar.workspaces.session.menu.item`). All file work happens on
 * the Host through /api/dsh-trash.
 */
window.__ModuleLoader__.load({
  id: 'dsh-trash-can',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const inject = ['slots', 'sessions']

    const ROUTE = '/api/dsh-trash'
    const CSS_ID = 'dsh-trash-can-style'
    const THEME = {
      red: '#ff5c5c',
      dim: 'rgba(255,255,255,0.55)',
    }

    /* ------------------------------------------------------------- store */

    const listeners = new Set()
    let snapshot = {
      loaded: false,
      loading: false,
      configured: false,
      trashDir: '',
      opacity: 75,
      cardWidth: 360,
      entries: [],
      archivedIds: [],
      error: '',
      notice: '',
      open: false,
      dialog: null,
      menuFor: '',
      detailFor: '',
      panelMenu: false,
    }

    function set(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function useStore() {
      return React.useSyncExternalStore(
        subscribe,
        () => snapshot,
        () => snapshot,
      )
    }

    async function api(action, body) {
      const response = await fetch(`${ROUTE}/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-dsh-trash': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function applyOpacity(percent) {
      if (typeof document === 'undefined') return
      const alpha = Math.min(1, Math.max(0, Number(percent) / 100))
      document.documentElement.style.setProperty('--dsh-trash-bg', `rgba(20,20,22,${alpha.toFixed(3)})`)
    }

    let listRefresher = async () => {}

    function notice(text) {
      set({ notice: text })
      if (notice.timer) clearTimeout(notice.timer)
      notice.timer = setTimeout(() => set({ notice: '' }), 5000)
    }

    async function refresh() {
      set({ loading: true })
      try {
        const state = await api('state')
        set({
          loaded: true,
          loading: false,
          configured: state.configured,
          trashDir: state.trashDir,
          opacity: state.opacity,
          cardWidth: state.cardWidth,
          entries: state.entries ?? [],
          archivedIds: state.archivedIds ?? [],
          error: '',
        })
        if (!state.configured) set({ dialog: { kind: 'setup', value: state.trashDir || '' } })
        applyOpacity(state.opacity)
        // Moving a Session log in or out of place does not emit a Host event, so
        // ask the Session model to re-read the Host-authoritative list.
        await listRefresher()
      } catch (error) {
        set({ loaded: true, loading: false, error: String(error?.message ?? error) })
      }
    }

    /* ------------------------------------------------------------- styles */

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-dsh-trash="${CSS_ID}"]`)) return
      const style = document.createElement('style')
      style.dataset.dshTrash = CSS_ID
      style.textContent = `
        .dsh-trash-root { display: flex; flex-direction: column; width: 100%; }
        .dsh-trash-entry {
          display: flex; align-items: center; gap: 8px;
          width: 100%; padding: 8px 10px; margin: 0 0 2px;
          border: 0; border-radius: 10px; background: transparent;
          color: inherit; font: inherit; cursor: pointer; text-align: left;
        }
        .dsh-trash-entry:hover { background: rgba(127,127,127,0.16); }
        .dsh-trash-entry[data-open="true"] { background: rgba(127,127,127,0.16); }
        .dsh-trash-badge {
          margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px;
          border-radius: 9px; background: rgba(127,127,127,0.28);
          font-size: 11px; line-height: 18px; text-align: center; color: inherit;
        }
        .dsh-trash-drawer {
          display: flex; flex-direction: column; max-height: 46vh; overflow-y: auto;
          border-radius: 12px; margin-bottom: 4px;
          border: 1px solid rgba(127,127,127,0.22);
          background: var(--dsh-trash-bg, rgba(24,24,26,0.75));
          backdrop-filter: blur(12px);
        }
        .dsh-trash-cake { height: 10px; margin: 4px 8px 0; position: relative; cursor: pointer; }
        .dsh-trash-cake::before, .dsh-trash-cake::after {
          content: ""; position: absolute; left: 0; right: 0; height: 3px; border-radius: 3px;
          background: rgba(127,127,127,0.30);
        }
        .dsh-trash-cake::before { top: 0; transform: scaleX(0.72); }
        .dsh-trash-cake::after { top: 4px; transform: scaleX(0.86); }
        .dsh-trash-row {
          display: flex; align-items: center; gap: 8px; padding: 7px 10px;
          border-radius: 8px; cursor: default; font-size: 12.5px;
        }
        .dsh-trash-row:hover, .dsh-trash-row[data-hover="true"] { background: rgba(127,127,127,0.14); }
        .dsh-trash-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-trash-row-left { margin-left: auto; flex: none; opacity: 0.66; font-size: 11.5px; }
        .dsh-trash-more {
          flex: none; border: 0; background: transparent; color: inherit; opacity: 0.6;
          cursor: pointer; border-radius: 6px; padding: 0 4px; font-size: 14px; line-height: 16px;
        }
        .dsh-trash-more:hover { opacity: 1; background: rgba(127,127,127,0.2); }
        .dsh-trash-empty { padding: 12px 10px; font-size: 12px; opacity: 0.6; text-align: center; }
        .dsh-trash-notice {
          margin: 6px 8px 0; padding: 6px 8px; border-radius: 8px; font-size: 11.5px;
          background: rgba(127,127,127,0.16); opacity: 0.85;
        }
        .dsh-trash-menu, .dsh-trash-panel-menu {
          position: fixed; z-index: 2147483000; min-width: 132px; padding: 4px;
          border-radius: 10px; border: 1px solid rgba(127,127,127,0.25);
          background: var(--dsh-trash-bg, rgba(28,28,30,0.92)); backdrop-filter: blur(14px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        }
        .dsh-trash-menu-item {
          display: block; width: 100%; padding: 6px 9px; border: 0; border-radius: 7px;
          background: transparent; color: inherit; font: inherit; font-size: 12.5px;
          text-align: left; cursor: pointer;
        }
        .dsh-trash-menu-item:hover { background: rgba(127,127,127,0.2); }
        .dsh-trash-menu-item[data-danger="true"] { color: ${THEME.red}; }
        .dsh-trash-card {
          position: fixed; z-index: 2147482000; box-sizing: border-box;
          height: 150px; max-height: 150px; overflow: hidden;
          padding: 9px 11px; border-radius: 12px;
          border: 1px solid rgba(127,127,127,0.26);
          background: var(--dsh-trash-bg, rgba(26,26,28,0.8)); backdrop-filter: blur(14px);
          box-shadow: 0 12px 34px rgba(0,0,0,0.36);
          font-size: 12px; line-height: 1.45;
        }
        .dsh-trash-card-title { font-size: 12.5px; font-weight: 600; margin-bottom: 2px; }
        .dsh-trash-card-summary { opacity: 0.82; margin-bottom: 6px; }
        .dsh-trash-card-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; opacity: 0.66; font-size: 11.5px; }
        .dsh-trash-mask {
          position: fixed; inset: 0; z-index: 2147483200; display: flex;
          align-items: center; justify-content: center; background: rgba(0,0,0,0.45);
        }
        .dsh-trash-dialog {
          width: min(520px, 92vw); max-height: 82vh; overflow: auto; box-sizing: border-box;
          padding: 18px 20px; border-radius: 14px; border: 1px solid rgba(127,127,127,0.28);
          background: rgba(30,30,32,0.96); color: inherit; backdrop-filter: blur(16px);
          box-shadow: 0 24px 60px rgba(0,0,0,0.5); font-size: 13px; line-height: 1.6;
        }
        .dsh-trash-dialog h3 { margin: 0 0 10px; font-size: 14.5px; }
        .dsh-trash-dialog p { margin: 0 0 12px; opacity: 0.8; }
        .dsh-trash-paths {
          max-height: 180px; overflow: auto; margin: 0 0 12px; padding: 8px 10px;
          border-radius: 8px; background: rgba(127,127,127,0.12);
          font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; white-space: pre-wrap;
        }
        .dsh-trash-input {
          width: 100%; box-sizing: border-box; padding: 8px 10px; margin: 0 0 12px;
          border-radius: 8px; border: 1px solid rgba(127,127,127,0.35);
          background: rgba(0,0,0,0.25); color: inherit; font: inherit;
        }
        .dsh-trash-actions { display: flex; justify-content: flex-end; gap: 8px; }
        .dsh-trash-btn {
          padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.32);
          background: transparent; color: inherit; font: inherit; cursor: pointer;
        }
        .dsh-trash-btn[data-primary="true"] { background: rgba(127,127,127,0.26); }
        .dsh-trash-btn[data-danger="true"] { background: rgba(255,92,92,0.18); border-color: rgba(255,92,92,0.5); color: ${THEME.red}; }
        .dsh-trash-slider { width: 100%; margin: 0 0 6px; }
        .dsh-trash-note { font-size: 11.5px; opacity: 0.6; }
      `
      document.head.appendChild(style)
    }

    /* --------------------------------------------------------- components */

    function TrashEntry({ wide }) {
      const state = useStore()
      React.useEffect(() => {
        injectStyles()
        refresh()
      }, [])
      const count = state.entries.length
      const open = state.open
      return h(
        'div',
        { className: 'dsh-trash-root' },
        open ? h(Drawer, { wide }) : null,
        h(
          'button',
          {
            className: 'dsh-trash-entry',
            type: 'button',
            title: state.configured ? '垃圾桶' : '垃圾桶（尚未设置位置）',
            'data-open': open ? 'true' : 'false',
            onClick: async () => {
              if (!state.configured) {
                set({ dialog: { kind: 'setup', value: state.trashDir || '' } })
                return
              }
              set({ open: !state.open })
              if (!state.open) refresh()
            },
            onContextMenu: (event) => {
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              set({ panelMenu: true, panelMenuAt: { x: rect.right + 6, y: rect.bottom - 8 } })
            },
          },
          h('span', { 'aria-hidden': 'true' }, '🗑'),
          wide ? h('span', null, '垃圾桶') : null,
          count > 0 ? h('span', { className: 'dsh-trash-badge' }, String(count)) : null,
          open
            ? h(
                'span',
                {
                  className: 'dsh-trash-more',
                  role: 'button',
                  title: '垃圾桶菜单',
                  onClick: (event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    set({ panelMenu: true, panelMenuAt: { x: rect.right + 8, y: rect.top - 4 } })
                  },
                },
                '⋯',
              )
            : null,
        ),
        state.panelMenu ? h(PanelMenu) : null,
      )
    }

    function PanelMenu() {
      const state = useStore()
      const at = state.panelMenuAt || { x: 200, y: 200 }
      const close = () => set({ panelMenu: false })
      return h(
        'div',
        { className: 'dsh-trash-panel-menu', style: { left: at.x, top: at.y } },
        h(
          'button',
          {
            className: 'dsh-trash-menu-item',
            onClick: async () => {
              if (!state.entries.length) return close()
              set({ panelMenu: false, dialog: { kind: 'clear', count: state.entries.length } })
            },
          },
          '清空垃圾桶',
        ),
        h(
          'button',
          {
            className: 'dsh-trash-menu-item',
            onClick: () => set({ panelMenu: false, dialog: { kind: 'opacity', value: state.opacity } }),
          },
          '背景透明度',
        ),
        h(
          'button',
          {
            className: 'dsh-trash-menu-item',
            onClick: () => set({ panelMenu: false, dialog: { kind: 'configure' } }),
          },
          '修改配置',
        ),
      )
    }

    function Drawer({ wide }) {
      const state = useStore()
      const [hovered, setHovered] = React.useState('')
      const timer = React.useRef(null)
      const cards = React.useRef(new Map())

      React.useEffect(
        () => () => {
          if (timer.current) clearTimeout(timer.current)
        },
        [],
      )

      const schedule = (sessionId) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => set({ detailFor: sessionId }), 1000)
      }
      const cancel = () => {
        if (timer.current) clearTimeout(timer.current)
        set({ detailFor: '' })
      }

      return h(
        'div',
        { className: 'dsh-trash-drawer' },
        h('div', {
          className: 'dsh-trash-cake',
          title: '收起垃圾桶',
          onClick: () => set({ open: false, detailFor: '', menuFor: '' }),
        }),
        state.notice ? h('div', { className: 'dsh-trash-notice' }, state.notice) : null,
        state.entries.length === 0
          ? h('div', { className: 'dsh-trash-empty' }, '垃圾桶是空的')
          : state.entries.map((entry) =>
              h(
                'div',
                {
                  key: entry.sessionId,
                  className: 'dsh-trash-row',
                  'data-hover': hovered === entry.sessionId ? 'true' : 'false',
                  ref: (node) => {
                    if (node) cards.current.set(entry.sessionId, node)
                  },
                  onMouseEnter: (event) => {
                    setHovered(entry.sessionId)
                    schedule(entry.sessionId)
                    cards.current.set(entry.sessionId, event.currentTarget)
                  },
                  onMouseLeave: () => {
                    setHovered('')
                    cancel()
                  },
                },
                h('span', { className: 'dsh-trash-row-title' }, entry.title || entry.sessionId),
                h('span', { className: 'dsh-trash-row-left' }, leftLabel(entry)),
                h(
                  'button',
                  {
                    className: 'dsh-trash-more',
                    title: '更多',
                    onClick: (event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      set({
                        detailFor: '',
                        menuFor: entry.sessionId,
                        menuAt: { x: Math.min(rect.left, window.innerWidth - 150), y: rect.bottom + 4 },
                      })
                    },
                  },
                  '⋯',
                ),
              ),
            ),
        state.detailFor ? h(DetailCard, { row: cards.current.get(state.detailFor) }) : null,
        state.menuFor ? h(RowMenu) : null,
      )
    }

    function leftLabel(entry) {
      if (entry.msLeft <= 0) return '即将清理'
      if (entry.daysLeft >= 1) return `剩 ${entry.daysLeft} 天`
      return `剩 ${entry.hoursLeft} 小时`
    }

    function formatTime(value) {
      try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false })
      } catch {
        return String(value)
      }
    }

    function DetailCard({ row }) {
      const state = useStore()
      const entry = state.entries.find((item) => item.sessionId === state.detailFor)
      if (!entry) return null
      const rect = row?.getBoundingClientRect?.()
      const left = 248
      const width = Math.max(240, Math.min(state.cardWidth || 360, (typeof window !== 'undefined' ? window.innerWidth : 1200) - left - 24))
      const top = rect ? Math.max(72, Math.min(rect.top - 150 + rect.height, (typeof window !== 'undefined' ? window.innerHeight : 800) - 160)) : 120
      return h(
        'div',
        { className: 'dsh-trash-card', style: { left, top, width } },
        h('div', { className: 'dsh-trash-card-title' }, entry.title || entry.sessionId),
        h('div', { className: 'dsh-trash-card-summary' }, entry.summary || '（无内容总结）'),
        h(
          'div',
          { className: 'dsh-trash-card-meta' },
          h('span', null, `原工作区：${entry.workspacePath || '未知'}`),
          h('span', null, `移入：${formatTime(entry.movedAt)}`),
          h('span', null, leftLabel(entry)),
        ),
      )
    }

    function RowMenu() {
      const state = useStore()
      const entry = state.entries.find((item) => item.sessionId === state.menuFor)
      if (!entry) return null
      const at = state.menuAt || { x: 200, y: 200 }
      const close = () => set({ menuFor: '' })
      return h(
        'div',
        { className: 'dsh-trash-menu', style: { left: at.x, top: at.y } },
        h(
          'button',
          {
            className: 'dsh-trash-menu-item',
            'data-danger': 'true',
            onClick: () => {
              close()
              set({ dialog: { kind: 'purge', entry } })
            },
          },
          '彻底删除',
        ),
        h(
          'button',
          {
            className: 'dsh-trash-menu-item',
            onClick: async () => {
              close()
              try {
                await api('restore', { sessionId: entry.sessionId })
                await refresh()
                set({ open: false, detailFor: '', menuFor: '' })
                notice('已还原为普通会话。')
              } catch (error) {
                set({ dialog: { kind: 'error', message: String(error?.message ?? error) } })
              }
            },
          },
          '还原',
        ),
        h(
          'button',
          {
            className: 'dsh-trash-menu-item',
            onClick: () => {
              close()
              set({ detailFor: entry.sessionId })
            },
          },
          '详情',
        ),
      )
    }

    /* ------------------------------------------------------------ dialogs */

    function Dialog({ dialog }) {
      const state = useStore()
      const close = () => set({ dialog: null })
      const [text, setText] = React.useState(dialog.value != null ? String(dialog.value) : '')
      const [opacity, setOpacity] = React.useState(dialog.value != null ? Number(dialog.value) : state.opacity)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const run = async (work) => {
        setBusy(true)
        setError('')
        try {
          await work()
          close()
        } catch (issue) {
          setError(String(issue?.message ?? issue))
        } finally {
          setBusy(false)
        }
      }

      if (dialog.kind === 'setup') {
        return h(
          'div',
          { className: 'dsh-trash-mask' },
          h(
            'div',
            { className: 'dsh-trash-dialog' },
            h('h3', null, '设置垃圾桶位置'),
            h('p', null, '被移入垃圾桶的会话会整包搬到这里。保存之前不会创建任何文件。'),
            h('input', {
              className: 'dsh-trash-input',
              value: text,
              placeholder: '例如 E:\\DSH工作区\\垃圾桶',
              onChange: (event) => setText(event.target.value),
            }),
            error ? h('p', { style: { color: THEME.red } }, error) : null,
            h(
              'div',
              { className: 'dsh-trash-actions' },
              h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
              h(
                'button',
                {
                  className: 'dsh-trash-btn',
                  'data-primary': 'true',
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      await api('config', { trashDir: text })
                      await refresh()
                    }),
                },
                '保存',
              ),
            ),
          ),
        )
      }

      if (dialog.kind === 'opacity') {
        return h(
          'div',
          { className: 'dsh-trash-mask' },
          h(
            'div',
            { className: 'dsh-trash-dialog' },
            h('h3', null, '背景透明度'),
            h('p', null, '只改背景，文字、菜单与图标始终不透明。'),
            h('input', {
              className: 'dsh-trash-slider',
              type: 'range',
              min: 0,
              max: 100,
              value: opacity,
              onChange: (event) => {
                const next = Number(event.target.value)
                setOpacity(next)
                applyOpacity(next)
              },
            }),
            h('input', {
              className: 'dsh-trash-input',
              type: 'number',
              min: 0,
              max: 100,
              value: opacity,
              onChange: (event) => setOpacity(Number(event.target.value)),
            }),
            error ? h('p', { style: { color: THEME.red } }, error) : null,
            h(
              'div',
              { className: 'dsh-trash-actions' },
              h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
              h(
                'button',
                {
                  className: 'dsh-trash-btn',
                  'data-primary': 'true',
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      await api('config', { opacity })
                      await refresh()
                    }),
                },
                '保存',
              ),
            ),
          ),
        )
      }

      if (dialog.kind === 'configure') {
        return h(
          'div',
          { className: 'dsh-trash-mask' },
          h(
            'div',
            { className: 'dsh-trash-dialog' },
            h('h3', null, '修改配置'),
            h('p', null, '你可以改垃圾桶位置、背景透明度和详情卡宽度。'),
            h('input', {
              className: 'dsh-trash-input',
              value: state.trashDir,
              onChange: (event) => set({ trashDir: event.target.value }),
            }),
            h('input', {
              className: 'dsh-trash-input',
              type: 'number',
              value: state.cardWidth,
              onChange: (event) => set({ cardWidth: Number(event.target.value) }),
            }),
            error ? h('p', { style: { color: THEME.red } }, error) : null,
            h(
              'div',
              { className: 'dsh-trash-actions' },
              h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
              h(
                'button',
                {
                  className: 'dsh-trash-btn',
                  'data-primary': 'true',
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      await api('config', { trashDir: state.trashDir, cardWidth: state.cardWidth })
                      await refresh()
                    }),
                },
                '保存',
              ),
            ),
          ),
        )
      }

      if (dialog.kind === 'clear') {
        return h(
          'div',
          { className: 'dsh-trash-mask' },
          h(
            'div',
            { className: 'dsh-trash-dialog' },
            h('h3', null, '清空垃圾桶'),
            h('p', null, `将永久删除垃圾桶内全部 ${dialog.count} 个会话，不可恢复。`),
            error ? h('p', { style: { color: THEME.red } }, error) : null,
            h(
              'div',
              { className: 'dsh-trash-actions' },
              h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
              h(
                'button',
                {
                  className: 'dsh-trash-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      await api('clear', {})
                      await refresh()
                    }),
                },
                '永久删除',
              ),
            ),
          ),
        )
      }

      if (dialog.kind === 'purge') {
        const entry = dialog.entry
        return h(
          'div',
          { className: 'dsh-trash-mask' },
          h(
            'div',
            { className: 'dsh-trash-dialog' },
            h('h3', null, '彻底删除'),
            h('p', null, `将永久删除「${entry.title || entry.sessionId}」及其全部文件，不可恢复。`),
            error ? h('p', { style: { color: THEME.red } }, error) : null,
            h(
              'div',
              { className: 'dsh-trash-actions' },
              h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
              h(
                'button',
                {
                  className: 'dsh-trash-btn',
                  'data-danger': 'true',
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      await api('purge', { sessionId: entry.sessionId })
                      await refresh()
                    }),
                },
                '永久删除',
              ),
            ),
          ),
        )
      }

      if (dialog.kind === 'error') {
        return h(
          'div',
          { className: 'dsh-trash-mask' },
          h(
            'div',
            { className: 'dsh-trash-dialog' },
            h('h3', null, '操作失败'),
            h('p', { style: { color: THEME.red } }, dialog.message),
            h(
              'div',
              { className: 'dsh-trash-actions' },
              h('button', { className: 'dsh-trash-btn', onClick: close }, '关闭'),
            ),
          ),
        )
      }

      return null
    }

    /* -------------------------------------------------------- delete flow */

    async function startDelete(sessionId) {
      const plan = await api('plan', { sessionId })
      if (plan.products?.length) {
        set({ dialog: { kind: 'products', plan } })
      } else {
        set({ dialog: { kind: 'confirmMove', plan } })
      }
    }

    function ProductsDialog({ plan }) {
      const close = () => set({ dialog: null })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const paths = plan.products.map((item) => item.path)
      return h(
        'div',
        { className: 'dsh-trash-mask' },
        h(
          'div',
          { className: 'dsh-trash-dialog' },
          h('h3', null, '发现这些由对话产生的文件'),
          h('p', null, '这些文件是本次对话里创建或修改的。删除不可恢复；保留则只清理对话本身。'),
          h('div', { className: 'dsh-trash-paths' }, paths.join('\n')),
          h('p', null, '是否删除这些文件？'),
          error ? h('p', { style: { color: THEME.red } }, error) : null,
          h(
            'div',
            { className: 'dsh-trash-actions' },
            h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
            h(
              'button',
              {
                className: 'dsh-trash-btn',
                disabled: busy,
                onClick: () => set({ dialog: { kind: 'keepAsk', plan } }),
              },
              '否',
            ),
            h(
              'button',
              {
                className: 'dsh-trash-btn',
                'data-danger': 'true',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  setError('')
                  try {
                    await api('move', { sessionId: plan.sessionId, removeProducts: paths })
                    await refresh()
                    close()
                    set({ open: true, detailFor: '', menuFor: '' })
                    notice('已移入垃圾桶（含产品文件）。')
                  } catch (issue) {
                    setError(String(issue?.message ?? issue))
                  } finally {
                    setBusy(false)
                  }
                },
              },
              '是',
            ),
          ),
        ),
      )
    }

    function KeepAskDialog({ plan }) {
      const close = () => set({ dialog: null })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      return h(
        'div',
        { className: 'dsh-trash-mask' },
        h(
          'div',
          { className: 'dsh-trash-dialog' },
          h('h3', null, '保留这些文件'),
          h('p', null, '已保留这些文件。是否继续删除当前对话？'),
          error ? h('p', { style: { color: THEME.red } }, error) : null,
          h(
            'div',
            { className: 'dsh-trash-actions' },
            h('button', { className: 'dsh-trash-btn', onClick: close }, '否'),
            h(
              'button',
              {
                className: 'dsh-trash-btn',
                'data-primary': 'true',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  try {
                    await api('move', { sessionId: plan.sessionId, removeProducts: [] })
                    await refresh()
                    close()
                    set({ open: true, detailFor: '', menuFor: '' })
                    notice('已移入垃圾桶（产品文件已保留）。')
                  } catch (issue) {
                    setError(String(issue?.message ?? issue))
                  } finally {
                    setBusy(false)
                  }
                },
              },
              '是',
            ),
          ),
        ),
      )
    }

    function ConfirmMoveDialog({ plan }) {
      const close = () => set({ dialog: null })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      return h(
        'div',
        { className: 'dsh-trash-mask' },
        h(
          'div',
          { className: 'dsh-trash-dialog' },
          h('h3', null, '删除会话'),
          h('p', null, `将把「${plan.title}」移入垃圾桶。15 天内可还原，满 360 小时后自动彻底删除。`),
          plan.summary ? h('p', { className: 'dsh-trash-note' }, plan.summary) : null,
          error ? h('p', { style: { color: THEME.red } }, error) : null,
          h(
            'div',
            { className: 'dsh-trash-actions' },
            h('button', { className: 'dsh-trash-btn', onClick: close }, '取消'),
            h(
              'button',
              {
                className: 'dsh-trash-btn',
                'data-danger': 'true',
                disabled: busy,
                onClick: async () => {
                  setBusy(true)
                  try {
                    await api('move', { sessionId: plan.sessionId })
                    await refresh()
                    close()
                    set({ open: true, detailFor: '', menuFor: '' })
                    notice('已移入垃圾桶。')
                  } catch (issue) {
                    setError(String(issue?.message ?? issue))
                  } finally {
                    setBusy(false)
                  }
                },
              },
              '移入垃圾桶',
            ),
          ),
        ),
      )
    }

    function dialogRouter() {
      const state = useStore()
      const dialog = state.dialog
      if (!dialog) return null
      if (dialog.kind === 'products') return h(ProductsDialog, { plan: dialog.plan })
      if (dialog.kind === 'keepAsk') return h(KeepAskDialog, { plan: dialog.plan })
      if (dialog.kind === 'confirmMove') return h(ConfirmMoveDialog, { plan: dialog.plan })
      return h(Dialog, { dialog })
    }

    function DeleteMenuItem(props) {
      const state = useStore()
      React.useEffect(() => {
        injectStyles()
        refresh().catch(() => {})
      }, [])
      const archived = state.archivedIds.includes(props.sessionId)
      if (!archived) return null
      const useMenuOpenState = props.useMenuOpenState
      let closeMenu = () => {}
      try {
        if (typeof useMenuOpenState === 'function') {
          const pair = useMenuOpenState()
          closeMenu = () => pair?.[1]?.(false)
        }
      } catch {}
      return h(
        'button',
        {
          role: 'menuitem',
          className: 'dsh-trash-menu-item',
          'data-danger': 'true',
          style: { color: THEME.red },
          onClick: async (event) => {
            event.preventDefault()
            closeMenu()
            try {
              await startDelete(props.sessionId)
            } catch (error) {
              set({ dialog: { kind: 'error', message: String(error?.message ?? error) } })
            }
          },
        },
        '确认删除',
      )
    }

    /* --------------------------------------------------------------- apply */

    function apply(ctx) {
      injectStyles()
      listRefresher = async () => {
        try {
          await ctx.sessions?.refresh?.()
        } catch {}
      }
      refresh().catch(() => {})

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-trash-can.entry', order: 10 },
          TrashEntry,
        ),
      )

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-trash-can.delete', order: 500 },
          DeleteMenuItem,
        ),
      )

      // The dialogs live beside the sidebar seat; render them through the same
      // component tree by appending a root that reads the store.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-trash-can.dialogs', order: 11 },
          function DialogHost() {
            const state = useStore()
            const dialog = state.dialog
            if (!dialog) return null
            if (dialog.kind === 'products') return h(ProductsDialog, { plan: dialog.plan })
            if (dialog.kind === 'keepAsk') return h(KeepAskDialog, { plan: dialog.plan })
            if (dialog.kind === 'confirmMove') return h(ConfirmMoveDialog, { plan: dialog.plan })
            return h(Dialog, { dialog })
          },
        ),
      )
    }

    return { inject, apply }
  },
})

