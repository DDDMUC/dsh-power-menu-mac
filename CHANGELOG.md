# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [0.1.3] - 2026-10-30

### Added

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
