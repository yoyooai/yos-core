# YOS Changelog

All notable changes to YOS are recorded here from the point at which the independent YOS product baseline was established.

## Unreleased

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
