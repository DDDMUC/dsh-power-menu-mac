// dsh-power-menu-mac — browser half.
// Registers a power button in the session header utilities list (the
// top-right row, left of the native sidebar corner toggle) and a small
// pull-down menu, least destructive first:
//
//   刷新页面 — reload the renderer only; the app and its Host keep running
//   重启DSH — end it and relaunch the same executable
//   定时… — a panel: pick minutes, then 关闭 / 重启 / 现在关闭稍后启动
//   关闭DSH — end the whole desktop app (graceful host shutdown)
//
// The last three POST to the host half, which hands the process transition to a
// detached helper. The page then dims with a "shutting down / restarting"
// overlay until the window goes away (shutdown) or the app comes back.
//
// macOS only: the host half drives `ps`, `kill` and `lsappinfo`, so on any other
// platform the button is not drawn at all rather than drawn and dead.
//
// Bundle format required by DSH's client module loader.
window.__ModuleLoader__.load({
  id: 'dsh-power-menu-mac',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const inject = ['slots']

    const CSS_ID = 'dsh-power-menu-mac-css'
    const CSS = [
      '.dshpm-root{display:inline-flex;align-items:center;justify-content:center;-webkit-app-region:no-drag}',
      '.dshpm-floating{position:fixed;z-index:2147481000;pointer-events:auto}',
      '.dshpm-trigger{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#5f5f66);cursor:pointer;-webkit-app-region:no-drag;transition:background .14s ease,color .14s ease}',
      '.dshpm-trigger:hover,.dshpm-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dshpm-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-focus,#4d6bfe);outline-offset:1px}',
      '.dshpm-menu{position:fixed;z-index:2147482000;box-sizing:border-box;min-width:172px;padding:6px;border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));box-shadow:0 14px 36px rgba(0,0,0,.18),0 3px 10px rgba(0,0,0,.08);-webkit-app-region:no-drag;animation:dshpm-pop .12s ease-out}',
      '.dshpm-item{display:flex;align-items:center;gap:14px;width:100%;height:44px;padding:0 14px;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b20);font-family:inherit;font-size:15px;line-height:1;text-align:left;cursor:pointer;outline:none}',
      '.dshpm-item:hover,.dshpm-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshpm-item:active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}',
      '.dshpm-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '.dshpm-item:hover .dshpm-icon,.dshpm-item:focus-visible .dshpm-icon{color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dshpm-label{flex:1;white-space:nowrap}',
      '.dshpm-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(10,10,14,.22);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);animation:dshpm-fade .16s ease-out}',
      '.dshpm-toast{display:flex;align-items:center;gap:12px;padding:16px 22px;border-radius:13px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b20);font-size:14px;box-shadow:0 16px 44px rgba(0,0,0,.24)}',
      '.dshpm-spinner{width:16px;height:16px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dshpm-spin .8s linear infinite}',
      '.dshpm-error{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483001;max-width:min(520px,calc(100vw - 32px));box-sizing:border-box;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-state-error-primary,#c62828);color:#fff;font-size:13px;line-height:1.45;box-shadow:0 10px 28px rgba(0,0,0,.24)}',
      '.dshpm-notice{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483001;max-width:min(520px,calc(100vw - 32px));box-sizing:border-box;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,#1b1b20);font-size:13px;line-height:1.45;box-shadow:0 10px 28px rgba(0,0,0,.18)}',
      '.dshpm-panel{display:flex;flex-direction:column;gap:2px}',
      '.dshpm-field{display:flex;align-items:center;gap:8px;padding:6px 10px 2px}',
      '.dshpm-input{width:76px;height:30px;box-sizing:border-box;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b20);font-family:inherit;font-size:14px;text-align:center;outline:none}',
      '.dshpm-input:focus-visible{border-color:var(--dsw-alias-state-focus,#4d6bfe)}',
      '.dshpm-field-label{font-size:13px;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '.dshpm-hint{padding:0 10px 6px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '.dshpm-cfg{display:flex;flex-direction:column;gap:16px;max-width:520px}',
      '.dshpm-cfg-field{display:flex;flex-direction:column;gap:6px}',
      '.dshpm-cfg-label{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dshpm-cfg-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '.dshpm-cfg-input{width:96px;height:32px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b20);font-family:inherit;font-size:14px;text-align:center;outline:none}',
      '.dshpm-cfg-input:focus-visible{border-color:var(--dsw-alias-state-focus,#4d6bfe)}',
      '.dshpm-cfg-textarea{width:100%;min-height:96px;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b20);font-family:inherit;font-size:13px;line-height:1.5;resize:vertical;outline:none}',
      '.dshpm-cfg-textarea:focus-visible{border-color:var(--dsw-alias-state-focus,#4d6bfe)}',
      '.dshpm-cfg-textarea:disabled{opacity:.55}',
      '.dshpm-cfg-check{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--dsw-alias-label-primary,#1b1b20);cursor:pointer}',
      '.dshpm-cfg-actions{display:flex;align-items:center;gap:12px}',
      '.dshpm-cfg-button{height:32px;padding:0 16px;border:none;border-radius:7px;background:var(--dsw-alias-state-focus,#4d6bfe);color:#fff;font-family:inherit;font-size:14px;cursor:pointer}',
      '.dshpm-cfg-button:disabled{opacity:.5;cursor:default}',
      '.dshpm-cfg-status{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#5f5f66)}',
      '@keyframes dshpm-pop{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}',
      '@keyframes dshpm-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dshpm-spin{to{transform:rotate(360deg)}}',
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      let tag = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.pluginCss = CSS_ID
        document.head.append(tag)
      }
      if (tag.textContent !== CSS) tag.textContent = CSS
    }

    function PowerIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M12 3.2v8.4' }),
      h('path', { d: 'M6.15 6.55a8 8 0 1 0 11.7 0' }))
    }

    function RestartIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      h('path', { d: 'M3 3v5h5' }))
    }

    // 两段弧 + 两个箭头，跟上面那个单弧的 RestartIcon 明显不同：重启换进程，
    // 刷新只重载这一层页面，别让人认错。
    function RefreshIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      h('path', { d: 'M21 3v5h-5' }),
      h('path', { d: 'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16' }),
      h('path', { d: 'M3 21v-5h5' }))
    }

    // 表盘：延迟重启的"等一会儿再回来"，跟立刻回来的 RestartIcon 分开。
    function ClockIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: 12, cy: 12, r: 8.6 }),
      h('path', { d: 'M12 7.2V12l3.3 2' }))
    }

    function CancelIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M7 7l10 10' }),
      h('path', { d: 'M17 7L7 17' }))
    }

    // 多余的 props 原样透传给 button：契约属性（如 data-dsh-power-action）挂在真正的
    // 那个按钮上，选择器才抓得到。
    function MenuItem({ icon, label, onSelect, itemRef, ...rest }) {
      return h('button', {
        ...rest,
        type: 'button',
        role: 'menuitem',
        tabIndex: -1,
        ref: itemRef,
        className: 'dshpm-item',
        onClick: onSelect,
      },
      h('span', { className: 'dshpm-icon' }, icon),
      h('span', { className: 'dshpm-label' }, label))
    }

    function PowerMenuButton({ placement = 'footer' } = {}) {
      const [open, setOpen] = react.useState(false)
      const [anchor, setAnchor] = react.useState(null)
      const [phase, setPhase] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [view, setView] = react.useState('menu')
      const [minutesText, setMinutesText] = react.useState('10')
      const [notice, setNotice] = react.useState(null)
      const [scheduled, setScheduled] = react.useState(null)
      const triggerRef = react.useRef(null)
      const menuRef = react.useRef(null)
      const itemRefs = react.useRef([])
      const phaseRef = react.useRef(null)

      ensureCss()

      // 只用来决定菜单向上还是向下翻，给宽裕一点没有副作用。
      const panelRows = 3 + (scheduled === null ? 0 : 1)
      const menuHeight = view === 'schedule' ? 78 + 44 * panelRows : 200

      const place = react.useCallback(() => {
        const el = triggerRef.current
        if (el === null) return
        const rect = el.getBoundingClientRect()
        const menuWidth = 200
        const openUp = window.innerHeight - rect.bottom < menuHeight + 16
        const openLeft = window.innerWidth - rect.right < menuWidth + 16
        setAnchor({
          ...(openUp
            ? { bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)) }
            : { top: Math.round(rect.bottom + 8) }),
          ...(openLeft
            ? { right: Math.max(8, Math.round(window.innerWidth - rect.right)) }
            : { left: Math.round(rect.right + 8) }),
        })
      }, [menuHeight])

      react.useEffect(() => {
        if (!open) return undefined
        place()
        const onResize = () => place()
        window.addEventListener('resize', onResize)
        window.addEventListener('scroll', onResize, true)
        return () => {
          window.removeEventListener('resize', onResize)
          window.removeEventListener('scroll', onResize, true)
        }
      }, [open, place])

      react.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (menuRef.current?.contains(event.target)) return
          if (triggerRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
            triggerRef.current?.focus()
          }
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      // 每次打开菜单都读一遍配置：改了 config.json 不用重启应用，菜单文案立刻跟着变。
      react.useEffect(() => {
        if (!open) {
          setView('menu')
          return undefined
        }
        let alive = true
        fetch('/api/dsh-power-menu-mac/config', { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!alive || payload === null || payload.ok !== true) return
            const minutes = Number(payload.delayedRestartMinutes)
            if (Number.isInteger(minutes) && minutes > 0) {
              setMinutesText(String(minutes))
            }
            setScheduled(payload.scheduled ?? null)
          })
          .catch(() => {})
        return () => { alive = false }
      }, [open])

      // 打开时不把焦点丢进菜单：焦点落上去之后一个回车就会执行第一项。焦点留在
      // 触发按钮上，方向键进菜单（见触发按钮的 onKeyDown）。菜单项按破坏性从小到大
      // 排列，所以误触最多落到「刷新页面」。

      const onMenuKeyDown = (event) => {
        const items = itemRefs.current.filter(Boolean)
        if (items.length === 0) return
        const index = items.indexOf(document.activeElement)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          items[(index + 1 + items.length) % items.length].focus()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          items[(index - 1 + items.length) % items.length].focus()
        } else if (event.key === 'Home') {
          event.preventDefault()
          items[0].focus()
        } else if (event.key === 'End') {
          event.preventDefault()
          items[items.length - 1].focus()
        } else if (event.key === 'Tab') {
          setOpen(false)
        }
      }

      // blocking=true：应用马上就没，盖一层遮罩直到窗口消失。
      // blocking=false：只是排了个定时（或取消），用一条几秒后自动消失的提示就够了。
      const run = async (endpoint, body, options = {}) => {
        if (phaseRef.current !== null) return
        const blocking = options.blocking !== false
        setOpen(false)
        setError(null)
        if (blocking) {
          phaseRef.current = endpoint
          setPhase(endpoint)
        }
        try {
          const response = await fetch(`/api/dsh-power-menu-mac/${endpoint}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          let payload = {}
          try {
            payload = await response.json()
          } catch {
            payload = {}
          }
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          if (!blocking) {
            setNotice(options.notice ?? '已设定')
            window.setTimeout(() => setNotice(null), 6000)
          }
        } catch (err) {
          phaseRef.current = null
          setPhase(null)
          const message = err instanceof Error ? err.message : String(err)
          setError(`操作未执行：${message}`)
          window.setTimeout(() => setError(null), 7000)
        }
      }

      // 刷新页面只重载渲染层：应用、Host、会话和正在跑的轮次都不受影响。
      // DSH 自己没有可见的刷新入口（官方那项藏在 `development` 分支后面，打包版
      // 恒被丢弃），而重启一次就会多一条 dsh-auth cookie —— 攒够 71 条请求头就
      // 越过 Node 的 16 KB 上限，桌面版起不来。所以"为了刷新去重启"是最亏的用法，
      // 这个菜单项就是替掉它的。
      const refresh = () => {
        setOpen(false)
        setError(null)
        window.location.reload()
      }

      const minutes = Number.parseInt(minutesText, 10)
      const minutesValid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
      const clockOf = (timestamp) => {
        const date = new Date(timestamp)
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      }
      const actionText = (action) => (action === 'shutdown' ? '关闭' : action === 'restart' ? '重启' : '先关后启')
      const scheduleLabel = scheduled === null
        ? '定时…'
        : `定时…（${clockOf(scheduled.at)} ${actionText(scheduled.action)}）`
      const minutesLabel = minutesValid ? String(minutes) : 'N'

      const enterSchedule = () => {
        // 换视图要清掉旧 DOM 的引用，否则方向键会在已经卸载的节点之间跳。
        itemRefs.current = []
        setView('schedule')
      }

      const scheduleAction = (action, notice) => {
        if (!minutesValid) return
        run('schedule', { action, minutes }, { blocking: action === 'restart-delayed', notice })
      }

      const panel = h('div', { className: 'dshpm-panel' },
        h('div', { className: 'dshpm-field' },
          h('input', {
            className: 'dshpm-input',
            type: 'number',
            min: 1,
            max: 1440,
            step: 1,
            value: minutesText,
            'aria-label': '分钟数',
            'data-dshpm-minutes': '',
            onChange: (event) => setMinutesText(event.target.value),
          }),
          h('span', { className: 'dshpm-field-label' }, '分钟后')),
        h('div', { className: 'dshpm-hint' },
          minutesValid
            ? `将在 ${clockOf(Date.now() + minutes * 60000)} 执行 · Esc 关闭`
            : '请输入 1–1440 的整数'),
        h(MenuItem, {
          icon: h(ClockIcon, { size: 21 }),
          label: `${minutesLabel} 分钟后关闭`,
          'data-dsh-power-action': 'schedule-shutdown',
          itemRef: (el) => { itemRefs.current[0] = el },
          onSelect: () => scheduleAction('shutdown', `已设定：${minutesLabel} 分钟后关闭`),
        }),
        h(MenuItem, {
          icon: h(RestartIcon, { size: 21 }),
          label: `${minutesLabel} 分钟后重启`,
          'data-dsh-power-action': 'schedule-restart',
          itemRef: (el) => { itemRefs.current[1] = el },
          onSelect: () => scheduleAction('restart', `已设定：${minutesLabel} 分钟后重启`),
        }),
        h(MenuItem, {
          icon: h(PowerIcon, { size: 21 }),
          label: `现在关闭，${minutesLabel} 分钟后启动`,
          'data-dsh-power-action': 'schedule-restart-delayed',
          itemRef: (el) => { itemRefs.current[2] = el },
          onSelect: () => scheduleAction('restart-delayed', ''),
        }),
        scheduled !== null && h(MenuItem, {
          icon: h(CancelIcon, { size: 21 }),
          label: '取消定时',
          'data-dsh-power-action': 'cancel-schedule',
          itemRef: (el) => { itemRefs.current[3] = el },
          onSelect: () => run('cancel', {}, { blocking: false, notice: '已取消定时' }),
        }))

      const menuBody = view === 'schedule' ? panel : [
        h(MenuItem, {
          icon: h(RefreshIcon, { size: 21 }),
          label: '刷新页面',
          'data-dsh-power-action': 'refresh',
          itemRef: (el) => { itemRefs.current[0] = el },
          onSelect: refresh,
        }),
        h(MenuItem, {
          icon: h(RestartIcon, { size: 21 }),
          label: '重启DSH',
          'data-dsh-power-action': 'restart',
          itemRef: (el) => { itemRefs.current[1] = el },
          onSelect: () => run('restart'),
        }),
        h(MenuItem, {
          icon: h(ClockIcon, { size: 21 }),
          label: scheduleLabel,
          'data-dsh-power-action': 'schedule',
          itemRef: (el) => { itemRefs.current[2] = el },
          onSelect: enterSchedule,
        }),
        h(MenuItem, {
          icon: h(PowerIcon, { size: 21 }),
          label: '关闭DSH',
          'data-dsh-power-action': 'shutdown',
          itemRef: (el) => { itemRefs.current[3] = el },
          onSelect: () => run('shutdown'),
        }),
      ]

      const menu = open && h('div', {
        ref: menuRef,
        className: 'dshpm-menu',
        role: 'menu',
        'data-dshpm-menu': '',
        'data-dshpm-view': view,
        'aria-label': '电源菜单',
        style: anchor === null ? { top: 60, right: 16 } : anchor,
        onKeyDown: onMenuKeyDown,
      }, menuBody)

      const overlay = phase !== null && h('div', { className: 'dshpm-overlay' },
        h('div', { className: 'dshpm-toast', role: 'status', 'aria-live': 'assertive' },
          h('span', { className: 'dshpm-spinner' }),
          h('span', null, phase === 'shutdown'
            ? '正在关闭DSH…'
            : phase === 'restart-delayed' ? '正在关闭，稍后自动重启…' : '正在重启DSH…')))

      const errorToast = error !== null && h('div', { className: 'dshpm-error', role: 'alert' }, error)
      const noticeToast = notice !== null && h('div', { className: 'dshpm-notice', role: 'status' }, notice)

      const trigger = h('div', {
        className: 'dshpm-root',
      },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dshpm-trigger',
          title: '电源',
          'aria-label': '电源菜单',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          'data-dshpm-slot': placement,
          // 焦点留在按钮上，所以方向键要在这里接住：ArrowDown 进第一项、ArrowUp 进
          // 最后一项（`onMenuKeyDown` 用 activeElement 定位，按钮不在菜单里时下标是 -1）。
          onKeyDown: open ? onMenuKeyDown : undefined,
          onClick: () => {
            setError(null)
            const next = !open
            setOpen(next)
            // 明确把焦点留在按钮上：有的 WebKit 里点按钮不会自动聚焦，靠默认行为
            // 会出现"打开了菜单但方向键没反应"。
            if (next) triggerRef.current?.focus()
          },
        }, h(PowerIcon, { size: 16 })))

      const layers = h(react.Fragment, null, menu, overlay, noticeToast, errorToast)
      const canPortal = createPortal !== null && typeof document !== 'undefined'
      return h(react.Fragment, null,
        trigger,
        canPortal ? createPortal(layers, document.body) : layers)
    }

    function PowerMenuSlot() {
      const [mount, setMount] = react.useState(null)

      react.useLayoutEffect(() => {
        let node = null
        let observer = null
        const ensure = () => {
          const corner = document.querySelector('[data-conversation-header-corner]')
          if (corner === null) {
            if (node !== null) {
              node.remove()
              node = null
              setMount(null)
            }
            return
          }
          let appended = false
          if (node === null) {
            node = document.createElement('span')
            node.setAttribute('data-dshpm-mount', '')
            node.style.cssText = 'display:inline-flex;align-items:center;margin-left:4px;'
            setMount(node)
            appended = true
          }
          if (node.parentElement !== corner || corner.lastElementChild !== node) {
            corner.appendChild(node)
            appended = true
          }
          if (appended) {
            // 0.1.16 also forced a header reflow after appending. Without it,
            // the welcome screen's native left panel icon only appears after
            // the user manually resizes the window.
            void corner.offsetHeight
            window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
          }
        }
        ensure()
        // 0.1.16 caught the welcome header's delayed corner with a 500ms
        // interval. Observe the document instead: the corner can appear after
        // the first layout (the welcome screen does this), and a resize alone
        // is not guaranteed to fire.
        observer = new MutationObserver(() => ensure())
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', ensure)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', ensure)
          if (node !== null) node.remove()
        }
      }, [])

      if (mount === null || createPortal === null) return null
      return createPortal(h(PowerMenuButton, { placement: 'header' }), mount)
    }

    /**
     * Whether this window is on macOS.
     *
     * The shell marks `<html data-platform="darwin">`; a plain browser carries no
     * such marker, so the user agent decides there. Anything else keeps the
     * button off screen: the host half speaks POSIX (`ps`, `kill`, `lsappinfo`),
     * and a button that cannot work is worse than no button.
     */
    function onMac() {
      try {
        const marked = document.documentElement?.getAttribute?.('data-platform')
        if (typeof marked === 'string' && marked !== '') return marked === 'darwin'
        return /Mac OS X|Macintosh/u.test(String(navigator.userAgent ?? ''))
      } catch {
        return false
      }
    }

    /**
     * 插件管理页里属于这个插件自己的配置页（slot: `plugins.row.config`）。
     *
     * 注册之后「包含的组件」那一行会多出一个配置控件，点开就是
     * `#/panel/plugins/dsh-power-menu-mac/dsh-power-menu-mac`。
     *
     * `view: 'summary'` 只用在一句话摘要里；`view: 'page'` 才是完整表单。
     * 页面契约要求「只有保存才写入」，所以这里的输入只是本地暂存，点保存才 POST。
     */
    function PowerMenuConfigPage({ view }) {
      const [minutes, setMinutes] = react.useState('10')
      const [guidance, setGuidance] = react.useState(true)
      const [text, setText] = react.useState('')
      const [defaultText, setDefaultText] = react.useState('')
      const [ready, setReady] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [status, setStatus] = react.useState(null)

      react.useEffect(() => {
        let alive = true
        fetch('/api/dsh-power-menu-mac/config', { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!alive) return
            if (payload === null || payload.ok !== true) {
              setStatus('读取配置失败')
              return
            }
            const fallback = typeof payload.defaultGuidanceText === 'string' ? payload.defaultGuidanceText : ''
            const stored = typeof payload.restartGuidanceText === 'string' ? payload.restartGuidanceText : ''
            setDefaultText(fallback)
            setMinutes(String(payload.delayedRestartMinutes))
            setGuidance(payload.restartGuidance !== false)
            // 输入框里永远是能直接看、直接改的具体文字；"跟随内置默认"用空串表示，
            // 所以在界面上把它展开成默认那句。
            setText(stored === '' ? fallback : stored)
            setReady(true)
          })
          .catch(() => { if (alive) setStatus('读取配置失败') })
        return () => { alive = false }
      }, [])

      if (view === 'summary') {
        return `定时默认 ${minutes} 分钟 · 提示词${guidance ? '开' : '关'}`
      }

      const save = async () => {
        const parsed = Number.parseInt(minutes, 10)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
          setStatus('分钟数需要是 1–1440 的整数')
          return
        }
        setBusy(true)
        setStatus(null)
        try {
          const response = await fetch('/api/dsh-power-menu-mac/config', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              delayedRestartMinutes: parsed,
              restartGuidance: guidance,
              // 与默认那句相同就由宿主收敛成空串（"继续跟随默认"），这里原样提交。
              restartGuidanceText: text,
            }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          setStatus('已保存，下一个请求生效')
        } catch (error) {
          setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dshpm-cfg' },
        h('div', { className: 'dshpm-cfg-field' },
          h('label', { className: 'dshpm-cfg-label', htmlFor: 'dshpm-cfg-minutes' }, '定时面板的默认分钟数'),
          h('input', {
            id: 'dshpm-cfg-minutes',
            className: 'dshpm-cfg-input',
            type: 'number',
            min: 1,
            max: 1440,
            step: 1,
            value: minutes,
            disabled: !ready,
            onChange: (event) => { setMinutes(event.target.value); setStatus(null) },
          }),
          h('p', { className: 'dshpm-cfg-hint' },
            '1–1440。面板里每次都能临时改数字，这里只决定打开面板时的默认值。')),
        h('div', { className: 'dshpm-cfg-field' },
          h('label', { className: 'dshpm-cfg-check' },
            h('input', {
              type: 'checkbox',
              checked: guidance,
              disabled: !ready,
              onChange: (event) => { setGuidance(event.target.checked); setStatus(null) },
            }),
            '注入提示词')),
        h('div', { className: 'dshpm-cfg-field' },
          h('label', { className: 'dshpm-cfg-label', htmlFor: 'dshpm-cfg-text' }, '提示词内容'),
          h('textarea', {
            id: 'dshpm-cfg-text',
            className: 'dshpm-cfg-textarea',
            value: text,
            disabled: !ready || !guidance,
            maxLength: 2000,
            placeholder: defaultText,
            onChange: (event) => { setText(event.target.value); setStatus(null) },
          }),
          h('p', { className: 'dshpm-cfg-hint' }, `${String(text.length)}/2000`)),
        h('div', { className: 'dshpm-cfg-actions' },
          h('button', {
            type: 'button',
            className: 'dshpm-cfg-button',
            disabled: !ready || busy,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          status !== null && h('p', { className: 'dshpm-cfg-status' }, status)))
    }

    function apply(ctx) {
      if (!onMac()) return
      ensureCss()
      // 0.1.16 mounted this through `shell.overlay`, which is root-scoped and
      // therefore present on the no-session welcome screen too. The component
      // itself waits for `[data-conversation-header-corner]` and appends the
      // power button inside it, after the native sidebar toggle.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-power-menu-mac',
        order: 100,
        registrant: 'dsh-power-menu-mac',
      }, PowerMenuSlot))

      // 插件管理页里这一行的配置页。key 的格式是 `<包名>#<行 id>`，行 id 来自
      // cordis.patch.yml 里那一行的 `id`，两个都是 dsh-power-menu-mac。
      // 注册成功后「包含的组件」那一行会多出一个配置控件。
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-power-menu-mac#dsh-power-menu-mac',
        registrant: 'dsh-power-menu-mac',
      }, PowerMenuConfigPage))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
