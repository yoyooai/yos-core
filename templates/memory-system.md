> **YOS-managed reference.** This file is replaced during upgrades. It is not
> loaded into every session — read it when you are about to write to memory
> and are unsure where something goes.

# Memory System Reference

Persistent memory lives in `~/yos/memory/`. The always-loaded files are lean
summaries; the on-demand files hold the full context.

## Memory Tiers

| Tier | Path | Purpose | Loading |
|------|------|---------|---------|
| **Identity** | `memory/identity.md` | Bot soul: personality, principles, digital assets | Always (session start) |
| **Custom** | `custom-hooks/session-start/*.md` | Operator-placed standing directives (machine-local); not agent-managed | Always (session start) |
| **State** | `memory/state.md` | Active work, pending tasks | Always (session start) |
| **References** | `memory/references.md` | Pointers to config files, key paths | Always (session start) |
| **User Profiles** | `memory/users/<id>/profile.md` | Per-user preferences | On demand |
| **Reference** | `memory/reference/*.md` | Decisions, projects, shared prefs, ideas | On demand |
| **Sessions** | `memory/sessions/current.md` | Today's event log | On demand |
| **Archive** | `memory/archive/` | Cold storage | Rarely |

## Custom Standing Directives (`custom-hooks/session-start/`)

Holds standing directives that must be in force from the first moment of
every session — machine- or deployment-local rules (toolchain constraints,
platform policies, house rules). Files are injected at every session start,
concatenated in filename order. Routing test: *"must this be active in every
session, without anyone asking?"* → here. Contrast: `identity.md` = who the
agent **is**; this directory = how this **deployment must operate**;
`reference/preferences.md` = conventions consulted on demand. Keep it small —
every line is a permanent per-session token cost; never put explanatory
readme `.md` files inside.

## Multi-User

The bot serves a team. Route user-specific preferences to
`memory/users/<id>/profile.md`. Bot identity stays in `identity.md`.

## Memory Update Practices

1. **During work:** update the appropriate memory file immediately when you
   learn something important.
2. **Memory Sync:** when triggered, read
   `~/yos/.claude/skills/yos-memory/SKILL.md` and launch the background
   subagent exactly as it specifies (runtime-appropriate launch mechanics are
   documented there). Do not run Memory Sync inline when a background
   mechanism is available.
3. **references.md is a pointer file with strict content rules.** Allowed:
   stable identifiers, endpoints/ports, key paths, active policy pointers,
   pointers to source-of-truth files. Disallowed (route instead): version/
   incident history → `reference/decisions.md`; dead components → `archive/`;
   any value already in a config file → pointer. Target ≤8KB.
4. **state.md is an active-work file with strict content rules.** Allowed:
   current focus, genuinely pending items, blockers. Disallowed (route
   instead): completed-task narrative → `reference/projects.md`; decision
   rationale → `reference/decisions.md`; superseded detail → `archive/`.
   Target ≤10KB.

## Classification Rules for reference/ Files

- **decisions.md:** deliberate choices that close off alternatives
- **projects.md:** work efforts with defined scope and lifecycle
- **preferences.md:** standing instructions for how things should be done
  (exception: must-be-active-every-session rules → `custom-hooks/session-start/`)
- **ideas.md:** uncommitted plans, explorations, hypotheses

When in doubt, write to `sessions/current.md`.

## On-Demand Memory Loading

When you lack context to act confidently, read the relevant file first — a
file read is far cheaper than a wrong assumption. Triggers: interacting with
a user → their profile; making a decision → `decisions.md`; starting/resuming
work → `projects.md`; following a convention → `preferences.md`; exploring
ideas → `ideas.md`; recalling recent events → `sessions/current.md`;
historical info → `archive/`.
