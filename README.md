# YOS

YOS is a persistent AI Agent runtime for long-running digital assistants and digital employees.

It keeps one agent available across sessions and channels, with durable memory, scheduled work, message routing, health monitoring and recovery. The current engineering baseline supports both Claude Code and Codex while the product moves toward a Codex-first architecture.

## Status

This repository is the YOS engineering baseline. It is suitable for development and internal verification, but it is not yet a customer release.

## Core Capabilities

- Persistent identity, state and reference memory
- Unified message bridge with SQLite history
- Scheduled and deferred tasks
- Runtime health monitoring and recovery
- Web Console
- Claude Code and Codex runtime adapters
- Install, component and upgrade tooling
- Read-only capability discovery across built-in skills, installed components and the release shelf

## Development Setup

Requirements: Node.js 20.20 or later, npm, git and tmux.

```bash
npm ci
npm install -g .
yos init
```

Customer delivery must record an explicit administrator alert target:

```bash
yos init --admin-channel <channel> --admin-endpoint <administrator-target>
```

Both values are required together. Leaving both empty does not block installation,
but alerts can only be written to local logs and the machine is **not ready for
customer handoff**. YOS never guesses an alert recipient from conversations,
memory, or the first contact.

## Common Commands

```bash
yos init
yos shell
yos attach
yos status
yos doctor
yos runtime status
yos runtime codex
yos add <component>
yos list
yos capability list
yos capability search <keyword>
yos capability show <capability-id>
yos capability providers <capability-id>
```

Capability queries never install, upgrade or execute a component. Built-in and
installed facts are read locally; optional providers come from the release
shelf's same-build `index.json` and `capabilities.json`. Use `yos doctor` when a
declared capability provides a health check.

## Verification

```bash
npm run verify
npm run release:pack
```

Official artifacts must be created with `npm run release:pack`, which completes the full gate before writing to `publication/`. Ordinary `npm pack` remains available to stage a candidate inside the client-side self-upgrade transaction; it is not evidence that an artifact passed the release gate.

If automatic self-upgrade rollback is incomplete, YOS retains the transaction backup and prints a recovery command: `yos upgrade --self --recover <backup>`. Do not remove that backup before recovery.

The verification gate runs the complete Jest and Node test suites, dependency audits and reproducible package checks. A change is not release-ready unless this command passes on the standard Linux environment.

## Current Compatibility Boundary

This release installs fresh only. The rename is complete rather than layered: the sole executable is `yos`, the default runtime directory is `~/yos`, and configuration is read from `YOS_*` variables. The pre-rename executable, home directory and `ZYLOS_*` variables are not recognised, and the in-place instruction-migration path was retired — so an existing upstream or early-YOS install cannot be upgraded in place. Install fresh and carry data over deliberately.

Claude Code support is intentionally retained during this phase. Removing a runtime adapter before Codex has independent startup, monitoring, memory rotation and recovery coverage would create unnecessary product risk.

## Documentation

- [Docker deployment](docs/docker.md)
- [GitHub authentication](docs/github-authentication.md)
- [Custom session startup](docs/custom-session-start.md)
- [Hook activity tracking](docs/hook-activity-tracking.md)

## License

YOS is distributed under the terms in [LICENSE](LICENSE).
