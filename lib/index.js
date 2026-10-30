/**
 * dsh-power-menu-mac — host half.
 *
 * Adds the loopback-only HTTP routes used by the client-side power menu, and one
 * system-prompt section telling the model not to offer to restart the app: the
 * menu is right there, so asking is just an extra round trip.
 *
 *   POST /api/dsh-power-menu-mac/shutdown  — quit the whole desktop app
 *   POST /api/dsh-power-menu-mac/restart   — quit, then relaunch the app
 *   POST /api/dsh-power-menu-mac/restart-delayed — quit now, relaunch in N minutes
 *   POST /api/dsh-power-menu-mac/schedule  — {action, minutes}: act after N minutes
 *   POST /api/dsh-power-menu-mac/cancel    — drop the waiting schedule
 *   GET  /api/dsh-power-menu-mac/health    — whether this is the desktop build
 *   GET  /api/dsh-power-menu-mac/plan      — target/refusal report, no side effects
 *   GET  /api/dsh-power-menu-mac/config    — default minutes, config path, schedule
 *   GET  /api/dsh-power-menu-mac/bundles   — per-plugin client bundle revisions
 *
 * The host process is a child of the Electron main process in the desktop
 * build, so it cannot call app.quit() / app.relaunch() itself. The actual
 * handoff is performed by a detached helper (lib/helper.cjs) which signals only
 * the Electron main process. The main going away closes the IPC channel; the
 * host then runs its own graceful `application.shutdown` and flushes the session
 * logs. For a restart the helper waits for the port to be released and
 * relaunches the same executable with a clean environment.
 *
 * macOS only — see the note in `helper.cjs`.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-power-menu-mac'
export const inject = ['webServer', 'systemPrompt']

/**
 * Every installed plugin's client bundle, identified by the same three values
 * DSH derives its revision from (mtime / ctime / size).
 *
 * The point is not to rebuild the revision — it is to answer one question the
 * open page cannot answer itself: *has anything under lib/client.js changed
 * since I booted?* If yes, the page holds stale revisions, and reloading
 * replaces a working UI with "bundle script … failed to load" for those
 * entries. Comparing this snapshot against the one taken at mount is enough.
 *
 * Returns null when the profile cannot be located (the host is not running with
 * a profile as its cwd), in which case the guard simply stays out of the way.
 */
function clientBundleRevisions() {
  const root = join(process.cwd(), 'node_modules')
  if (!existsSync(root)) return null

  let top
  try {
    top = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }

  const dirs = []
  for (const entry of top) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!entry.name.startsWith('@')) {
      dirs.push(join(root, entry.name))
      continue
    }
    try {
      for (const inner of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory() || inner.isSymbolicLink()) dirs.push(join(root, entry.name, inner.name))
      }
    } catch {
      /* a scoped directory we cannot read contributes nothing */
    }
  }

  const out = []
  for (const dir of dirs) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const rel = clientEntryOf(pkg)
    if (rel === null) continue
    let stat
    try {
      stat = statSync(join(dir, rel))
    } catch {
      continue
    }
    out.push({
      name: typeof pkg.name === 'string' ? pkg.name : basename(dir),
      rev: `${String(stat.mtimeMs)}:${String(stat.size)}`,
    })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/** `exports["./client"]`, accepting the string and one-level conditional forms. */
function clientEntryOf(pkg) {
  const exportsField = pkg !== null && typeof pkg === 'object' ? pkg.exports : undefined
  if (exportsField === null || typeof exportsField !== 'object') return null
  const client = exportsField['./client']
  if (typeof client === 'string') return client
  if (client !== null && typeof client === 'object' && typeof client.default === 'string') return client.default
  return null
}

const BASE = '/api/dsh-power-menu-mac'
const HELPER = fileURLToPath(new URL('./helper.cjs', import.meta.url))
// Its own state directory: installing this alongside the original must not have
// the two share a log file or a handoff directory.
const STATE_DIR = join(homedir(), '.dsh', 'dsh-power-menu-mac')
const LOG_PATH = join(STATE_DIR, 'power-menu.log')
// 用户可编辑：延迟重启的分钟数。第一次读取时落一份默认值，方便发现和修改。
const CONFIG_PATH = join(STATE_DIR, 'config.json')
const DEFAULT_DELAYED_RESTART_MINUTES = 10
const MAX_DELAYED_RESTART_MINUTES = 24 * 60
// 自定义提示词的上限。这段每次请求都会进 system prompt，放任用户粘 100 KB 进去
// 会把整个提示词预算吃掉，所以截断而不是拒绝。
const MAX_GUIDANCE_CHARS = 2000

/**
 * 随插件一起注入给模型的一句话。
 *
 * 装上这个插件就说明界面右上角有电源菜单，用户自己两下就点完了；模型再问
 * "要不要我帮你重启" 只是多一轮废话。范围刻意钉死在「重启/关闭 DSH」这一件事上，
 * 不写"不要问用户"这种宽口径 —— 那会连带压住改文件、跑命令之类的正常询问。
 */
const POWER_MENU_GUIDANCE = [
  'DSH 桌面应用的重启与关闭由用户自己通过界面右上角的电源菜单完成。',
  '不要询问用户是否需要重启或关闭 DSH，也不要主动提议这样做。',
].join('')

/** At-most-once latch: restart and shutdown both end this process. */
let pending = null
/** 已排定的定时动作（等待中的 helper）。宿主一死就没了，正好等于"定时作废"。 */
let scheduled = null

function note(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the action */
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Whether this host is the desktop build's child (Electron main as parent). */
function desktopTarget() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null
  const mainPid = process.ppid
  if (!Number.isInteger(mainPid) || mainPid <= 1) return null
  const exe = process.execPath
  if (typeof exe !== 'string' || exe === '') return null
  const base = basename(exe).toLowerCase()
  // A plugin-spawned node.exe inherits ELECTRON_RUN_AS_NODE=1. Never mistake
  // it for the desktop executable: killing it would be a silent misfire.
  if (base === 'node.exe' || base === 'node') return null
  return { mainPid, exe, hostPid: process.pid }
}

function resolvePort(ctx) {
  try {
    const port = ctx.webServer?.port
    if (Number.isInteger(port) && port > 0) return port
  } catch {
    /* fall through */
  }
  try {
    const address = ctx.webServer?.server?.address?.()
    if (address !== null && typeof address === 'object' && Number.isInteger(address.port) && address.port > 0) {
      return address.port
    }
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Destructive routes are fenced the same way DSH fences its own API:
 * loopback socket, loopback Host header, no cross-site fetch, and an Origin
 * whose host:port is this server. DSH's renderer may use the `dsh-app:`
 * scheme, so protocol equality is deliberately not required.
 */
/**
 * 读一个小的 JSON 请求体。超过 4 KB 或不是 JSON 一律当作空对象，
 * 调用方再用默认值兜底 —— 定时请求本来就只有两个字段。
 */
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

function trusted(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  if (hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== '[::1]' && hostname !== 'localhost') return false
  if (secFetchSite === 'cross-site') return false
  // The desktop shell can omit Origin entirely. 0.1.16 accepted that and the
  // real button worked; rejecting it here caused every click to 403. The
  // loopback socket + loopback Host checks still apply, and a local process
  // that can omit Origin could already signal the app directly, so this is the
  // same local-trust boundary documented in the README.
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    const originUrl = new URL(origin)
    // `dsh-app://127.0.0.1:<port>` is the normal desktop renderer origin;
    // requiring an exact http/https protocol here made every real button
    // click 403. The host and port still pin the request to this server.
    return originUrl.host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 延迟重启的等待分钟数，来自 `~/.dsh/dsh-power-menu-mac/config.json`。
 *
 * 文件不存在时写一份默认值再返回 —— 用户得先看到文件才可能去改它。
 * 值不合法（非整数、< 1、超过 24 小时）时一律回落到默认值，绝不因为配置写错
 * 就让重启变成"永不回来"。
 *
 * @returns {number} 1..1440 之间的整数分钟。
 */
function readDelayedRestartMinutes() {
  return readConfig().delayedRestartMinutes
}

/**
 * 归一化后的用户配置。
 *
 * 读不到、不是 JSON、字段类型不对，一律回落到默认值 —— 配置写坏不该让插件
 * 拒绝工作，更不该让"延迟重启"变成"永不回来"。
 *
 * 文件不存在时写一份带注释性默认值的样本，用户得先看见文件才可能去改它。
 * 已存在的文件**不会被改写**：老版本只有 `delayedRestartMinutes`，新字段缺省即
 * 走默认行为，不需要迁移。
 *
 * @returns {{delayedRestartMinutes: number, restartGuidance: boolean, restartGuidanceText: string}}
 */
function readConfig() {
  let parsed = null
  let existed = false
  try {
    existed = existsSync(CONFIG_PATH)
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    parsed = null
  }
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const minutes = Number.isInteger(source.delayedRestartMinutes)
    && source.delayedRestartMinutes >= 1
    && source.delayedRestartMinutes <= MAX_DELAYED_RESTART_MINUTES
    ? source.delayedRestartMinutes
    : DEFAULT_DELAYED_RESTART_MINUTES
  // 只有显式写 false 才关；缺省、写错类型都当"开"，保持插件本来的意图。
  const restartGuidance = source.restartGuidance !== false
  const rawText = typeof source.restartGuidanceText === 'string' ? source.restartGuidanceText.trim() : ''
  if (rawText.length > MAX_GUIDANCE_CHARS) {
    note(`config: restartGuidanceText truncated from ${String(rawText.length)} to ${String(MAX_GUIDANCE_CHARS)} chars`)
  }
  if (!existed) {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(
        CONFIG_PATH,
        `${JSON.stringify({
          delayedRestartMinutes: DEFAULT_DELAYED_RESTART_MINUTES,
          restartGuidance: true,
          restartGuidanceText: '',
        }, null, 2)}\n`,
        'utf8',
      )
      note(`config: wrote defaults to ${CONFIG_PATH}`)
    } catch (error) {
      note(`config: could not write defaults: ${String(error?.message ?? error)}`)
    }
  }
  return {
    delayedRestartMinutes: minutes,
    restartGuidance,
    restartGuidanceText: rawText.slice(0, MAX_GUIDANCE_CHARS),
  }
}

/**
 * 这一段系统提示词此刻该渲染成什么。
 *
 * 三件事按顺序判断：用户关了它 → 空；不是桌面宿主 → 空（`dsh web` 上没有电源
 * 菜单，说"用户自己点"是错误指引）；否则用自定义文本，没自定义就用内置那句。
 * 空串会被 DSH 整段丢弃，所以"不注入"和"渲染成空"是一回事。
 *
 * @returns {string} 提示词正文，或空串表示这段不出现。
 */
function guidanceText() {
  const config = readConfig()
  if (!config.restartGuidance) return ''
  if (desktopTarget() === null) return ''
  return config.restartGuidanceText === '' ? POWER_MENU_GUIDANCE : config.restartGuidanceText
}

/**
 * Write the handoff file and start the detached helper.
 * @param {'shutdown'|'restart'} mode
 * @param {object} ctx
 * @param {{relaunchDelayMs?: number}} [options] - restart 专用：关掉之后隔多久再拉起。
 */
function schedule(mode, ctx, options = {}) {
  if (pending !== null) {
    return { ok: false, status: 409, error: `power transition already in progress: ${pending}` }
  }
  // 已经有一条定时在等的时候，不再接受第二条：两个 helper 都会到点动手，
  // 第二个等于对着一个已经死掉的 pid 空转，还可能把刚重启的实例再关一次。
  if (scheduled !== null && Number.isFinite(options.preDelayMs) && options.preDelayMs > 0) {
    return { ok: false, status: 409, error: '已经有一条定时在等，先取消它' }
  }
  const target = desktopTarget()
  if (target === null) {
    return {
      ok: false,
      status: 409,
      error: '仅支持 DeepSeek Harness 桌面版（当前是 dsh web，请用终端里的进程管理方式）',
    }
  }
  if (!existsSync(HELPER)) return { ok: false, status: 500, error: `helper missing: ${HELPER}` }

  pending = mode
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 23)
    const handoffPath = join(STATE_DIR, `handoff-${mode}-${stamp}.json`)
    const logPath = join(STATE_DIR, `helper-${mode}-${stamp}.log`)
    const relaunchDelayMs = mode === 'restart' && Number.isFinite(options.relaunchDelayMs) && options.relaunchDelayMs > 0
      ? Math.round(options.relaunchDelayMs)
      : 0
    // 定时动作：等这么久之后才动手（关或重启）。和 relaunchDelayMs 是两个不同的
    // 阶段 —— 前者在动手之前，后者在关掉之后。
    const preDelayMs = Number.isFinite(options.preDelayMs) && options.preDelayMs > 0
      ? Math.round(options.preDelayMs)
      : 0
    const handoff = {
      mode,
      mainPid: target.mainPid,
      hostPid: target.hostPid,
      exe: target.exe,
      port: resolvePort(ctx),
      delayMs: 1200,
      relaunchDelayMs,
      preDelayMs,
      logPath,
      handoffPath,
      startedAt: new Date().toISOString(),
    }
    writeFileSync(handoffPath, JSON.stringify(handoff, null, 2), 'utf8')
    note(`${mode}: scheduled main=${String(target.mainPid)} host=${String(target.hostPid)} exe=${target.exe} port=${String(handoff.port)} relaunchDelayMs=${String(relaunchDelayMs)} log=${logPath}`)

    const helper = spawn(process.execPath, [HELPER, handoffPath], {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(HELPER),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    helper.on('error', (error) => {
      note(`${mode}: helper spawn error: ${String(error?.message ?? error)}`)
      pending = null
    })
    helper.unref()
    note(`${mode}: helper pid=${String(helper.pid)}`)
    if (preDelayMs > 0) {
      scheduled = {
        helperPid: typeof helper.pid === 'number' ? helper.pid : null,
        action: typeof options.action === 'string' ? options.action : mode,
        at: Date.now() + preDelayMs,
        minutes: Math.round(preDelayMs / 60000),
      }
      // 定时只是排着，应用还活着，什么都没开始切换。`pending` 是"切换已经开始"
      // 的闩，留着它会让之后的立即关闭/重启全部 409 —— 这里必须放开，
      // 重复排定由 `scheduled` 自己挡。
      pending = null
      note(`scheduled: ${scheduled.action} at ${new Date(scheduled.at).toISOString()}`)
    } else {
      // 立即切换如果 30 秒还没把应用带走，说明这一步没成（kill 被拒、helper 早退、
      // 端口没释放……）。闩一直锁着会让之后每一次操作都 409，所以到点自己放开，
      // 让用户能重试。成功的切换走不到这里 —— 进程早就没了。
      const release = setTimeout(() => {
        if (pending !== mode) return
        pending = null
        note(`${mode}: released the at-most-once latch after 30s; the transition did not happen`)
      }, 30000)
      if (typeof release.unref === 'function') release.unref()
    }
    return { ok: true, status: 202, mode, scheduled }
  } catch (error) {
    pending = null
    const message = error instanceof Error ? error.message : String(error)
    note(`${mode}: failed to schedule: ${message}`)
    return { ok: false, status: 500, error: message }
  }
}

export function apply(ctx) {
  // 这个包只服务 macOS。同一个 profile 里通常还装着另一个平台的版本，
  // 两个包都注入同一段提示词会让模型看到两遍；路由也只会多出一份没人点的入口。
  if (process.platform !== 'darwin') {
    note(`skipped: platform ${process.platform} is not darwin`)
    return
  }
  // 只有真正的桌面版才谈得上"用电源菜单自己点"。dsh web 上没有这个按钮，
  // 那段话会变成错误指引，所以非桌面宿主渲染成空串（空段落会被整段丢掉）。
  // 文本每次渲染都重新读配置：改 config.json 不用重启，下一个请求就生效。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:dsh-power-menu-mac',
    order: 150,
    text: () => guidanceText(),
  }), 'dsh-power-menu-mac: system prompt section')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      let sub = '/'
      try {
        sub = new URL(req.url ?? '/', 'http://x').pathname.slice(BASE.length).replace(/\/+$/u, '') || '/'
      } catch {
        /* keep '/' */
      }

      if (sub === '/health') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        json(res, 200, {
          ok: true,
          desktop: desktopTarget() !== null,
          pending,
        })
        return
      }

      if (sub === '/plan') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const target = desktopTarget()
        const reasons = []
        if (target === null) reasons.push('not a desktop host, or the executable looks like node')
        if (!existsSync(HELPER)) reasons.push(`helper missing: ${HELPER}`)
        if (target !== null && !existsSync(target.exe)) reasons.push(`executable missing: ${target.exe}`)
        json(res, 200, {
          ok: reasons.length === 0,
          desktop: target !== null,
          target,
          helper: HELPER,
          logPath: LOG_PATH,
          pending,
          reasons,
        })
        return
      }

      if (sub === '/bundles') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const bundles = clientBundleRevisions()
        // supported:false 表示宿主没跑在 profile 目录里，前端据此不做刷新拦截。
        json(res, 200, { ok: true, supported: bundles !== null, bundles: bundles ?? [] })
        return
      }

      if (sub === '/config') {
        if (req.method === 'GET') {
          const config = readConfig()
          json(res, 200, {
            ok: true,
            delayedRestartMinutes: config.delayedRestartMinutes,
            restartGuidance: config.restartGuidance,
            restartGuidanceText: config.restartGuidanceText,
            // 配置页要把它填进输入框，所以默认那句由宿主给出，前端不另存一份。
            defaultGuidanceText: POWER_MENU_GUIDANCE,
            configPath: CONFIG_PATH,
            scheduled,
          })
          return
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (!trusted(req)) {
          note(`forbidden: config save origin=${JSON.stringify(req.headers.origin ?? null)}`)
          return json(res, 403, { ok: false, error: 'forbidden: untrusted power request' })
        }
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: 'body must be JSON' })
        const minutes = Number(body.delayedRestartMinutes)
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DELAYED_RESTART_MINUTES) {
          return json(res, 400, {
            ok: false,
            error: `分钟数需要是 1–${String(MAX_DELAYED_RESTART_MINUTES)} 的整数`,
          })
        }
        const guidance = body.restartGuidance !== false
        const rawText = typeof body.restartGuidanceText === 'string' ? body.restartGuidanceText.trim() : ''
        const clipped = rawText.slice(0, MAX_GUIDANCE_CHARS)
        const next = {
          delayedRestartMinutes: minutes,
          restartGuidance: guidance,
          // 与内置默认一字不差就存空串：空串的语义是"继续跟随默认"，这样以后默认
          // 那句改进了，保存过但没真正改字的用户也能跟上。规则只放在这里一份。
          restartGuidanceText: clipped === POWER_MENU_GUIDANCE ? '' : clipped,
        }
        try {
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
          note(`config: saved minutes=${String(minutes)} guidance=${String(guidance)} textLen=${String(next.restartGuidanceText.length)}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          note(`config: save failed: ${message}`)
          return json(res, 500, { ok: false, error: `无法写入 ${CONFIG_PATH}: ${message}` })
        }
        return json(res, 200, { ok: true, ...next, configPath: CONFIG_PATH })
      }

      if (sub === '/schedule') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (!trusted(req)) {
          note(`forbidden: schedule origin=${JSON.stringify(req.headers.origin ?? null)}`)
          return json(res, 403, { ok: false, error: 'forbidden: untrusted power request' })
        }
        const body = await readJsonBody(req)
        if (body === null) return json(res, 400, { ok: false, error: 'body must be JSON' })
        const action = typeof body.action === 'string' ? body.action : ''
        const minutes = Number(body.minutes)
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DELAYED_RESTART_MINUTES) {
          return json(res, 400, {
            ok: false,
            error: `minutes must be an integer between 1 and ${String(MAX_DELAYED_RESTART_MINUTES)}`,
          })
        }
        const delayMs = minutes * 60000
        let result
        if (action === 'shutdown') result = schedule('shutdown', ctx, { preDelayMs: delayMs, action })
        else if (action === 'restart') result = schedule('restart', ctx, { preDelayMs: delayMs, action })
        else if (action === 'restart-delayed') result = schedule('restart', ctx, { relaunchDelayMs: delayMs, action })
        else return json(res, 400, { ok: false, error: `unknown action ${JSON.stringify(action)}` })
        return json(res, result.status ?? 202, result)
      }

      if (sub === '/cancel') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (!trusted(req)) {
          note(`forbidden: cancel origin=${JSON.stringify(req.headers.origin ?? null)}`)
          return json(res, 403, { ok: false, error: 'forbidden: untrusted power request' })
        }
        if (scheduled === null) return json(res, 409, { ok: false, error: 'nothing is scheduled' })
        const helperPid = scheduled.helperPid
        scheduled = null
        if (typeof helperPid === 'number' && helperPid > 1) {
          try {
            process.kill(helperPid, 'SIGKILL')
            note(`cancel: killed waiting helper ${String(helperPid)}`)
          } catch (error) {
            note(`cancel: helper ${String(helperPid)} was already gone: ${String(error?.message ?? error)}`)
          }
        }
        return json(res, 200, { ok: true, scheduled: null })
      }

      if (sub !== '/shutdown' && sub !== '/restart' && sub !== '/restart-delayed') {
        return json(res, 404, { ok: false, error: `no dsh-power-menu-mac endpoint ${sub}` })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
      if (!trusted(req)) {
        note(`forbidden: origin=${JSON.stringify(req.headers.origin ?? null)} host=${JSON.stringify(req.headers.host ?? null)} sec=${JSON.stringify(req.headers['sec-fetch-site'] ?? null)}`)
        return json(res, 403, { ok: false, error: 'forbidden: untrusted power request' })
      }

      const result = sub === '/restart-delayed'
        ? schedule('restart', ctx, { relaunchDelayMs: readDelayedRestartMinutes() * 60000 })
        : schedule(sub === '/restart' ? 'restart' : 'shutdown', ctx)
      if (!result.ok) return json(res, result.status ?? 500, result)
      json(res, result.status ?? 202, result)
    },
  }), 'dsh-power-menu-mac: /api/dsh-power-menu-mac routes')
}

// Some installers/loaders unwrap ESM imports through `default`; keep both
// shapes so a Git install behaves like the locally linked package. The
// default must be the full plugin object, not the bare `apply` function:
// Cordis reads `inject` from the unwrapped plugin, and losing it throws
// `cannot get property "webServer" without inject`.
export default { name, inject, apply }
