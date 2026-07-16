---
name: component-management
description: Guidelines for managing YOS components via CLI and C4 channels. Use when installing, upgrading, or uninstalling components, or when user asks about available components.
---

# Component Management

Guidelines for installing, upgrading, and managing yos components.

## CLI

`yos` is a **global npm command** (installed via `npm install -g yos`).
Run it directly as `yos`, NOT as `~/yos/yos` or `./yos`.

## General Principles

1. **Always confirm before executing** - User must explicitly approve install/upgrade/uninstall
2. **Guide interactively** - Never just tell user to "manually edit files"
3. **Read SKILL.md** - Each component declares its requirements in SKILL.md frontmatter
4. **Detect execution mode** - Handle both Claude session and C4 channels differently
5. **CLI = mechanical, Claude = intelligent** - CLI handles downloads, backups, file sync. Claude handles config, hooks, service management, user interaction.

## Workflows

Detailed step-by-step workflows for each operation (Session + C4 modes):

- **[Install](references/install.md)** — Add new components
- **[Upgrade](references/upgrade.md)** — Upgrade components and yos-core (self-upgrade)
- **[Uninstall](references/uninstall.md)** — Remove components with data options

## Quick Commands

```bash
# Check yos-core version
yos --version

# List installed components (with versions)
yos list

# Search available components
yos search <keyword>

# Component status
yos status

# Check for yos-core updates
yos upgrade --self --check

# Check for beta/prerelease updates
yos upgrade --self --check --beta

# Check all components for updates
yos upgrade --all --check
```

## SKILL.md Config Format

Components declare their configuration requirements in SKILL.md frontmatter:

```yaml
---
name: my-component
version: 1.0.0
description: Component description

config:
  required:
    - name: ENV_VAR_NAME
      description: Human-readable description
      sensitive: true  # Optional: marks as secret
  optional:
    - name: OPTIONAL_VAR
      description: Optional setting
      default: "default-value"
---
```

When `sensitive: true`, the value should be handled carefully and not logged.

New components may declare a non-interactive configure hook:

```yaml
lifecycle:
  hooks:
    configure: hooks/configure.js
```

When present, collect `config.required` values and pipe them as stdin JSON to the hook. The component owns how those values are stored, usually in `~/yos/components/<name>/config.json`. Components without `hooks.configure` are legacy-compatible and still receive collected values through `~/yos/.env`.

---

## C4 Mode (IM Channels)

When user sends requests via C4 comm-bridge (Telegram, Lark, etc.), use streamlined flows with two-step confirmation. Replies must be plain text (no markdown).

### Detecting C4 Mode

The request is from C4 when the message arrives via a communication channel
(e.g., `<user> said: ...` with a `reply via:` instruction).

### C4 Reply Formatting

All `--json` outputs include structured data and a `reply` field (pre-formatted fallback).

**Preferred**: Use the JSON data fields to craft a clear, user-friendly plain text reply.
**Fallback**: If you're unsure how to format the reply, use the `reply` field directly.

### C4 Command Mapping

**CRITICAL: "add \<name\>" and "upgrade \<name\>" MUST ONLY run --check. NEVER execute install/upgrade without the word "confirm" in the user's message.**

**CRITICAL: confirm flow now always re-downloads (no temp-dir reuse):**
- `--check` is for preview/analysis only; any temporary download from check is cleaned up after the check completes.
- `upgrade <name> confirm` and `upgrade yos confirm` always download a fresh package.
- Do not pass `--temp-dir`; it is no longer supported and the CLI will fail fast.

| User says | CLI command |
|-----------|------------|
| list / list components | `yos list` |
| info \<name\> | `yos info <name> --json` |
| check / check updates | `yos upgrade --all --check --json` |
| check \<name\> | `yos upgrade <name> --check --json` |
| upgrade \<name\> | `yos upgrade <name> --check --json` **(CHECK ONLY)** |
| upgrade \<name\> confirm | `yos upgrade <name> --yes --skip-eval --json` |
| upgrade \<name\> beta | `yos upgrade <name> --check --beta --json` **(CHECK ONLY)** |
| upgrade \<name\> beta confirm | `yos upgrade <name> --yes --skip-eval --beta --json` |
| add \<name\> | `yos add <name> --check --json` **(CHECK ONLY)** |
| add \<name\> confirm | `yos add <name> --json` |
| upgrade yos | `yos upgrade --self --check --json` **(CHECK ONLY)** |
| upgrade yos confirm | `yos upgrade --self --yes --json` |
| upgrade yos beta | `yos upgrade --self --check --beta --json` **(CHECK ONLY)** |
| upgrade yos beta confirm | `yos upgrade --self --yes --beta --json` |
| uninstall \<name\> | `yos uninstall <name> --check --json` **(CHECK ONLY)** |
| uninstall \<name\> confirm | `yos uninstall <name> confirm --json` |
| uninstall \<name\> purge | `yos uninstall <name> purge --json` |

### C4 Output Formatting

- Plain text only, no markdown
- For `info --json`: format as `<name> v<version>\nType: <type>\nRepo: <repo>\nService: <name> (<status>)`
- For `add --check --json`: format as `<name> (v<version>)\n<description>\nType: <type>\nRepo: <repo>`, ask user to confirm
- For `add --json` (install result): format as `<name> installed (v<version>)`, mention required config if any
- For `check --json`: format as `<name>: <current> -> <latest>`, actively analyze changes
- For upgrade result: format as `<name> upgraded: <from> -> <to>`, include change summary
- For errors: when JSON has both `error` and `message` fields, display `message` (human-readable)

### C4 vs Session Differences

| Aspect | Claude Session | C4 |
|--------|---------------|-----|
| Confirmation | Interactive dialog | Two-step: preview + "confirm" command |
| Output format | Rich (emoji, formatting) | Plain text only |
| Config collection | Interactive prompts | User provides via follow-up messages |
| Upgrade eval | Claude evaluation runs | Skipped (--skip-eval) |
