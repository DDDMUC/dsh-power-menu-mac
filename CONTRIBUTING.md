# Contributing

Thanks for taking a look at `dsh-power-menu-mac`! This is a small, macOS-only DSH
Desktop plugin — a port of [xichen-62/dsh-power-menu](https://github.com/xichen-62/dsh-power-menu)
(Windows). Bug reports and focused pull requests are welcome.

## Before you start

- The plugin targets **macOS + DSH Desktop**. `dsh web` is explicitly
  unsupported and the routes return `409` there. Windows support lives in the
  upstream package, not here — please do not add `taskkill` / PowerShell paths
  back into this one.
- There is **no build step** and **no runtime npm dependency**. `lib/` is shipped
  as-is.
- The client half is not an ES module. It must stay in the
  `window.__ModuleLoader__.load({ id, factory })` format used by DSH's client
  module loader.
- Destructive actions are intentional: the two menu items quit the app without
  an extra confirmation dialog. Please do not add a second confirm without a
  design discussion.

## Development setup

```bash
git clone https://github.com/DDDMUC/dsh-power-menu-mac.git
cd dsh-power-menu-mac
npm run check
```

To load it into a local DSH Desktop profile, see
[README → 方式 C：本地开发安装](README.md#方式-c本地开发安装).

## Pull requests

- Keep the change focused; one behavior per PR.
- Run `npm run check` before committing.
- Update `CHANGELOG.md` under `## [Unreleased]` for user-visible changes.
- If you touch the handoff/relaunch logic, describe how you tested it on a real
  DSH Desktop instance. This code path ends the running app, so "it compiles"
  is not enough.
- Do not add telemetry, outbound requests, or credentials.

## Security

Please report vulnerabilities privately, per [SECURITY.md](SECURITY.md), rather
than in a public issue.

## License

By contributing, you agree that your contribution is licensed under the MIT
License (see [LICENSE](LICENSE)).
