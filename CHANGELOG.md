# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [0.2.1] - 2026-11-13

### Added

- **悬停即展开，无需点击**：鼠标移到电源按钮上面板就出现，移开自动收起；按钮与菜单之间留 220ms 过渡，不会一离开就闪没。点击仍会把焦点交给按钮，`↑` / `↓` / `Enter` 键盘操作照旧；弹窗或执行遮罩期间不误展开。组件卸载时会清掉尚未触发的关闭定时器。README 中英文同步说明。

## [0.2.0] - 2026-11-12

### Changed

- **重启从 7.3 秒降到 4.4 秒**（优化前 151 次样本中位数 → 优化后真实重启实测）。`lib/index.js` 写进 handoff 的 `delayMs` 从 1200ms 降到 300ms，helper 的前置等待与孤儿进程快照并行；端口确认释放后的固定等待从 800ms 降到 150ms；窗口验证从「500ms 轮询 × 4 = 2000ms 宽限」改成 250ms 轮询 + 1000ms 宽限。1 秒宽限保留——单实例锁会让重复实例立刻退出，活过它才是不把白屏/秒退报成成功的关键。
- **README / About 把「清理旧的 `dsh-auth-*` cookie」提到最前面作为第一卖点**：71 条 → 16 KB 请求头 → 431 → `Web authentication failed`，而电源菜单让重启变便宜、反而加速了这个失败。窗口服务器验证降为第二卖点。
- README 头部加 npm 版本 / 周下载 / GitHub stars / license 四个 badge 和中英双语 Star 提示。

## [0.1.8] - 2026-11-06

### Changed

- **README 不再说「装完必须跑 `enable.sh`，否则按钮 404」。** 那句话在当前宿主上已经不成立：安装时宿主会自己把声明了 `dsh.bundle` 的依赖写进 `dsh.profile.bundles`——应用内走 `selectBundle(name, true)`，CLI 的 `dsh plugin install` 走 `reconcile()`。我在 0.2.1-rc.5 和 0.2.2-rc.1 两份 `dsh-plugin-manager/lib/index.js` 里都核对过（前者 `selectBundle` 调用在 2092 行、`reconcile` 在 763 行；后者在 2860 行与 865 行）。原来那句会把想从商店一键安装的人劝退，现在改成「`enable.sh` 只在更早的宿主或手动 `pnpm add` 之后才需要，脚本幂等，多跑一次无害」。404 排障那一节同步改了。

## [0.1.7] - 2026-11-05

### Added

- **`dsh.bundle.platforms: ["darwin"]`**。宿主在**安装前**读的是这个字段（官方目录里用它做离线发现和平台检查），`os` 只在 pnpm 那一层拦。只写 `os` 时，Linux 用户从商店点安装会先拿到 pnpm 的 `EBADPLATFORM`，而不是宿主的 `unsupported-platform`。两个都写，报错才落在宿主那边、文案才是「这个插件不支持你的平台」。

### Changed

- **描述改成「只在本机回环地址上应答」**。这个包自己不 listen 端口，是在 `ctx.webServer` 上注册 `/api/dsh-power-menu-mac` 前缀路由，再由 `trusted()` 逐请求校验 `remoteAddress`、`Host`、`Origin`、`sec-fetch-site`。原来的「只监听回环地址」把机制说错了，`package.json` 的 `description` 和 README 都改了。
- README 补两条以前只写在代码注释里的行为：重启/关闭前会把 `dsh-auth-*` cookie 修剪到最近三条（不修剪会撞 16 KB 请求头上限），以及 `apply` 会注入一段全局 `systemPrompt`。

## [0.1.6] - 2026-11-04

### Changed

- **去掉常驻横幅**（0.1.5 刚加的）：它太吵，而且不是必要手段。改成**按下刷新快捷键的那一刻按需检查**——`Cmd/Ctrl+R`、`F5` 会先比一次 bundle 版本，有变化就弹确认框，没变化照常刷新。这样反而更准：不再有"最多 30 秒"的空窗，也不需要在界面上常驻一条警告。
- `beforeunload` 保留：菜单栏、地址栏、右键菜单触发的刷新接不到 keydown，只能靠它兜底。

## [0.1.5] - 2026-11-04

### Added

- **刷新前先劝你去重启。** 插件的 `client.js` 在应用运行期间被改过时，刷新渲染层会让它加载失败（宿主在**启动时**生成 manifest，每个 bundle 的 revision 记在里面，刷新只重载渲染层、不重算 manifest），症状是一行 `1 entry did not activate` 加一个 `import failed`，只能 `Cmd+Q` 重开。现在三处一起挡：
  - **常驻横幅**：每 30 秒、以及窗口重新获得焦点时各比一次 bundle 版本，发现漂移就在顶部挂一条「插件代码已变（N 个），刷新会让它们加载失败。请退出应用重开」，带「重启应用」按钮。这是主要手段——看到就不会去刷新了。
  - **快捷键拦截**：漂移时 `Cmd/Ctrl+R`、`F5` 改弹原来的确认框（重启 / 仍然刷新 / 取消），不再静默刷新。
  - **`beforeunload`**：菜单栏、地址栏、右键菜单触发的刷新接不到 keydown，用这道兜底。

## [0.1.4] - 2026-11-01

### Added

- **支持 `dsh web` 部署**。之前只认桌面版（`desktopTarget()` 要求父进程是 Electron 主进程），在 `dsh web` 上按钮要么不出现、要么点了 409。现在同一个包在 web 上也工作：
  - 目标是 **host 自己**（`process.pid`），不是某个上层应用。
  - 「关闭」：有 launchd 作业就 `launchctl bootout`（真关掉，不会被 `KeepAlive` 立刻拉回来），没有就直接结束进程。
  - 「重启」：有 launchd 就 `kickstart -k` 交给它；没有就自己杀掉、等端口释放、用**原来的 argv 和工作目录**重新 spawn。
  - 两种重启都会从新进程的输出里抓 `dsh web: http://…?token=…`，然后 `open` 到默认浏览器——**每次启动 token 都会换**，不自动打开的话用户只能自己去日志里翻。无头部署可设 `DSH_POWER_MENU_NO_OPEN=1` 关掉。
  - `GET /health` 现在返回 `{desktop, web, supervised}`；web + 有 supervisor 时，弹窗里那条「现在关闭，N 分钟后启动」会收起（杀掉会被 launchd 立刻拉回来，helper 再 spawn 会抢端口）。

### Fixed

- **桌面版和 `dsh web` 跑的是同一个 `cli.js`**，原来的 `desktopTarget()` 只看 `ELECTRON_RUN_AS_NODE` 和父进程 pid，从终端起 `dsh web` 时会把那个 shell 当成 Electron 主进程——一点重启就把终端杀了。现在改为认 `DSH_DESKTOP_NODE_EXECUTABLE`（桌面版只给自己的 host 设）并比对父进程可执行文件。
- **`XPC_SERVICE_NAME` 会一路继承**，不能拿它判断"被 launchd 管着"。现在会回查 `launchctl print` 里那个作业的 pid 是不是本进程。
- **launchd plist 在真实用户目录**，而 web 部署常改 `HOME`；原来用 `os.homedir()` 会找错地方，supervised 重启抓不到新链接。改用 `os.userInfo().homedir` 优先。

## [0.1.3] - 2026-10-30

### Added

- **支持 `dsh web` 部署**。之前只认桌面版（`desktopTarget()` 要求父进程是 Electron 主进程），在 `dsh web` 上按钮要么不出现、要么点了 409。现在同一个包在 web 上也工作：
  - 目标是 **host 自己**（`process.pid`），不是某个上层应用。
  - 「关闭」：有 launchd 作业就 `launchctl bootout`（真关掉，不会被 `KeepAlive` 立刻拉回来），没有就直接结束进程。
  - 「重启」：有 launchd 就 `kickstart -k` 交给它；没有就自己杀掉、等端口释放、用**原来的 argv 和工作目录**重新 spawn。
  - 两种重启都会从新进程的输出里抓 `dsh web: http://…?token=…`，然后 `open` 到默认浏览器——**每次启动 token 都会换**，不自动打开的话用户只能自己去日志里翻。
  - `GET /health` 现在返回 `{desktop, web, supervised}`；web + 有 supervisor 时，弹窗里那条「现在关闭，N 分钟后启动」会收起（杀掉会被 launchd 立刻拉回来，helper 再 spawn 会抢端口）。
- **刷新前会先检查插件文件有没有变**。DSH 的 bundle 按 revision 发布且不可变，文件一改，页面手里的旧 revision 就会被拒绝——刷新换来的是一整页「请关闭应用并重新安装」。现在点刷新会先比对 `GET /bundles` 给出的各插件 `mtime:size` 快照：没变就正常刷新；变了就弹框列出改动的插件，给「重启 / 仍然刷新 / 取消」三个选择。宿主判断不了（不在 profile 目录里、请求失败）时不拦，直接刷新。
- **按钮在所有页面都能用了**。之前它被塞进会话标题栏的角标容器 `[data-conversation-header-corner]`，那个容器只在会话页存在，所以插件页、自动化任务页这些地方一个按钮都没有。现在检测不到可见的会话头时，按钮改为固定在窗口右上角（`position: fixed`），换页、改尺寸、切回会话都会重新判定。
- 插件管理页里这一行现在有**配置控件**，打开是插件自己的配置页（`#/panel/plugins/dsh-power-menu-mac/dsh-power-menu-mac`）：分钟数、提示词开关、自定义文本三样都能在界面上改，点「保存」才写盘。走 `plugins.row.config` slot（key 为 `<包名>#<行 id>`），客户端因此多注入一个 `@deepseek-ai/dsh-client-ui-plugin-manager`。提示词输入框预填默认那句（不再留空），与默认一字不差时由宿主收敛成空串，语义仍是「继续跟随默认」。
- 宿主新增 `POST /api/dsh-power-menu-mac/config`：校验 1–1440、文本截断到 2000 字、原子写回 `config.json`，并回读归一化后的结果。
- 插件现在会向系统提示词注入一段说明：DSH 的重启与关闭由用户自己通过电源菜单完成，不要询问、也不要主动提议。声明了 `systemPrompt` 依赖，只在桌面宿主渲染（`dsh web` 上返回空串，整段丢弃）。**这是本插件第一次改变模型行为，不只是 UI**；范围刻意写窄到「重启/关闭 DSH」这一件事，避免压住其他正常询问。
- 这段提示词可以关也可以换：`config.json` 里 `restartGuidance: false` 不注入，`restartGuidanceText` 填自己的话就替换默认文本（上限 2000 字，超出截断并记日志）。配置每次渲染都重新读，改完下一个请求生效，不用重启。
- 菜单里新增 **刷新页面**：只重载渲染层，应用、Host、会话和正在跑的轮次都不受影响。之前想刷新只能重启整个应用，而重启一次就会多下发一条 `dsh-auth-<随机>` cookie —— 正是 0.1.2 修的那个 16 KB 请求头上限的成因。现在刷新不必再走重启。
- 菜单里新增 **定时…** 居中弹窗：填分钟数后三选一 ——「N 分钟后关闭」「N 分钟后重启」「现在关闭，N 分钟后启动」。前两种到点前 DSH 照常用，第三种立刻关、过 N 分钟自己回来。弹窗会显示换算出的执行时刻，打开时焦点已在输入框、直接打字就能改，有定时在等时多一行「取消已设定的定时」；Esc 或点背景关闭。
- 排定定时后**按钮正下方出现一个倒计时胶囊**：「3:43 后关闭」，每秒跳，右侧 × 直接取消；菜单或弹窗打开时让位。电源按钮右上角另有一个小圆点。
- 排定定时后**电源按钮右上角出现一个小圆点**，菜单项显示「定时（3:43 后关闭）」并每秒跳秒（剩余时间由 `scheduled.at` 本地推算，只在有定时时开定时器）。页面刷新后靠 `GET /config` 恢复。`POST /schedule` 与 `POST /cancel` 的响应现在带回 `scheduled`，客户端不必等下次开菜单才更新。
- 到点确认应用还在时，改用 LaunchServices 拿 pid（bundle id → ASN → pid），失败再退到两级 `pgrep`（先精确、再只锚定尾部）。原来只用精确锚点，遇到 argv[0] 写成 `…/Contents/Resources/../MacOS/<名字>` 的启动方式会一个都匹配不上，定时被误判成「应用已经不在跑」而直接放弃。
- 立即操作如果 30 秒还没把应用带走（kill 被拒、helper 早退等），自动放开 `pending` 闩并记日志，不再让之后每一次操作都 409。
- 定时等待期间如果应用被手动关掉或重启过，这条定时自动作废（按 pid 比对），不会拿旧 pid 去动一个已经不是它的进程。
- 「现在关闭，N 分钟后启动」在拉起前用 `lsappinfo` 确认应用没在跑，避免等待期间你手动打开 DSH 后到点又多开一个（应用本身没有单实例锁）。cookie 在 app 退出那一刻就清掉，不会等到 N 分钟之后。

### Changed

- 菜单项改成按破坏性从小到大排列：**刷新 → 重启 → 定时 → 关闭**。误触最多落到刷新，不会落到关闭。四项文案都去掉了多余的字和省略号（原「刷新页面」「重启DSH」「关闭DSH」「定时…」）。
- 契约属性：`refresh` / `restart` / `schedule` / `shutdown`，面板内是 `schedule-shutdown` / `schedule-restart` / `schedule-restart-delayed` / `cancel-schedule`。
- `config.json` 的 `delayedRestartMinutes` 现在是定时面板输入框的默认值（面板里可以每次临时改）。

## [0.1.2] - 2026-10-29

### Fixed

- 重启 / 关闭时顺手把攒下来的 `dsh-auth-*` cookie 删到只剩最近 3 条。宿主每次启动都会下发一个**新名字**的 `dsh-auth-<随机>` cookie 且从不清理，而 cookie 不区分端口，所有端口上的宿主共用同一批；攒到 71 条时 `Cookie` 请求头就有 16.1 KB，越过 Node 默认的 16 KB 请求头上限，桌面版启动直接报 `desktop welcome: Web authentication failed`（2026-10-29 实测；用电源菜单反复重启会加速这个过程）。清理在 app 退出之后、重启之前进行，用 macOS 自带的 `/usr/bin/sqlite3` 改 Chromium 的 `Cookies` 库；只保留最近 3 条而不是全删，是为了不把同机另一个长期运行的 `dsh web`（浏览器里那个界面）当场登出。

## [0.1.1] - 2026-10-29

### Fixed

- 打开菜单不再把焦点放进第一项。第一项是「关闭DSH」，焦点落上去之后误按一个回车/空格就会把应用关掉。焦点现在留在触发按钮上；ArrowDown / ArrowUp / Home / End 仍然能进菜单（由触发按钮转发给菜单的键盘处理），Esc 照旧关闭。
- 打开菜单时显式把焦点收回触发按钮。有些 WebKit 表面里点按钮不会自动聚焦，否则会出现「菜单开了但方向键没反应」。

### Added

- 菜单按钮上的契约属性：`data-dsh-power-action="shutdown"` / `data-dsh-power-action="restart"`。`MenuItem` 现在把多余 props 透传给底层 `button`，选择器和自动化检查可以直接按动作定位，不用匹配标签文字。

## [0.1.0] - 2026-10-26

首个 macOS 版本。基于 [xichen-62/dsh-power-menu](https://github.com/xichen-62/dsh-power-menu) 0.1.18（MIT）移植。

### Changed

- 宿主侧改成 POSIX：结束进程从 `taskkill /PID x /F` 改为 `SIGTERM`（必要时 `SIGKILL`）；读进程表从 PowerShell `Get-CimInstance Win32_Process` 改为 `ps -A -o pid=,ppid=,comm=`；失败提示从 PowerShell 消息框改为 `osascript display alert`（不需要辅助功能授权）。
- 去掉 Windows 专属的「中文路径 cmd.exe 拷贝」自检，改成在「中文 + 空格」目录里启动一个中文名脚本。
- 接口前缀 `/api/dsh-power-menu/*` → `/api/dsh-power-menu-mac/*`；状态目录 `~/.dsh/dsh-power-menu/` → `~/.dsh/dsh-power-menu-mac/`，可与原版同时安装而不打架。
- 安装脚本从 403 行 PowerShell（`install.ps1` / `enable.ps1`）改为 POSIX shell（`install.sh` / `enable.sh`）。不再需要 MinGit、不改 PATH、不处理 junction；会自动去 `.app` 包里找 `dsh` CLI。
- 许可证保留原版权声明，并叠加本项目版权。

### Fixed

- **macOS 上的孤儿清理其实没生效**：`ps` 分支原来只读 `pid` 和 `ppid`，不返回进程名，于是「只清理本应用自己的进程」那道按镜像名过滤的判断在 macOS 上等于没有 —— 会把 Electron 主进程的所有子进程都算进来。现在读 `comm` 取 basename，过滤真的生效。

### Added

- **重启验证**：新进程必须注册到 macOS 窗口服务器（`lsappinfo find pid=<pid>`）并活过启动宽限期才算成功。原版在 macOS 上只能检查「进程还活着」，白屏或崩溃循环会被误判为成功。
- **平台门控**：`package.json` 声明 `os: ["darwin"]`；客户端在非 macOS 上直接不加载，不画一个点了没反应的按钮。

## 上游历史

0.1.18 及之前的所有版本属于 [xichen-62/dsh-power-menu](https://github.com/xichen-62/dsh-power-menu)（Windows 版），其更新日志见该仓库的 `CHANGELOG.md`。本仓库的版本号从 0.1.0 重新开始。
