# YOS Changelog

All notable changes to YOS are recorded here from the point at which the independent YOS product baseline was established.

## Unreleased

## [0.1.0-alpha.4] - 2026-08-05

Found by blocking every GitHub host and installing from zero. The result was not
a slow install but three hard failures, so a customer whose network cannot reach
GitHub — measured from a mainland-China host the same day: raw.githubusercontent
8/8 timeouts, `git clone` failing 2 of 3 attempts at 45s — could not install YOS
at all, roughly half the time.

### Added

- A distribution mirror on our own domain now serves every artifact an install
  needs: the release metadata, the packaged release, component archives, the
  installer itself, the Node.js bootstrap and the prebuilt native binaries.
  GitHub remains the source of record and is still used as a fallback, which
  announces itself instead of failing quietly. `scripts/build-dist.mjs` builds
  the mirror and refuses to publish an incomplete one.
- `YOS_DIST_BASE` points the CLI and the installer at a different mirror;
  setting it empty restores the previous GitHub-only behavior. `YOS_DIST_ONLY=1`
  proves an operation needs nothing but the mirror.

### Fixed

- `install.sh` resolved the release tag inside a command substitution under
  `set -e`. When GitHub was unreachable it exited with status 7 and printed
  nothing at all — no error, no hint. It now reports what it could not reach and
  what to do about it.
- Node.js was bootstrapped through nvm, whose installer is hosted on
  raw.githubusercontent and then clones from GitHub, so it could never bootstrap
  a machine without GitHub access. A pinned Node.js is downloaded from a
  reachable mirror and verified against its published SHA-256 instead.
- better-sqlite3, required by comm-bridge, scheduler and web-console, fetched
  its prebuilt binary from GitHub releases. With GitHub unreachable it fell
  through to `node-gyp rebuild` and failed for want of Python, so those three
  could not be installed at all. Prebuilt binaries are now fetched from the
  mirror, for every Node.js version the installer accepts.
- `yos upgrade`'s periodic check reached GitHub with `git ls-remote` and spent
  its whole timeout on a host that cannot reach it, reporting every component as
  un-checkable.
- The Caddy binary and its version came from GitHub, so `yos init --https` could
  not complete without it.
- `yos add` printed "installed successfully!" directly beneath a red line saying
  the component's service does not stay running. It now says which of the two
  happened.
- An install whose registration write failed left the component on disk but
  unrecorded, and every later `yos add` refused to continue because the skill
  directory already existed. The install is now undone, and the message says
  what to check.

## [0.1.0-alpha.3] - 2026-08-05

Found by installing 0.1.0-alpha.2 on clean machines and handing the Weixin login
to a person on another continent from the server.

### Fixed

- `yos add` reported a component's service as started when pm2 had merely
  accepted the start. A component missing its credentials exits at once and is
  restarted forever, so the install said "started" while a loop burned in the
  background — one service reached 371 restarts under that report. The service is
  now watched briefly after starting, and a process that does not stay up is
  reported as such, with the command that shows why and what to do next.
- Every command failure printed the whole error object, so the one sentence that
  mattered sat under a dozen frames of node internals. Failures now lead with the
  message and the path; `YOS_DEBUG=1` restores the stack.

Still an alpha: no installation has been run for a full day, and the Weixin
channel has not completed a real-person QR login.

### Added

- A component can be installed from a subdirectory of a repository, so several
  components can share one repository. Each keeps its own version line through
  a tag prefix (`feishu-v…`, `weixin-v…`), and download, install, upgrade,
  `doctor` and `search` all stay scoped to the component's own directory.
- `yos add <name>` without a version falls back to the newest prerelease when a
  component has no stable release yet, and says so. A stable release always
  wins, so a prerelease cannot displace one.

### Changed

- The repositories moved to the `yoyooai` organisation: `yoyooai/yos-core` and
  `yoyooai/yos-components`. GitHub redirects the previous addresses, but the
  registry and the installer now name where things actually live.
- `scripts/install.sh` carries the release repository as its default, so the
  copy served from the download page is a byte-identical copy of this file
  rather than differing from it by one line.

### Fixed

- The installer decided whether a terminal was reachable by testing that
  `/dev/tty` exists. That device node is always present, so with no controlling
  terminal — CI, cloud-init, ansible, `nohup` — the test passed and the read
  that followed failed: the consent prompt aborted the install outright, and
  the `yos init` hand-off was skipped while the installer still printed
  "Installation complete!" and exited 0. A single probe now decides it, and an
  init that does not finish makes the installer fail.
- `yos add` failed with a raw `ENOENT` when `~/yos/.yos` did not exist — an
  install with `--no-init`, or an init that did not finish. The component was
  already on disk by then, so it was installed but unrecorded, and the retry
  refused to continue because the skill directory existed.
- `yos logs activity` and `yos logs scheduler` resolved to `activity-log.txt` and `scheduler-log.txt`, which no service ever writes, so the default `yos logs` always reported "Log file not found". `activity` now reads the activity monitor's own log and `scheduler` reads the output PM2 captures for it.
- `yos upgrade --self --check` printed the raw `release_source_not_configured` token when no release source was configured. It now reports which variable to set.

## [0.1.0-alpha.1] - 2026-08-03

This is an internal engineering milestone for continued YOS development, not a customer release.

### Changed

- Established the verified v0.6.0 engineering baseline from an authorized upstream product.
- Added dependency security fixes, deterministic tests and a reproducible verification gate.
- Started the user-facing YOS brand separation while retaining runtime compatibility.
