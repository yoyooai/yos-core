# YOS Changelog

All notable changes to YOS are recorded here from the point at which the independent YOS product baseline was established.

## Unreleased

## [0.1.11] - 2026-08-08

### Fixed

- `upgrade --self` and `upgrade --all` no longer report success after doing
  nothing. With no controlling terminal and no `--yes`, the confirmation read
  end-of-input as the user answering "no": it printed `Upgrade cancelled` and
  exited 0. A cron job, a deploy script, or a fleet loop therefore recorded a
  successful upgrade on a machine that had not moved a byte — the same family as
  the install failures 0.1.10 fixed, where what the product said and what it did
  had come apart. The confirmation now distinguishes three states rather than
  two: answered yes, answered no, and unanswerable. An unanswerable prompt is
  refused loudly and exits non-zero, naming `--yes` as the way to run
  unattended. A genuine "no" is still a clean exit 0.
- The screen printed after `yos init` no longer sends a new user to a component
  that does not exist. Its Next steps offered `yos add telegram` and
  `yos add lark`; the shelf holds `weixin` and `feishu`, so the first documented
  action after a successful install answered `Unknown component` and exited 1.
  The hint, and the `add`/`upgrade`/`remove`/`uninstall`/`info` examples in the
  help text, now name components this repository actually ships.
- That same screen no longer advertises a URL that refuses connections. It
  printed `Network: http://<lan-ip>:3456/` while the Web Console binds
  loopback, handing every user an address that could not answer and inviting the
  conclusion that the product was broken. The console's real bind is now read
  before anything is advertised: a network URL appears only when that bind is
  reachable off-box, and otherwise the screen prints the SSH port-forward that
  does work. The bind was deliberately left on loopback — widening it to
  `0.0.0.0` would trade the console's safety for the convenience of a correct
  line, and on a public IP with no firewall it would expose it.

## [0.1.10] - 2026-08-08

### Fixed

- Installing the Claude runtime no longer gives up on a machine where
  `install.sh` had just succeeded. The installer elevates past a root-owned npm
  global directory to put `yos` there; 0.1.9 taught the PM2 install to do the
  same, and the Codex install already did — the Claude install did not. On any
  machine with a system-installed Node, the plain documented command
  (`curl -fsSL https://yoyooai.com/dist/install.sh | bash`) therefore exited 1
  one step after the installer had elevated past that very directory. The same
  rule now applies at every install site: a plain attempt first, then an
  elevated retry only for a permission failure, only when sudo needs no
  password, and never when already root. The retry covers the npm step alone —
  a just-downloaded installer script is never handed to root.
- The advice printed on failure names the cause it actually had. Every failure
  was reported as if the registry were at fault and the repair offered was to
  point npm at a different mirror, while both registries answered normally and
  the directory was the problem — advice that could not have worked. A
  permission failure now says so, names the directory, and offers a route that
  needs no root.
- An elevated attempt now says that it elevated. It previously printed the same
  line as the plain attempt, so the log read as though one registry had been
  tried twice for no reason. PM2 and Codex already said "with sudo"; the runtime
  install now does too.

### Removed

- The bare single-registry install helper, which had no privilege fallback and
  no callers left. Two functions for one job — one of them missing the repairs —
  was the defect itself; the next install site can now only reach for the one
  that behaves. The shared-chain scan that was meant to catch this covered
  `commands/` only, which is how a call site under `lib/` slipped through; it
  now covers the whole tree, and re-exporting a bare helper fails on its own.

## [0.1.9] - 2026-08-07

### Fixed

- A machine with a system-installed Node no longer stops the install halfway.
  Its npm global directory belongs to root, and `install.sh` handles that by
  elevating — which is how `yos` got installed at all. `yos init` then
  installed PM2 into the same directory without doing the same thing, hit a
  permission error, and exited: one step after the installer had succeeded, on
  the same directory, for a reason the installer had already solved. The same
  rule now applies in both places. Elevation happens only for a permission
  failure, only when sudo needs no password, and never when already root —
  each pinned by a test.
- The advice printed when a global install fails now names the cause it
  actually had. Every failure was reported as if the registry were at fault,
  and the repair offered was to point npm at a different mirror — while both
  registries were answering normally and the directory was the problem.
  Following that advice could not have worked. A permission failure now says
  so, names the directory, and gives the two repairs that apply.

## [0.1.8] - 2026-08-07

Five faults on one path. A customer behind a self-hosted gateway could install
YOS, watch every service come up green, and have an agent that could not speak
— and nothing in the product would say so. Four of the five made that failure
invisible; the fifth made it unrecoverable by restart.

### Fixed

- Key verification now probes the endpoint this install is configured to use,
  not the vendor's official host. Behind a gateway the official host is
  unreachable, so a perfectly good key was judged dead and thrown away. The
  question "where does this machine actually send API traffic" is now answered
  in one place and reused by init, doctor, and the Codex adapter.
- `yos init` now reads `~/yos/.env`. It was the only place in the product that
  did not: adapters read it, doctor reads it, startup reads it, but init looked
  at flags and process environment only. A credential recorded by yos itself
  was therefore invisible to yos at install time.
- The install summary no longer reports a stored-but-unchecked credential as
  "not authenticated". That is a lie in the direction that costs the user the
  most — they re-enter a key that was never the problem. There is now a third
  state that says all three true things: stored, unverified, and why.
- `doctor` checks the endpoint in use rather than the official host, and no
  longer requires DNS to resolve — a gateway is often given as a bare address,
  which resolution can never satisfy. It was previously possible for doctor to
  report the network healthy while the endpoint in use was down, and vice
  versa.
- A key from the wrong vendor is now named as such. "Invalid API key format"
  reads like a typo; it is usually an OpenAI key handed to the Claude runtime,
  and the message now says so and points at the Codex install command.
- `yos restart` restarts the agent's main loop. It restarted four PM2 services
  and printed "Services restarted." — none of those four is the agent, which
  lives in a tmux session. It now restarts that session and waits for it to
  come back, and reports failure rather than success if it does not.

### Changed

- Patched the `js-yaml` advisory that was riding along in every shipped
  package.

## [0.1.7] - 2026-08-07

### Fixed

- `yos uninstall --self` now actually removes a natively installed Claude Code.
  It ran `npm uninstall -g @anthropic-ai/claude-code` and deleted `~/.claude`,
  then reported success — but the runtime is normally installed by
  `claude.ai/install.sh`, which npm has never heard of, so the binary stayed in
  the account and stayed on PATH after an "uninstall". The list of what the
  native install leaves behind now lives next to the code that installs it, the
  uninstall removes every path it names, and afterwards it asks the machine
  whether `claude` still resolves and says so if it does. The confirmation
  prompt also promised less than it now does; it names the native paths too.


## [0.1.6] - 2026-08-06

Four things a customer or an operator could walk into, and one gate that was
asking people to remember a rule instead of enforcing it.

### Fixed

- The release-source error now says which of the two places holds the bad value.
  It resolves from the process environment or from the recorded `~/yos/.env`, and
  the message named the variable as if it were always the former. With a
  malformed value in the file, the obvious repair — export it — fixes exactly one
  command, because the next one reads the file again. The message now quotes the
  value back, names the file when the file is the source, and advises editing the
  file rather than exporting. Machine-readable error codes are unchanged.
- `yos init` no longer lets an isolated run own the machine's PM2 boot unit. It
  installed `/etc/systemd/system/pm2-<user>.service` unconditionally, so an
  init-flavoured test under an isolated HOME repointed the machine's boot hook at
  a sandbox — a reboot would have started none of the real services. A run whose
  HOME or PM2_HOME is overridden, or whose pm2 binary lives under the temp
  directory, now touches neither the unit nor the crontab fallback: a user
  crontab belongs to the real account whatever HOME the process was given, so
  that would be the same hijack by another road. `YOS_SKIP_SYSTEMD` opts out
  explicitly.
- A real run no longer destroys an existing boot unit silently. Identical
  content is left alone and asks for no sudo; different content is backed up to a
  timestamped copy first, and the lines that change are printed. "The original
  content is not recoverable" was the part of this that actually cost us.
- `yos init` now notices PM2 processes it did not start. A machine reinstalled by
  wiping the home directory left three PM2 daemons running — wiping a home does
  not stop a daemon — still holding the Web Console port, and init had no idea,
  so the failure surfaced later as an unexplained port conflict. It now sorts the
  account's processes into stale (script gone from disk), live (a previous install
  of ours), and foreign (outside this YOS directory, never touched and disclosed
  only so the count adds up), and hands over the exact command. It kills nothing:
  the processes belong to the account, and a reinstall is the worst moment to
  guess wrong. An unreadable process list is reported as "could not tell", never
  as "nothing there".

### Changed

- The executed-test floor is now mechanical in both directions. `minimumPassed`
  is a floor by design, but it was raised by hand with a line in a process
  document asking people to remember; tests added and forgotten sat outside it
  and could be deleted with the gate still green. Passing more than the floor now
  fails, and the message carries the number to write down. `driftAllowance`
  (default 0) is the escape hatch for a suite whose count genuinely moves, and it
  lives inside the digest-locked baselines so it cannot be widened quietly. The
  floors are now jest 255 / node 1364 — the counts this tree actually produces.


## [0.1.5] - 2026-08-06

"What is the latest version, and where do I get it?" had no single place to read.
It was answered from memory, from chat history, or from a table somebody kept by
hand — and a hand-kept table does not fail loudly. It goes stale in silence while
everyone still treats it as the source of truth.

### Added

- The distribution mirror publishes a version catalog: `VERSIONS.md` and a
  browser page at the mirror root. Per component it states the newest version, a
  copy-paste install command, how to pin an older version, whether every mirrored
  version can be installed offline, and which tags fell outside retention — a
  retention limit must not be met as a 404.
- The catalog is rendered from `index.json` inside the same build that writes it.
  There is no second place to update, therefore no second place to forget. It is
  digest-covered in `index.json` like every other mirrored file.
- The build refuses to publish a catalog naming an address that is not on the
  mirror. The existence check reads the output directory, deliberately not the
  index the rows were derived from: a check that consults the same source as the
  claim it checks cannot fail. A canary proves the check answers "no" to
  something before its "yes" is trusted.
- `registry.json` carries `displayName`, so the catalog and `yos add <name>` call
  a component by the same name, from one file.
- `build-dist.mjs` takes `--base-url` for the address printed in install commands.

### Fixed

- A piped install command no longer shreds its own table row: the unescaped pipe
  in `curl … | bash` ended the markdown cell and cut the command in half.

## [0.1.4] - 2026-08-06

Accepting 0.1.3 turned up the half of the pinned-address problem that 0.1.3 did
not fix: pinning an older version still needed GitHub.

### Fixed

- The distribution mirror carries an npm package for every mirrored version, not
  only the newest. The installer prefers that package and falls back to git,
  which needs GitHub — so with only one package mirrored, only the newest version
  could be installed without GitHub. Measured with GitHub blackholed:
  `install.sh --branch v0.1.2` printed "No release package for v0.1.2 on the
  distribution mirror — installing from git" and died reaching github.com over
  ssh. Reinstalling a machine at the version it was running was impossible for
  exactly the machines the mirror exists for.

### Note on install-<tag>.sh

The pinned installer is the installer **as it was at that tag** — it is not a
request to install that version. Run unchanged it still resolves the newest
release; use `--branch <tag>` to pin the version itself. The name reads like a
promise it does not make, which is worth knowing before anyone writes it into a
document.


## [0.1.3] - 2026-08-06

Five things a customer could actually hit, found by reading the shipped code
against the debt ledger rather than trusting what the ledger said. Two of them
existed because a fix recorded as "done" had never reached this line at all.

### Fixed

- `npm ci` inside a source checkout no longer edits a live installation. npm runs
  `postinstall` for a clone exactly as it does for a real install, and both of
  postinstall's jobs write into `~/yos` — so a development action replaced live
  skill directories and rewrote Codex configs on a machine whose services kept
  serving the old code from memory. An installed copy is now told apart from a
  checkout by where the package sits, and an unrecognised layout declines instead
  of guessing. `YOS_POSTINSTALL_FORCE=1` overrides it.
- When skills on disk do change, the output now says the running services are
  still on the old code until they restart.
- A component whose declared Node range does not match the running Node is
  refused at `yos add`, with the version it needs, instead of installing and
  never starting.
- `yos upgrade --self --check` no longer downloads the entire release to read the
  update notes: 859 KB fetched for a 10 KB file, on links measured at 62–175
  KB/s. The notes are read from the version's own tag — never `main`, never a
  moving `stable/` pointer, so they still describe the version being offered
  after the next release lands.
- Archives fetched from the distribution mirror are checked against the sha256 it
  already publishes for every file. gzip's CRC already rejects a damaged archive;
  this catches the archive that is well-formed and simply is not the one asked
  for — the mirror caught mid-publish, or a stale copy held by a proxy. Where the
  digest cannot be checked, that is printed rather than passing quietly. It is
  not a supply-chain control: digest and file share an origin.
- A machine installed from a non-default mirror remembers it. Only the repository
  was recorded before, so the mirror fell back to the built-in default on the
  next upgrade and the machine left the origin it came from — on a host that
  cannot reach the default, it silently stopped upgrading. The default itself is
  deliberately not recorded, so the origin behind it stays re-pointable; an
  explicitly empty value is recorded, because "use GitHub, not the mirror" is a
  choice.
- `install-<tag>.sh` is published for every mirrored tag, each read from that tag.
  Only the newest had one, and publishing uses `rsync --delete`, so a pinned
  address died at the next release — measured, `install-v0.1.0.sh` and
  `install-v0.1.1.sh` were already 404.
- Mirror retention goes from 5 to 20 versions per line, and the build now prints
  which tags fell outside it and names them in `index.json`. At recent release
  rates a version left the mirror days after shipping, so a machine could no
  longer be reinstalled at the version it was running, and nothing said so.

### Changed

- A failing test run leaves its full output in `.test-logs/` instead of being
  unreproducible after the fact.
- The official `docker run` banner reports the port the console is actually on
  rather than a hardcoded 3456.

## [0.1.2] - 2026-08-06

On a machine where the customer is not an administrator, no boot hook could be
installed — and the install called that optional and said nothing was lost by
it. That was false. After a reboot every service was down, the bot was silent,
and the one command that would have fixed it had never been written down where
anyone would look.

### Fixed

- When no privileged boot hook can be installed, the boot hook is installed in
  the customer's own crontab instead (`@reboot pm2 resurrect`). cron runs as a
  system service and fires `@reboot` per user with no linger and no polkit
  prompt, so a non-root account can own its own boot recovery. Verified by
  rebooting a machine with no sudo: all four services came back with nobody
  typing anything.
- Every privileged route that fails now hands off to that fallback instead of
  printing a warning and returning.
- When even the crontab route is impossible, the message says outright that the
  services will not come back after a reboot, gives the command that brings them
  back now, and names the two ways to fix it for good. It no longer claims the
  machine is fine without a boot hook.
- Re-running `yos init` replaces its own crontab entry instead of stacking
  copies, and entries belonging to anything else are preserved exactly.
- The `@reboot` command carries its own HOME, PM2_HOME, PATH and an absolute
  pm2 path — cron supplies almost no environment — and logs to
  `~/yos/pm2/reboot.log` rather than mailing the customer.

## [0.1.1] - 2026-08-06

Installing YOS needed two downloads that each had exactly one origin, and a
failure at either ended the install with no route out. Measured on a machine
that could reach neither `claude.ai` nor `registry.npmjs.org` — the shape of a
customer whose network out is poor — `0.1.0` died at the first of them.

### Fixed

- The agent runtime is installed from the first source that works: the native
  installer, then npm on the configured registry, then npm on a mirror
  registry. The npm package carries the same native binary as a platform
  optional dependency, so a mirror serves a complete runtime. Verified with
  `claude.ai` black-holed.
- PM2 and the Codex CLI are installed through the same registry chain. PM2 runs
  before the runtime, so a single unreachable registry there used to end the
  install before the runtime's own fallback could help.
- The installer script is downloaded and then run, instead of piped into a
  shell. `curl … | bash` exits with bash's status, so a download that never
  happened looked like a success and the failure text blamed PATH instead of the
  network. A partially downloaded error page is also no longer executed.
- A source that exits 0 but leaves nothing runnable is no longer accepted as
  success; the next source is tried.
- Failure output names every source that was tried, and distinguishes an
  unreachable host from a command that is installed but not on PATH.
- `yos init` no longer carries its own copy of the runtime install logic. Both
  entry points share one path, and the test suite fails if a command file goes
  back to installing directly.

### Added

- `YOS_CLAUDE_INSTALL_URL` points the runtime install at a different installer
  script; `YOS_NPM_REGISTRY` points every global npm install at a different
  mirror. Setting either empty drops that source rather than restoring the
  default, the same rule `YOS_DIST_BASE` follows.

### Note on outbound hosts

As a fallback only — never when the configured sources answer — an install may
now contact `registry.npmmirror.com`. Set `YOS_NPM_REGISTRY=` to remove it.

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
