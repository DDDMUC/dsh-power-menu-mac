# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [0.1.3] - 2026-10-30

### Added

- 菜单里新增 **刷新页面**：只重载渲染层，应用、Host、会话和正在跑的轮次都不受影响。之前想刷新只能重启整个应用，而重启一次就会多下发一条 `dsh-auth-<随机>` cookie —— 正是 0.1.2 修的那个 16 KB 请求头上限的成因。现在刷新不必再走重启。
- 菜单里新增 **N 分钟后重启**：现在关掉，隔 N 分钟再拉起。N 在 `~/.dsh/dsh-power-menu-mac/config.json`（默认 10 分钟，允许 1–1440），菜单文案跟着配置走，改完打开菜单即生效。cookie 在 app 退出那一刻就清掉，不会等到 N 分钟之后；拉起前用 `lsappinfo` 确认应用没在跑，避免等待期间你手动打开 DSH 后到点又多开一个（应用本身没有单实例锁）。

### Changed

- 菜单项改成按破坏性从小到大排列：**刷新页面 → 重启DSH → N 分钟后重启 → 关闭DSH**。误触最多落到刷新，不会落到关闭。
- 菜单项新增契约属性 `data-dsh-power-action="refresh"` / `"restart-delayed"`，与已有的 `restart` / `shutdown` 一致。

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
