/**
 * dsh-power-menu-mac — host half.
 *
 * Adds four loopback-only HTTP routes used by the client-side power menu:
 *
 *   POST /api/dsh-power-menu-mac/shutdown  — quit the whole desktop app
 *   POST /api/dsh-power-menu-mac/restart   — quit, then relaunch the app
 *   POST /api/dsh-power-menu-mac/restart-delayed — quit now, relaunch in N minutes
 *   POST /api/dsh-power-menu-mac/schedule  — {action, minutes}: act after N minutes
 *   POST /api/dsh-power-menu-mac/cancel    — drop the waiting schedule
 *   GET  /api/dsh-power-menu-mac/health    — whether this is the desktop build
 *   GET  /api/dsh-power-menu-mac/plan      — target/refusal report, no side effects
 *   GET  /api/dsh-power-menu-mac/config    — default minutes, config path, schedule
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-power-menu-mac'
export const inject = ['webServer']

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
  let parsed = null
  let existed = false
  try {
    existed = existsSync(CONFIG_PATH)
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    parsed = null
  }
  const raw = parsed !== null && typeof parsed === 'object' ? parsed.delayedRestartMinutes : undefined
  const minutes = Number.isInteger(raw) && raw >= 1 && raw <= MAX_DELAYED_RESTART_MINUTES
    ? raw
    : DEFAULT_DELAYED_RESTART_MINUTES
  if (!existed) {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(
        CONFIG_PATH,
        `${JSON.stringify({ delayedRestartMinutes: DEFAULT_DELAYED_RESTART_MINUTES }, null, 2)}\n`,
        'utf8',
      )
      note(`config: wrote defaults to ${CONFIG_PATH}`)
    } catch (error) {
      note(`config: could not write defaults: ${String(error?.message ?? error)}`)
    }
  }
  return minutes
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
      note(`scheduled: ${scheduled.action} at ${new Date(scheduled.at).toISOString()}`)
    }
    return { ok: true, status: 202, mode }
  } catch (error) {
    pending = null
    const message = error instanceof Error ? error.message : String(error)
    note(`${mode}: failed to schedule: ${message}`)
    return { ok: false, status: 500, error: message }
  }
}

export function apply(ctx) {
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

      if (sub === '/config') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        json(res, 200, {
          ok: true,
          delayedRestartMinutes: readDelayedRestartMinutes(),
          configPath: CONFIG_PATH,
          scheduled,
        })
        return
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
        return json(res, 200, { ok: true })
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
