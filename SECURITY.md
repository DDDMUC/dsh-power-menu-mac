# Security Policy

## Supported versions

The latest `0.1.x` release is supported with security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version, and a minimal reproduction.

You can expect an acknowledgement within a few days. Please give the maintainer
a reasonable window to ship a fix before public disclosure.

## Scope notes

`dsh-power-menu` exposes three destructive HTTP routes on the local DSH host:

```text
POST /api/dsh-power-menu/shutdown
POST /api/dsh-power-menu/restart
GET  /api/dsh-power-menu/health
```

The routes are intentionally fenced to:

- loopback clients only (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`);
- a loopback `Host` header (DNS-rebinding defense);
- no `sec-fetch-site: cross-site`;
- an `Origin` equal to the serving host when an `Origin` is present.

They deliberately do **not** accept requests from other machines or from
cross-site pages. Bypassing that fence is a security issue and should be
reported privately.

The plugin does not collect telemetry, does not make outbound network calls,
and does not write outside `%USERPROFILE%\.dsh\dsh-power-menu\` and the DSH
profile directory used for installation.
