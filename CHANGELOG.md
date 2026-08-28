# YOS Changelog

All notable changes to YOS are recorded here from the point at which the independent YOS product baseline was established.

## [0.1.23] - 2026-08-28

### Fixed

- A capability health probe now runs from the copy of the skill that can
  actually run it. A core skill exists twice on a machine: the package copy,
  which carries the `SKILL.md` the declaration is read from, and the installed
  copy under the skills directory, which is the one with `node_modules`. The
  catalog resolved the probe against the first, so any probe with an import
  could not load its dependency — and `yos doctor` on a healthy factory install
  went red on two of three capabilities. 0.1.22's own acceptance run caught it
  before it reached a customer; the release was rolled back off the shelf
  rather than shipped.
- A probe that cannot load its driver no longer reports the store it watches as
  unreadable. Loading the driver and reading the store were the same `try`, so
  a failure to start was reported as a fault in the thing being probed: a false
  alarm that also named the wrong cause, which sends whoever reads it to look
  at the wrong place. The two are separate now, and the driver failure says
  which directory it was looking from.
- The tests for this area passed the same directory as both the package copy
  and the installed copy — the one arrangement no real machine has, and the
  reason a defect this visible survived a green suite. They now hold the two
  apart: the probe path must land in the installed copy when the skill is
  installed, fall back to the package copy when it is not, and refuse a
  symlinked skill directory. The false alarm itself is reproduced against a
  healthy database and pinned by its message.

## [0.1.22] - 2026-08-28

### Changed

- The factory system prompt no longer tells the agent what it can do. 0.1.20
  replaced a false capability claim with a true capability list; 0.1.21 then had
  to ship an installer fix because that list named `unzip` and `python3` while
  `install.sh` put neither on the machine. Two releases, same shape of defect,
  48 hours apart — a capability list is a fact that expires. "What You Can
  Already Do" is gone; in its place "Meeting a Request" describes the procedure
  (look for an existing capability with `yos capability list` / `yos search`,
  and if nothing fits go find a solution — reviewed first, confirmed with the
  user before anything is installed). Abilities are discovered by attempting
  the work, which is the only source that cannot go stale.
- The first message a customer ever receives is now the wording written and
  approved by the product owner, shipped word for word. Four earlier drafts
  failed for the same reason: they described this machine. The approved text
  opens by telling the person *not* to study the feature list, describes what
  it can take off their hands in their terms, and spends its last third asking
  about them while explicitly excusing them from being organised about it. The
  Chinese is the original rather than a translation, so it ships verbatim under
  its own byte pin, with the author's own typography; the English rendering
  carries the same message for every other language.
- The customer-facing opening no longer promises to announce payments before
  making them. Nothing in this product can make a payment, and while the
  sentence was a promise to ask first rather than a claim of ability, a reader
  reasonably concludes payment is on the menu.
- Roughly 70 lines of memory bookkeeping moved out of both system prompts into
  `templates/memory-system.md`, read on demand through the same mechanism as
  `onboarding.md`. It was a permanent per-session cost on every customer
  machine for rules consulted only at write time. Codex prompt 300 -> 239
  lines, Claude 289 -> 229.
- "Don't answer live facts from memory" appeared three times in three wordings.
  Merged into one.

### Added

- The capability table is now true about the machine reading it. Four core
  skills shipped with no declaration at all, so the list under-reported what
  the machine had while naming them under "Undeclared capabilities" — which
  reads as a fault rather than an omission. Declarations may now carry
  `runtimes:`, because two capabilities drive Claude Code and nothing else
  while customers get Codex by default; an unscoped declaration there would
  have been false on essentially every customer machine. Absent means every
  runtime, an unknown name is rejected rather than ignored, and the filter
  fails open — hiding a capability the machine really has makes a working
  product look broken.
- Health probes on the three capabilities that can be installed and still be
  broken (message store, task store, monitor status). The `health` field and
  the doctor's runner for it already existed and not one shipped declaration
  used them — an alarm wired to nothing. Every probe is read-only, does no
  network, has no side effects, and treats a missing store as a pass.
- Guards, in both directions: the prompt may not assert a missing capability
  (the 0.1.19 bug) and may not enumerate capabilities either (the 0.1.20 fix
  that became 0.1.21's bug); every `yos <command>` named in customer-facing
  prose must exist in the CLI's own command table; the customer-facing text may
  contain no filesystem paths and no shell commands; every rendering of the
  opening must ask the person something; the approved Chinese is byte-pinned;
  and a prompt may not point at an instruction file that does not ship. The
  installer's `unzip`/`python3` guarantee survives, re-anchored on `install.sh`
  directly — deriving it from a section that no longer exists would have let it
  pass vacuously.
- `templates/memory/identity.md` ships a `## My Name` slot. The opening does
  not ask the customer for a name, per the owner's call, but a name they offer
  on their own is written down so the next session still knows it.

### Removed

- Two onboarding guards, removed rather than loosened because the approved
  wording disproved them: "exactly one question per message" (the approved text
  asks four in a row, all asking the same thing in different words, which reads
  as somebody taking an interest rather than as a form) and "must end on the
  question" (it ends on a reassurance, which is better). Counting question
  marks was never a measure of what it was claimed to measure.

## [0.1.21] - 2026-08-28

### Fixed

- The installer now puts on the machine what the manual says the agent already
  has. 0.1.20 added a capability section naming `unzip -p` for Office files and
  `python3` for text-layer PDFs; `install.sh` guaranteed neither. Measured on a
  stock `ubuntu:24.04` image: both absent, so on a minimal system the manual
  promised a capability the machine did not have. This is the same defect as
  the false "No built-in WebSearch/WebFetch" line that section was written to
  delete, pointing the other way — a sentence with nothing verifying it.
  Scope, stated honestly: on the Tencent Cloud Ubuntu machines actually
  shipped to customers both commands were already present, so no customer is
  known to have hit this. It was found by installing 0.1.20 into an empty
  container during final release checks.
- `ensure_unzip` and `ensure_python3` join the prerequisite list and run
  through the same `install_system_package` path as curl, git and tmux. They
  support a capability rather than YOS itself, so a machine with no usable
  package manager gets a loud warning and a working install instead of an
  aborted one — hard-failing here would turn a documentation gap into a broken
  install, which is worse than the bug.

### Added

- A guard that keeps the manual and the installer from drifting apart again.
  `test/native-capability-declaration.test.js` reads the prerequisite list out
  of `install.sh` rather than restating it, and requires every external command
  named in either template's capability section to appear there. Naming
  `pdftotext` tomorrow without a matching `ensure_*` call goes red instead of
  shipping as a sentence the customer's machine cannot honour. Both reversals
  were run: deleting the two call sites fails 3 tests, adding an unguaranteed
  `pdftotext` to the Codex template fails 1. Jest floor 508 → 513.

## [0.1.20] - 2026-08-28

### Fixed

- Stop shipping a false capability claim to every customer machine. The Codex
  system prompt — the one the default runtime reads — asserted "No built-in
  WebSearch/WebFetch: use curl/wget". That is false: measured on a real 0.1.19
  install, interactive path, with no `[tools]` entry anywhere in the tree, the
  runtime searched the web and returned the live figure. The line is replaced
  by one pointing at the built-in search. **No behavioural win is claimed**:
  asked point blank, the agent said it could search under the old prompt too.
  Removing a false statement from a customer-facing artifact is the whole
  justification.

### Added

- Both system prompts declare what the agent can already do, ahead of the
  behavioural rules. Previously 264 lines of behaviour, security, memory and
  comms rules carried no capability declaration at all — the runtime could
  read Office files, read PDFs, see images and search the web, and nothing on
  the machine said so. Each entry was measured on a factory install rather
  than written from what sounded right: Office files via `unzip -p` (a .docx
  and an .xlsx were pulled that way with nothing installed), PDFs with a text
  layer via python3, images directly, web search with no flag or config.
- Two rules travel with the declaration: a missing capability is a claim that
  needs a real attempt behind it, and an unreadable file is a fact about that
  file — never widened into "I cannot read documents".
- `test/native-capability-declaration.test.js` locks it: both prompts must
  declare the capabilities, must place them ahead of the behavioural rules,
  must name the shell route to Office formats, must forbid the untested
  "I can't" and the widened refusal, and "No built-in WebSearch" must never
  return. Ten knives, ten reds, green on restore. Jest floor 491→508.

### Notes

- A reproducible failure was found and is **not** fixed here: asked what an
  index closed at today, an agent may answer from memory — a different
  fabricated number each run, never searching. The live-fact rule added above
  did not change it, even though the agent can quote the rule back verbatim.
  That is worse than "I can't", because the customer cannot tell. Later
  measurement found it intermittent — 34 controlled runs across six isolated
  variables all searched and answered correctly, and the original failure
  could not be reproduced. Cause unknown; tracked as debt, not resolved.
  (TD-278)
- One change was made, measured, and reverted: a `[tools] web_search` default
  in the Codex project config. The premise ("the switch ships off") was wrong
  — the real machine searched without it. Shipping it would have been a
  redundant component with a plausible story attached, which is the exact
  mistake this release came out of.

## [0.1.19] - 2026-08-27

### Changed

- Move the shelf off the portal and onto its own hostname. The shelf lived at
  `/dist` inside the portal site's document root, on the portal's machine, so
  when the portal was replaced the shelf went with it — "the shelf is gone" and
  "the portal is gone" were one event, not two, and every deployed machine lost
  its upgrade path as a side effect of a change nobody thought touched releases.
  `DEFAULT_DIST_BASE` now points at `https://dist.yoyooai.com`, a host that
  serves nothing but the shelf. The old URL keeps working: `yoyooai.com/dist/*`
  answers 301, and every fetch path in the tree runs `curl -fsSL`, so deployed
  machines follow it without being touched — verified end to end with
  `verify-public-shelf.mjs --full` passing 1087/1087 against both the new host
  and the old redirecting one. The default is deliberately duplicated in
  `upgrade-check.js`, which runs detached from the installed package;
  `dist-origin-parity.test.js` holds the two in agreement and that guard was
  mutation-checked rather than taken on faith. (TD-266)
- Say what `detectRateLimit()` in the Codex probe actually knows. It returned
  `{detected:false}` under a comment asserting Codex CLI has no per-plan usage
  limits — an assertion that is wrong: ChatGPT-account sign-in carries rolling
  5-hour and weekly quotas, and API-key billing returns 429 on exhausted credit
  or org RPM/TPM ceilings. Behaviour is unchanged, because implementing
  detection needs a captured sample of real limit text and guessed patterns are
  worse than none; it is now marked `NOT IMPLEMENTED` so the next reader knows
  the check was skipped rather than passed. Recorded as deferred, not resolved.
  (TD-269)

### Fixed

- Give PM2 services the timezone the machine was installed with. `yos init
  --timezone` sets the host zone and records `TZ` in `.env`, but the services
  were started without it, so Node formatted their timestamps in UTC while the
  machine itself read local time. On an Asia/Shanghai install that put
  `yos status` and `activity.log` eight hours behind, unlabelled — which reads
  as "this agent has been dead since this morning" when it answered a minute
  ago. Found on a real machine, after it had already misled us once. `TZ` is
  now passed to every managed process: the four core services, Caddy, and
  component services on both the shipped-ecosystem and SKILL.md paths. It is
  spread in rather than assigned, because Node treats `TZ=''` as UTC and
  injecting an empty value would move an unconfigured machine to UTC — the
  opposite of the fix; absent stays absent and the process inherits the host.
  (TD-270)
- Stop the Codex kick from reading as a person talking. A freshly launched
  Codex agent used to receive the bare word `hello` as its first message; its
  only job is to fire the SessionStart hook, but as a greeting it invited the
  agent to answer — and on a YOS machine every inbound message carries its own
  C4 reply route, so answering means answering *somebody*, down whichever route
  happened to be in context. The kick now states what it is: a YOS startup
  signal, not a user message from any channel. Pinned by tests covering the
  wording, a length ceiling, statelessness, shell-safety, and the rendered
  command on both the new-session and restart paths.
- Keep the agent's own web surface out of search engines. Every Caddyfile YOS
  generates now sends `X-Robots-Tag: noindex, nofollow`. That surface is the
  file share, the web console and the health endpoint on a customer's machine —
  none of it is meant to be indexed, but any machine given a domain was
  publishing it to crawlers by default. There are three independent places that
  emit a Caddyfile (`yos init`, the http skill's setup script, and the shipped
  template); a parity test now asserts the directive in all three, so fixing one
  and forgetting the others fails red. (TD-171)
- Close the twelfth clock that rendered UTC as if it were local time. The guard
  left behind by the timezone fix searched for one literal spelling,
  `toISOString().replace('T', ' ')`; `memory-status.js` writes the same mistake
  with a `.slice(0, 16)` in between and walked straight past it, so `yos memory
  status` reported every file's modified time eight hours early under a label
  that looks local. A guard that recognises only one spelling of a mistake is
  not a guard — it now matches any chain between `toISOString()` and the
  `replace`. Verified on a real run, not only in the test. (TD-270)
- Judge a frozen agent by the clock, and stop calling a lost baseline frozen.
  `ProcSampler` decides whether the agent is alive or wedged and the guardian
  acts on that answer — a wrong "frozen" restarts a healthy agent, a wrong
  "alive" leaves a stuck one stuck — and it had no tests at all. (TD-269)
- Stop a half-written pending file from restarting a healthy agent. Both
  heartbeat probes read the pending record with a bare `JSON.parse`, which
  rejects unparseable bytes but waves through every parseable shape: `{}` was
  enough to become a heartbeat nobody sent, with `created_at` falling back to 0
  so the computed age was the whole Unix epoch and instantly past the 600s
  ceiling, while `control_id` was undefined so C4 could never answer `done` —
  an immediate `stale_pending` and a kill-restart of an agent that was never
  asked anything. The reader now returns a record only when the engine can both
  query it and age it; anything else reads as "nothing in flight", costing one
  heartbeat interval instead of a restart. The two divergent copies are gone:
  read, write and clear now live in `cli/lib/heartbeat/pending-state.js`, and
  the writer refuses to persist a record the reader would reject. (TD-269)
- Never let a session that cannot be measured look roomy. The context monitor is
  the only thing that decides a session must hand over before it runs out of
  room, so its failure mode is silence — no handoff, no log line, and a session
  that grows until the runtime hits its own wall. Three ways it went quiet are
  fixed: a failed handoff armed the five-minute cooldown anyway, so the one
  moment the handoff mattered most was the moment the monitor stopped asking; a
  reading of `NaN` was treated as a ratio, and since every comparison against
  `NaN` is false the monitor "decided" not to rotate, every thirty seconds,
  forever; and being unable to read usage at all was indistinguishable from a
  healthy idle machine — it now says so after ten consecutive unreadable checks,
  with the reason attached and a line when it recovers. Also removes a dead
  import that made deliberately unused wiring look live. (TD-269)
- Degrade one pipeline instead of the whole tick, and say "unknown" when it is.
  Everything `ToolPipeline` reads is written by hook processes we do not
  control, and a single bad read threw straight out of `tick()`: no status file
  write, no tool watchdog, no task scheduler dispatch. Repeated every tick, that
  leaves `agent-status.json` with a "Last check" that never advances — which
  reads as "this machine died hours ago" about a machine that is fine. Each
  stage is now contained on its own. Separately, when the foreground session
  could not be identified the snapshot published `active: false`, which is "I
  cannot tell" wearing the costume of "definitely idle" — and downstream reset
  the frozen counter on it, so during any such window a genuinely hung agent
  could not be detected as hung. Snapshots now carry `activity_known`. Failed
  writes and declined log rotation are no longer mute, reporting at 4x backoff.
  (TD-269)
- Stop an upgrade analysis that was never complete from looking complete. This
  is the last thing a user reads before typing `y` on an operation that
  overwrites files they have edited, so the failure that matters is not a wrong
  verdict — it is a screen of green that was never a review of everything. Only
  the first ten changed files were ever sent, and the returned object dropped
  even the count of the rest; files were truncated at 500 lines before being
  sent, so a local change at line 900 was not in the evidence yet the file could
  still come back `safe`; and the verdicts were never reconciled against the
  files asked about, so a quietly omitted file produced no line at all. Every
  requested file now gets exactly one line, unresolved ones are marked
  `[NOT ASSESSED]`, truncated files are downgraded to warning, unexamined files
  are named on screen, and `safe` is a conclusion drawn here rather than a field
  the model asserts. When the evaluator cannot be reached at all, the result
  carries `available: false` with a reason instead of collapsing to
  "(Upgrade analysis skipped)", which reads as reassurance. (TD-269)

## [0.1.18] - 2026-08-15

### Fixed

- Make a frozen agent session recoverable instead of quietly wedged. Self-heal
  used to kill the tmux session and hope; a session whose process tree had
  stopped responding left its children alive, so the "recovered" machine came
  back with the old processes still holding the runtime. Recovery now walks the
  exact process tree and reaps it, and both runtime adapters route their stop
  path through that reaper rather than a bare session kill.
- Stop a forced rebuild from leaving no trace. Every forced rebuild now writes a
  local log line and increments a snapshot counter that survives a watchdog
  restart; three rebuilds inside four hours latch a "needs human attention"
  flag. Previously the counter reset to zero on every restart, so the escalation
  could be erased by a single restart with nobody the wiser. An offline snapshot
  keeps the real last-activity time and its source instead of the moment the
  snapshot was taken.
- Show where an official component actually came from. The component listing
  reported the source repository even when the package had been installed from
  the distribution shelf, so the answer to "where did this come from" did not
  match reality.
- Refuse to treat an unrelated directory as a YOS installation. Ordinary
  commands run from an arbitrary directory could latch onto it as the install
  root; they now decline, while `yos init` continues to handle both first
  installation and recovery.

### Added

- Report the local connection identity in `yos doctor` for the Feishu channel,
  so a delivered machine can be told apart from any other instance signed in
  with the same application credentials.

### Changed

- Ship the shelf auto-backup installer in system mode only. The installer used
  to generate a user-level systemd unit, which on a machine whose user manager
  sandboxes `/etc` produces a timer that stays green while the backup never
  runs. Concurrent installs are now rejected against the real unit state, the
  previous timer is not stopped before a rejection, and an interrupted install
  rolls back on either signal. (Merged 2026-08-14; reaches customers with this
  release.)

## [0.1.17] - 2026-08-14

### Changed

- Make Codex the default runtime for a fresh installation. The product default
  had already moved to Codex, but non-interactive init, the interactive picker,
  the help text and the Docker entry point all still defaulted to Claude — so a
  machine delivered with our standard credentials came up on a runtime those
  credentials do not admit, and answered nothing. Explicit flags, environment
  variables and existing configuration keep their precedence, in that order;
  Docker now picks the runtime when exactly one credential family is present and
  refuses to guess when both are. No existing installation's runtime is changed.

### Fixed

- Stop a delivered machine from going silent when its agent is unreachable. A
  stale health snapshot now answers the user in the same second ("temporarily
  unavailable") instead of dropping the message; a machine that stays down with
  a backlog raises a separate alert to the administrator — carrying no user
  content — and the queued messages are delivered once the agent recovers.
  Installation now records the alert target explicitly rather than letting the
  health check infer a recipient, and an install that never configured a target
  says so instead of reporting an alert it did not send.
- Keep an empty value on its own line when reading `.env`. A key with no value
  swallowed the following line, so a machine with no alert target configured ran
  with a target parsed out of unrelated text — a state that could not be
  reproduced by reading the configuration file.
- Count test cases that follow a regular-expression literal. The gate that keeps
  each protected file from losing coverage mis-parsed a `/` after a closing
  brace as the start of a regular expression and skipped the rest of the file,
  so its floor could sit below the real number of declared tests and deleting a
  test would not turn the gate red.

## [0.1.16] - 2026-08-13

### Fixed

- Stop reporting a degraded install as a successful one. `yos add` ended on
  "installed successfully!" with exit code 0 even when a component's
  post-install hook had failed and fetched none of its sub-skills; the closing
  verdict now goes through `classifyInstallOutcome()`, which cannot celebrate an
  install whose setup hook did not finish. The install itself still continues —
  the failing part is usually an optional add-on — but it is named, not hidden.
- Refuse to install the shelf off-site backup timer for a repository path that
  systemd's `WorkingDirectory=` cannot express. That field is read literally:
  neither quoting nor `\xNN` escaping survives it, so any such path produced a
  unit that passed `systemd-analyze verify`, loaded, and then died at startup
  with `status=200/CHDIR` — a timer that looked healthy while no backup was ever
  written. Installation now fails immediately and names the offending
  characters.

## [0.1.15] - 2026-08-13

### Fixed

- Run an explicitly declared component repair hook before reporting a
  same-version component healthy. Components without that hook keep the old
  behavior; a declared repair failure returns a stable error code instead of a
  false "up to date" result.
- Derive shared capability titles from one Core-owned resolver so local and
  shelf catalogs cannot inherit the title of whichever provider was read first.
  Provider display names remain attached to provider records.

## [0.1.14] - 2026-08-10

### Added

- Add one read-only capability catalog across built-in skills, installed
  components and providers published on the YOS release shelf. The
  `yos capability` commands and the Capabilities doctor group share the same
  strict declaration contract; querying never installs, upgrades or executes a
  component.
- Build `capabilities.json` beside `index.json` from released component tags.
  The capability index carries no artifact URL, size or digest and must match
  the shelf build identity, so `index.json` remains the only artifact source of
  truth.

### Fixed

- Make shelf builds declare production or test-only intent. Production mode
  refuses skipped or incomplete vendor artifacts, and any retention-driven tag
  eviction now fails before the output directory is created unless explicitly
  approved. The default retention window increases from 20 to 50 versions.

### Security

- Record each re-hosted third-party vendor artifact's immutable HTTPS source,
  byte length and SHA-256 in `index.json`, so a shelf can prove both what it
  serves and where that binary came from without relying on the build machine.
- Claude credentials and the YOS environment file are now written with owner-only
  permissions. Existing permissive files are tightened when YOS rewrites them.

### Fixed

- Normalize the `truncated gzip input` archive error emitted by some tar implementations, and retain the first PM2 state sample when settling a service started from the core ecosystem.

- Progress-log version ordering now preserves hyphens inside prerelease identifiers,
  so `alpha-2` no longer compares equal to `alpha-1`.

### Documentation

- Distribution documentation now matches the implemented contract: the YOS shelf is
  preferred, GitHub is the fallback, and `YOS_DIST_ONLY=1` disables that fallback.

## [0.1.13] - 2026-08-09

### Fixed

- `yos uninstall --self` now takes back the key and gateway address YOS wrote
  into `~/.claude/settings.json`. An uninstall reported success while the
  customer's own Claude config still carried our credential and our endpoint —
  "uninstalled" meant "we ran some commands", not "our things are gone".
  A value is only removed when `~/yos/.env` still holds the same value, i.e.
  when we can prove YOS installed it; anything the customer changed is left in
  place and named in the output, with the reason. Deleting a credential we
  cannot prove we wrote would destroy a Claude Code setup that predates YOS.
  The approved-key entry YOS added to `~/.claude.json` is dropped along with it.

### Changed

- Registering an approved key in `~/.claude.json` had two independent
  implementations (`cli/lib/runtime-setup.js` and `cli/lib/runtime/claude.js`).
  Editing one left the other behind and no test went red. Both now call one
  implementation in `cli/lib/claude-credentials.js`, and a test fails if any
  other file under `cli/` writes `customApiKeyResponses` again.

## [0.1.12] - 2026-08-09

### Fixed

- `yos add <component> -y` no longer stops and waits on a terminal. `--yes`
  skipped only the install confirmation; the credential prompts that follow ran
  regardless, so an install meant to be unattended sat on `FEISHU_APP_ID:`
  until someone noticed. The flag now covers every question `yos add` asks.
- The intent is passed to the component's post-install hook as
  `YOS_ASSUME_YES`. The hook inherits the same terminal, and previously decided
  for itself from `process.stdin.isTTY` alone — so a promise the CLI had made
  did not exist on the other side of the process boundary.

### Changed

- Not asking for credentials is now stated, with the variables to set and where
  to set them. Without a terminal every prompt was skipped in silence, which
  ended an install with a component that could not start and no indication why.
  This is also the path every automated run takes, which is how it stayed
  invisible.
- A customer who is asked is told that Enter skips a value. The loop always
  accepted an empty answer; only the code knew that.

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

- Established the verified v0.6.0 engineering baseline from an upstream product.
- Added dependency security fixes, deterministic tests and a reproducible verification gate.
- Started the user-facing YOS brand separation while retaining runtime compatibility.
