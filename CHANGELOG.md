# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

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
