'use strict'

/**
 * dsh-power-menu-mac — detached handoff helper.
 *
 * Runs as Electron's Node mode (`ELECTRON_RUN_AS_NODE=1`) so it does not
 * depend on a system Node. It outlives the host because it is the only piece
 * that must survive the Electron main process being ended.
 *
 * Shutdown:
 *   1. wait for the browser to receive the HTTP acknowledgement;
 *   2. end ONLY the Electron main process (SIGTERM, then SIGKILL as a backstop);
 *      the host's IPC channel then disconnects and the host runs its own
 *      graceful `application.shutdown`, flushing session logs;
 *   3. wait for the web port to be released (the host exits when done).
 *
 * Before step 2 the helper snapshots the main process tree and excludes the
 * Host subtree. Once the Host has exited, it ends the leftover non-Host
 * children (GPU, renderers, plugin background servers) so they do not become
 * orphans. The Host is never signalled on the normal path, because that would
 * skip its graceful shutdown.
 *
 * The snapshot runs while the helper waits for the browser acknowledgement,
 * so the normal shutdown/restart path does not gain a fixed delay.
 *
 * Restart: the same, then wait for the port to free and relaunch the same
 * executable with a clean environment (ELECTRON_RUN_AS_NODE removed, or the
 * new instance would start without a window). Verify the new process stays
 * alive, retrying a couple of times; if it never comes up, show a message box.
 */

const { execFile, execFileSync, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const execFileAsync = promisify(execFile)

const MAIN_EXIT_TIMEOUT_MS = 15000
const PORT_FREE_TIMEOUT_MS = 30000
const HOST_EXIT_TIMEOUT_MS = 25000
const ORPHAN_LIST_TIMEOUT_MS = 5000
const RELAUNCH_ATTEMPTS = 3

/**
 * Whether the orphan sweep may also end the Host's other children.
 *
 * Those children are whatever the user (or an agent) started from DSH's own
 * terminal: a second `dsh web` instance, a dev server, a build. Killing them
 * on shutdown/restart is surprising and destructive, so it is opt-in:
 * set DSH_POWER_MENU_KILL_HOST_CHILDREN=1 to restore the old behaviour.
 */
const KILL_HOST_CHILDREN = process.env.DSH_POWER_MENU_KILL_HOST_CHILDREN === '1'

/**
 * Extra argv for the relaunched app, per DSH home.
 *
 * A home launched as `DeepSeek Harness --user-data-dir=<home>/userdata` must get
 * that switch back, or the relaunched app silently falls back to the default
 * Electron profile (and two isolated homes would share one).
 *
 *   1. DSH_HOME set   -> <DSH_HOME>/power-menu-relaunch-args.json
 *   2. DSH_HOME unset -> <home>/.dsh/dsh-power-menu-mac/relaunch-args.json
 *
 * The file name is the upstream one (a DSH_HOME-scoped file is shared by design);
 * only the home-relative directory carries this port's name, so installing both
 * plugins side by side cannot have them read each other's arguments.
 *
 * A missing or malformed file means "no extra argv" (upstream behaviour).
 */
function readLaunchArgs() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const files = home === ''
    ? [path.join(os.homedir(), '.dsh', 'dsh-power-menu-mac', 'relaunch-args.json')]
    : [path.join(home, 'power-menu-relaunch-args.json')]
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []
    } catch {
      /* try the next candidate */
    }
  }
  return []
}
const WINDOW_VERIFY_TIMEOUT_MS = 20000
const WINDOW_POLL_MS = 500

/**
 * 保留几条 dsh-auth cookie。见 `pruneAuthCookies`。
 */
const AUTH_COOKIE_KEEP = 3

/**
 * app 的 Electron user-data 目录。relaunch 参数里带 `--user-data-dir` 时以它为准，
 * 否则是 Electron 的默认 profile 目录。
 *
 * @param {string[]} argv - 重启时用的 argv。
 * @returns {string} user-data 目录的绝对路径。
 */
function userDataDir(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index])
    if (value === '--user-data-dir' && typeof argv[index + 1] === 'string') return path.resolve(argv[index + 1])
    if (value.startsWith('--user-data-dir=')) return path.resolve(value.slice('--user-data-dir='.length))
  }
  return path.join(os.homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop')
}

/**
 * 把攒下来的 `dsh-auth-*` cookie 删到只剩最近几条。
 *
 * 宿主每次启动都会下发一个**新名字**的 `dsh-auth-<随机>` cookie，旧的一个都不清；
 * 而 cookie 不区分端口，所有端口上的宿主共用同一批。攒到 71 条时 `Cookie` 请求头
 * 就有 16.1 KB，越过 Node 默认的 16 KB 请求头上限，宿主回 431，桌面壳报
 * "desktop welcome: Web authentication failed"（2026-10-29 实测，重启越频繁越快）。
 *
 * 退出/重启之后 app 已经关了，这时清理是安全的：新实例会自己下发一条新的。
 * 只保留最近 3 条而不是全删，是为了不把同一台机器上另一个长期运行的 `dsh web`
 * （浏览器里那个界面）当场登出。
 *
 * @param {string} label - 日志前缀（shutdown / restart）。
 * @param {string[]} argv - 重启时用的 argv，用来定位 user-data 目录。
 */
function pruneAuthCookies(label, argv = []) {
  const db = path.join(userDataDir(argv), 'Cookies')
  if (!fs.existsSync(db)) {
    note(`${label}: no cookie jar at ${db}; nothing to prune`)
    return
  }
  const sql = [
    "delete from cookies where name like 'dsh-auth-%' and rowid not in",
    `(select rowid from cookies where name like 'dsh-auth-%' order by creation_utc desc limit ${AUTH_COOKIE_KEEP});`,
    "select count(*) from cookies where name like 'dsh-auth-%';",
  ].join(' ')
  try {
    // macOS 自带 /usr/bin/sqlite3；Chromium 的 Cookies 就是一个 SQLite 库。
    const left = execFileSync('/usr/bin/sqlite3', [db, sql], { encoding: 'utf8', timeout: 8000 }).trim()
    note(`${label}: pruned stale dsh-auth cookies (kept ${left === '' ? '0' : left})`)
  } catch (error) {
    note(`${label}: could not prune dsh-auth cookies: ${String(error?.message ?? error)}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let LOG_PATH = ''

const MAX_LOG_BYTES = 1000000

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      try { fs.rmSync(`${file}.1`, { force: true }) } catch { /* ignore */ }
      fs.renameSync(file, `${file}.1`)
    }
  } catch {
    /* no log file yet */
  }
}

/** Append one diagnostic line as UTF-8; never throws. */
function note(line) {
  try {
    rotateLog(LOG_PATH)
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* no log is better than a failed action */
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Blocking sleep for the (synchronous) POSIX kill path; bounded by the caller. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* spin */ }
  }
}

/** Force-end one process. Returns whether the end was confirmed. */
function killPid(pid) {
  // macOS has no taskkill. SIGTERM first so the app can flush its session logs,
  // SIGKILL as the backstop. Callers of this function are synchronous, so the
  // waits block — but they are bounded and short.
  if (!alive(pid)) return true
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!alive(pid)) return true
    try {
      process.kill(pid, signal)
    } catch {
      return !alive(pid)
    }
    for (let i = 0; i < 25 && alive(pid); i += 1) sleepSync(100)
  }
  return !alive(pid)
}

/**
 * Collect the descendants of `root`, skipping the subtrees rooted at
 * `skipRoots` (the Host and the helper itself). Pure function, so the
 * process-tree logic can be self-tested without touching a real app.
 */
function collectTree(rows, root, skipRoots = []) {
  if (!Number.isInteger(root) || root <= 1) return []
  const children = new Map()
  for (const row of rows) {
    const pid = Number(row?.ProcessId)
    const parent = Number(row?.ParentProcessId)
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(pid)
  }
  const skip = new Set((skipRoots ?? []).filter((pid) => Number.isInteger(pid) && pid > 1))
  const seen = new Set()
  const out = []
  const queue = [...(children.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid) || skip.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return out
}

/**
 * Read the live process table once.
 *
 * `comm` is the executable path; its last segment is the image name that
 * `collectOrphans` compares against the Electron main's own name. Without it the
 * sweep cannot tell the app's own renderers from whatever the user started in
 * DSH's terminal, and would end both.
 */
async function listProcesses() {
  const options = {
    encoding: 'utf8',
    timeout: ORPHAN_LIST_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  }
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,comm='], options)
  const rows = []
  for (const line of String(stdout).split('\n')) {
    const parts = line.trim().split(/\s+/u)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    // `comm` is the last column and may contain spaces (an app bundle path), so
    // everything after ppid is the command rather than a fourth field.
    rows.push({ ProcessId: pid, ParentProcessId: ppid, Name: path.basename(parts.slice(2).join(' ')) })
  }
  return rows
}

/**
 * Snapshot the descendants that should be cleaned after the Host exits:
 * - `main`: main-process children except the Host subtree and this helper;
 * - `host`: Host children except this helper.
 * Called while the browser acknowledgement delay runs, so a normal
 * shutdown/restart does not pay an extra fixed wait.
 */
async function collectOrphans(mainPid, hostPid) {
  try {
    const rows = await listProcesses()
    // Only the app's own processes: the Electron main's children that share its
    // image name (renderers, GPU, utility). Anything else is somebody's work.
    const mainName = String(rows.find((row) => Number(row?.ProcessId) === mainPid)?.Name ?? '').toLowerCase()
    const main = collectTree(rows, mainPid, [hostPid, process.pid]).filter((pid) => {
      if (mainName === '') return true
      const row = rows.find((candidate) => Number(candidate?.ProcessId) === pid)
      return String(row?.Name ?? '').toLowerCase() === mainName
    })
    const host = KILL_HOST_CHILDREN ? collectTree(rows, hostPid, [process.pid]) : []
    note(`orphans: snapshot main=${main.length} host=${host.length}${KILL_HOST_CHILDREN ? '' : ' (host children kept)'}`)
    return { main, host }
  } catch (error) {
    note(`orphans: snapshot failed: ${String(error?.message ?? error)}`)
    return { main: [], host: [] }
  }
}

/** End the snapshotted leftovers; keep the Host out of the cleanup. */
async function cleanupOrphans(orphans, label, includeHost = KILL_HOST_CHILDREN) {
  const main = Array.isArray(orphans?.main) ? orphans.main : []
  const host = Array.isArray(orphans?.host) ? orphans.host : []
  if (!includeHost && host.length > 0) {
    note(`${label}: host is still alive; skipping ${host.length} host child(ren)`)
  }
  const pids = [...new Set([...main, ...(includeHost ? host : [])])]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  const live = pids.filter(alive)
  if (live.length === 0) {
    note(`${label}: no orphan processes left`)
    return
  }
  note(`${label}: ending ${live.length} orphan process(es): ${live.join(',')}`)
  let ended = 0
  for (const pid of live) if (killPid(pid)) ended += 1

  // One short retry catches a process that was still tearing down when the
  // signal was delivered. It does not claim to catch detached/new processes.
  await sleep(300)
  const remaining = live.filter(alive)
  if (remaining.length > 0) {
    note(`${label}: retrying ${remaining.length} orphan process(es): ${remaining.join(',')}`)
    for (const pid of remaining) if (killPid(pid)) ended += 1
  }
  const stubborn = live.filter(alive)
  note(`${label}: ended ${ended}/${live.length} orphan process(es)${stubborn.length === 0 ? '' : `; ${stubborn.length} still alive: ${stubborn.join(',')}`}`)
}

/** Pure tree test; run with `helper.cjs --selftest`. */
function selfTest() {
  const rows = [
    { ProcessId: 100, ParentProcessId: 0 },
    { ProcessId: 101, ParentProcessId: 100 },
    { ProcessId: 102, ParentProcessId: 100 },
    { ProcessId: 103, ParentProcessId: 102 },
    { ProcessId: 104, ParentProcessId: 102 },
    { ProcessId: 105, ParentProcessId: 104 },
    { ProcessId: 106, ParentProcessId: 100 },
  ]
  const main = collectTree(rows, 100, [102, 103])
  const host = collectTree(rows, 102, [103])
  const ok = JSON.stringify(main) === '[101,106]' && JSON.stringify(host) === '[104,105]'
  console.log(JSON.stringify({ ok, main, host }))
  return ok
}

/**
 * Unicode path test; run with `helper.cjs --pathtest`.
 * Uses a Chinese + space temp directory, a UTF-8 JSON round-trip, and a
 * spawned executable copied to a Chinese path.
 */
async function pathTest() {
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-power-menu-mac 中文路径 '))
    const jsonPath = path.join(dir, '中文 日志.json')
    const payload = { 中文路径: 'ok', emoji: '🐋' }
    fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8')
    const roundTrip = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

    // A script with a non-ASCII name, inside a non-ASCII directory, run from that
    // directory: the three things the relaunch has to get right on macOS, where
    // paths are UTF-8 but spaces and non-ASCII still break naive shell quoting.
    const scriptPath = path.join(dir, '中文 脚本.command')
    fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', 'utf8')
    fs.chmodSync(scriptPath, 0o755)
    const exited = await new Promise((resolve) => {
      const child = spawn(scriptPath, [], {
        cwd: dir,
        stdio: 'ignore',
      })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    })

    const ok = JSON.stringify(roundTrip) === JSON.stringify(payload) && exited
    console.log(JSON.stringify({ ok, dir, utf8: true, spawnedChineseExe: exited }))
    return ok
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    return false
  } finally {
    if (dir !== '') {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* temp cleanup is best effort */
      }
    }
  }
}

/** Whether something is accepting connections on the loopback port. */
function listening(port) {
  return new Promise((resolve) => {
    let settled = false
    const probe = net.connect({ host: '127.0.0.1', port })
    const finish = (value) => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(value)
    }
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    probe.setTimeout(600, () => finish(false))
  })
}

async function waitFor(predicate, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return await predicate()
}

/**
 * Best-effort alert for the "app did not come back" path.
 *
 * `display alert` through `osascript` needs no automation or accessibility
 * permission — the UI-scripting route (`tell application "System Events"`) does,
 * and would put a consent dialog in front of a user whose app already failed to
 * start. The helper exits immediately, so the alert is spawned detached.
 */
function alertUser(text) {
  try {
    // AppleScript string literals take a backslash escape only for `"` and `\`;
    // newlines are literal, which is what the multi-line messages already are.
    const escaped = String(text).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
    const script = `display alert "DeepSeek Harness" message "${escaped}" as critical`
    const child = spawn('/usr/bin/osascript', ['-e', script], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

async function performShutdown(handoff) {
  note('shutdown: ending the Electron main process (the host will close gracefully)')
  const killed = killPid(handoff.mainPid)
  note(killed ? `shutdown: ended main process ${handoff.mainPid}` : `shutdown: could not end main process ${handoff.mainPid}`)

  const mainGone = await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  note(mainGone ? 'shutdown: main process exited' : `shutdown: main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms`)

  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    const portFree = await waitFor(async () => !(await listening(handoff.port)), HOST_EXIT_TIMEOUT_MS, 300)
    note(portFree ? `shutdown: port ${handoff.port} released` : `shutdown: port ${handoff.port} still held`)
  }

  if (alive(handoff.hostPid)) {
    note(`shutdown: host ${handoff.hostPid} is still alive; ending it`)
    killPid(handoff.hostPid)
  } else {
    note('shutdown: host exited on its own')
  }
  await cleanupOrphans(handoff.orphans, 'shutdown', !alive(handoff.hostPid))
  pruneAuthCookies('shutdown', readLaunchArgs())
  note('shutdown: complete')
}

/**
 * Whether a process has registered with the macOS window server.
 *
 * `lsappinfo find pid=<pid>` answers the application serial number macOS assigns
 * to a process that has connected to the window server — i.e. that it has a UI at
 * all. It answers empty for a process that is running but never got a window
 * (a crash loop, a headless relaunch), which is exactly the case that must not
 * count as a successful restart.
 *
 * It needs no permission: the `osascript` + System Events route does, and would
 * put a consent dialog in front of a user whose app already failed to start.
 *
 * @param {number} pid - the relaunched process.
 * @returns {boolean|null} true when registered, false when not, null when the
 *   probe itself is unavailable (the caller then falls back to liveness alone).
 */
let lsappinfoUnavailable = false
function guiRegistered(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (lsappinfoUnavailable) return null
  try {
    const out = execFileSync('/usr/bin/lsappinfo', ['find', `pid=${pid}`], { encoding: 'utf8', timeout: 2000 })
    return String(out).trim() !== ''
  } catch (error) {
    if (error?.code === 'ENOENT') {
      lsappinfoUnavailable = true
      return null
    }
    return false
  }
}

/**
 * Wait for a real main window instead of treating "process is alive" as
 * success.
 *
 * On macOS the window itself cannot be probed without permissions, but "has
 * registered with the window server" can, and it rules out the failure this
 * check exists for: a relaunch that survives as a process yet never draws a
 * window. Once registered, the process must also stay alive past its own startup
 * grace — the singleton lock means a second instance exits immediately, so
 * surviving that long is the signal that this is the window that was asked for.
 */
async function waitForWindow(pid, timeoutMs = WINDOW_VERIFY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let registeredSince = null
  while (Date.now() < deadline) {
    if (!alive(pid)) return { ok: false, reason: 'process-exited', title: '' }
    // `null` means the probe is unavailable on this machine; liveness alone is
    // then all that can be checked, which is what this used to do everywhere.
    const registered = guiRegistered(pid)
    if (registered === null || registered === true) {
      registeredSince = registeredSince ?? Date.now()
      if (Date.now() - registeredSince >= WINDOW_POLL_MS * 4) return { ok: true, title: '' }
    }
    await sleep(WINDOW_POLL_MS)
  }
  return { ok: false, reason: 'timeout', title: '' }
}

/**
 * 从可执行文件路径反推应用包的 bundle id。
 * `…/Foo.app/Contents/MacOS/Foo` → `…/Foo.app/Contents/Info.plist` → CFBundleIdentifier。
 * 读不到就返回 null，调用方自己决定降级办法。
 */
function bundleIdentifierOf(exe) {
  const resolved = path.resolve(String(exe ?? ''))
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`
  const cut = resolved.indexOf(marker)
  if (cut === -1) return null
  const plist = path.join(resolved.slice(0, cut), 'Contents', 'Info.plist')
  try {
    const out = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const id = out.trim()
    return id === '' ? null : id
  } catch {
    return null
  }
}

/**
 * 应用是否已经重新在跑。
 *
 * 只认 GUI 注册（`lsappinfo`）：helper 自己是同一个二进制以 node 模式跑的，
 * 用 `pgrep -f` 按可执行文件路径找会把它自己也数进去，那样守卫永远为真、
 * 延迟重启永远不拉起。bundle id 从应用包里读，不写死。
 */
function appAlreadyRunning(exe) {
  const bundleId = bundleIdentifierOf(exe)
  if (bundleId !== null) {
    try {
      const out = execFileSync('/usr/bin/lsappinfo', ['find', `bundleid=${bundleId}`], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.includes('ASN:')
    } catch {
      /* lsappinfo 拒绝回答：退到按 argv 判断 */
    }
  }
  try {
    // 主进程的 argv 正好以这个结尾；helper 的 argv 后面还跟着脚本和交接文件。
    execFileSync('/usr/bin/pgrep', ['-f', 'MacOS/DeepSeek Harness$'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * 通过 LaunchServices 拿应用主进程 pid：bundle id → ASN → pid。
 * 读不到（没有 Info.plist、lsappinfo 不可用、应用没注册）就返回 null，交给调用方降级。
 */
function pidFromLaunchServices(exe) {
  const bundleId = bundleIdentifierOf(exe)
  if (bundleId === null) return null
  try {
    const found = execFileSync('/usr/bin/lsappinfo', ['find', `bundleid=${bundleId}`], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const asn = found.match(/ASN:([^"]+)"/u)
    if (asn === null) return null
    const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', `ASN:${asn[1]}`], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pid = Number.parseInt((info.match(/"pid"=(\d+)/u) ?? [])[1] ?? '', 10)
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

/**
 * 当前正在跑的应用主进程 pid，找不到返回 null。
 *
 * 用完整的可执行文件路径加 `$` 锚点：主进程的 argv 恰好就是那个路径，
 * 而 helper 自己的 argv 后面还跟着脚本和交接文件，所以不会匹配到自己。
 */
function currentAppPid(exe) {
  // 首选 LaunchServices：它给出的 pid 是"这个 GUI 应用"的 pid，语义精确，
  // 也不会把 helper 自己（同一个二进制、node 模式，不是 GUI 应用）算进去。
  const viaLaunchServices = pidFromLaunchServices(exe)
  if (viaLaunchServices !== null) {
    note(`pid lookup: LaunchServices -> ${String(viaLaunchServices)}`)
    return viaLaunchServices
  }
  const resolved = path.resolve(String(exe ?? ''))
  const base = path.basename(resolved)
  if (base === '' || base === '.') return null
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  // 先精确匹配整条命令行；匹配不到再只锚定尾部。
  // 有些启动方式把 argv[0] 写成 `…/Contents/Resources/../MacOS/<名字>`，
  // 那时 `^…/Contents/MacOS/<名字>$` 一个都匹配不上，定时会被误判成
  // "应用已经不在了" 而直接放弃 —— 2026-10-30 实测踩过一次。
  const patterns = [`^${escape(resolved)}$`, `MacOS/${escape(base)}$`]
  for (const pattern of patterns) {
    try {
      const out = execFileSync('/usr/bin/pgrep', ['-f', pattern], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const first = out.trim().split('\n')[0]
      const pid = Number.parseInt(first, 10)
      if (Number.isInteger(pid) && pid > 1) {
        note(`pid lookup: matched ${pattern} -> ${String(pid)}`)
        return pid
      }
    } catch {
      /* try the next pattern */
    }
  }
  note(`pid lookup: no match for ${resolved}`)
  return null
}

async function performRestart(handoff) {
  note('restart: ending the Electron main process (the host will close gracefully)')
  const killed = killPid(handoff.mainPid)
  note(killed ? `restart: ended main process ${handoff.mainPid}` : `restart: could not end main process ${handoff.mainPid}`)

  const mainGone = await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  note(mainGone ? 'restart: main process exited' : `restart: main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms`)

  let portFree = true
  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    portFree = await waitFor(async () => !(await listening(handoff.port)), PORT_FREE_TIMEOUT_MS, 300)
    note(portFree ? `restart: port ${handoff.port} released` : `restart: port ${handoff.port} still held`)
    if (!portFree) {
      if (alive(handoff.hostPid)) {
        note(`restart: host ${handoff.hostPid} still holds the port; ending it as a last resort (session logs may be incomplete)`)
        killPid(handoff.hostPid)
        await sleep(1500)
      }
      portFree = await waitFor(async () => !(await listening(handoff.port)), 5000, 300)
    }
  }

  // Give the socket and the filesystem a moment to settle before relaunching.
  await cleanupOrphans(handoff.orphans, 'restart', !alive(handoff.hostPid))
  await sleep(portFree ? 800 : 1500)

  // The app is gone, so its cookie jar is free to edit. Prune the accumulated
  // dsh-auth cookies before the new instance reads them (see pruneAuthCookies).
  const relaunchArgs = readLaunchArgs()
  pruneAuthCookies('restart', relaunchArgs)

  // 延迟重启：cookie 在 app 退出的瞬间就清完了，这里才开始慢慢等。
  // 等待期间用户很可能自己把 DSH 打开 —— 应用没有单实例锁，到点再 spawn 就会
  // 多出一个窗口和一个 Host，所以拉起前必须确认它还没在跑。
  const relaunchDelayMs = Number.isFinite(handoff.relaunchDelayMs) && handoff.relaunchDelayMs > 0
    ? handoff.relaunchDelayMs
    : 0
  if (relaunchDelayMs > 0) {
    note(`restart: waiting ${Math.round(relaunchDelayMs / 1000)}s before the relaunch`)
    await sleep(relaunchDelayMs)
    if (appAlreadyRunning(handoff.exe)) {
      note('restart: the app is already running again; skipping the scheduled relaunch')
      return
    }
    note('restart: delay elapsed, relaunching now')
  }

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'DSH_DESKTOP_NODE_EXECUTABLE') delete env[key]
  }

  const rawExe = String(handoff.exe ?? '').trim()
  if (rawExe === '') {
    note('restart: no executable in the handoff; aborting')
    alertUser('重启失败：交接信息里没有应用路径。请手动启动 DeepSeek Harness。')
    return
  }

  // An app bundle path contains spaces ("DeepSeek Harness.app/Contents/MacOS/…"),
  // so the path stays a single argv value and is never turned into a shell
  // command string. `spawn` with `detached` also starts the app as its own
  // process group, so it outlives this helper.
  const exe = path.resolve(rawExe)
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    note(`restart: executable does not exist: ${exe}`)
    alertUser(`重启失败：找不到应用路径。\n\n${exe}\n\n请手动启动 DeepSeek Harness。`)
    return
  }
  const exeDir = path.dirname(exe)

  let childPid = null
  for (let attempt = 1; attempt <= RELAUNCH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      note(`restart: attempt ${attempt}/${RELAUNCH_ATTEMPTS} in 1500ms`)
      await sleep(1500)
    }
    let child = null
    try {
      child = spawn(exe, relaunchArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: exeDir,
        env,
      })
      child.on('error', (error) => note(`restart: spawn error: ${String(error?.message ?? error)}`))
      child.unref()
      note(`restart: relaunched ${exe} as pid ${String(child.pid)}`)
    } catch (error) {
      note(`restart: spawn threw: ${String(error?.stack ?? error)}`)
      continue
    }

    const result = await waitForWindow(child.pid, WINDOW_VERIFY_TIMEOUT_MS)
    if (result.ok) {
      note(`restart: new process ${String(child.pid)} has a window`)
      childPid = child.pid
      break
    }
    note(`restart: window not ready: ${result.reason} (attempt ${attempt})`)
    if (result.reason === 'timeout') break
  }

  if (childPid === null) {
    note('restart: application did not come back with a usable window')
    const shown = alertUser(`重启失败：DeepSeek Harness 没有出现可用的主窗口。\n\n请手动启动应用。\n日志：${LOG_PATH}`)
    note(shown ? 'restart: failure notice dispatched' : 'restart: could not dispatch the failure notice')
    return
  }

  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    // The desktop app binds a fresh random port on every launch (`--port 0`),
    // so waiting for the NEW instance to take the OLD port would always time
    // out; the window check above is the meaningful readiness signal.
    note(`restart: old port ${handoff.port} is no longer relevant; the new instance picks its own port`)
  }
  note('restart: complete')
}

async function main() {
  if (process.argv[2] === '--selftest') {
    process.exit(selfTest() ? 0 : 1)
  }
  if (process.argv[2] === '--windowtest') {
    const pid = Number(process.argv[3])
    const timeout = Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 5000
    const result = await waitForWindow(pid, timeout)
    console.log(JSON.stringify(result))
    process.exit(result.ok ? 0 : 1)
  }
  if (process.argv[2] === '--pathtest') {
    const ok = await pathTest()
    process.exit(ok ? 0 : 1)
  }
  if (process.argv[2] === '--snapshot') {
    const mainPid = Number(process.argv[3])
    const hostPid = Number(process.argv[4])
    const snapshot = await collectOrphans(mainPid, hostPid)
    console.log(JSON.stringify(snapshot))
    return
  }
  if (process.argv[2] === '--plan' || process.argv[2] === '--dryrun') {
    const planPath = process.argv[3]
    let handoff = null
    const reasons = []
    if (typeof planPath !== 'string' || planPath === '') {
      reasons.push('missing handoff path')
    } else {
      try {
        handoff = JSON.parse(fs.readFileSync(planPath, 'utf8'))
      } catch (error) {
        reasons.push(`cannot read handoff: ${String(error?.message ?? error)}`)
      }
    }
    if (handoff !== null) {
      if (handoff.mode !== 'shutdown' && handoff.mode !== 'restart') reasons.push(`invalid mode: ${String(handoff.mode)}`)
      if (!Number.isInteger(handoff.mainPid) || handoff.mainPid <= 1) reasons.push('invalid mainPid')
      if (!Number.isInteger(handoff.hostPid) || handoff.hostPid <= 1) reasons.push('invalid hostPid')
      const exe = typeof handoff.exe === 'string' ? path.resolve(handoff.exe) : ''
      if (exe === '' || !fs.existsSync(exe) || !fs.statSync(exe).isFile()) reasons.push(`missing executable: ${exe || '(empty)'}`)
      if (!fs.existsSync(__filename)) reasons.push(`missing helper: ${__filename}`)
      const logPath = typeof handoff.logPath === 'string' && handoff.logPath !== ''
        ? handoff.logPath
        : path.join(path.dirname(planPath), 'helper.log')
      console.log(JSON.stringify({
        ok: reasons.length === 0,
        mode: handoff.mode,
        mainPid: handoff.mainPid,
        hostPid: handoff.hostPid,
        exe: exe || String(handoff.exe ?? ''),
        port: handoff.port ?? null,
        logPath,
        helper: __filename,
        reasons,
      }, null, 2))
    } else {
      console.log(JSON.stringify({ ok: false, reasons }, null, 2))
    }
    process.exitCode = reasons.length === 0 ? 0 : 1
    return
  }

  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') process.exit(1)

  let handoff
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))
  } catch {
    process.exit(1)
  }

  LOG_PATH = typeof handoff.logPath === 'string' && handoff.logPath !== ''
    ? handoff.logPath
    : path.join(path.dirname(handoffPath), 'helper.log')

  note(`helper started: helper=${process.pid} host=${String(handoff.hostPid)} main=${String(handoff.mainPid)} mode=${String(handoff.mode)}`)

  try {
    if (!Number.isInteger(handoff.mainPid) || handoff.mainPid <= 1) {
      note('refusing: the handoff carries no usable main process id')
      return
    }
    // 定时动作：先什么都不做，等够时间再动手。等待期间应用可能被手动关掉或重启过
    // —— 那时这条定时就已经作废了，绝不能拿一个旧的 pid 去动已经不是它的进程。
    const preDelayMs = Number.isFinite(handoff.preDelayMs) && handoff.preDelayMs > 0 ? handoff.preDelayMs : 0
    if (preDelayMs > 0) {
      note(`scheduled: waiting ${Math.round(preDelayMs / 1000)}s before acting`)
      await sleep(preDelayMs)
      const pid = currentAppPid(handoff.exe)
      if (pid === null) {
        note('scheduled: the app is not running any more; dropping the schedule')
        return
      }
      if (pid !== handoff.mainPid) {
        note(`scheduled: the app was restarted (pid ${String(pid)} != ${String(handoff.mainPid)}); dropping the stale schedule`)
        return
      }
      note('scheduled: delay elapsed, acting now')
    }
    // Snapshot while the browser-acknowledgement delay runs; the collection
    // normally finishes well inside that window.
    const orphansPromise = collectOrphans(handoff.mainPid, handoff.hostPid)
    await sleep(Number.isFinite(handoff.delayMs) && handoff.delayMs > 0 ? handoff.delayMs : 1200)
    handoff.orphans = await orphansPromise
    if (handoff.mode === 'restart') await performRestart(handoff)
    else await performShutdown(handoff)
  } catch (error) {
    note(`helper failed: ${String(error?.stack ?? error)}`)
  } finally {
    try {
      fs.unlinkSync(handoffPath)
    } catch {
      /* already gone */
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0
  })
}
