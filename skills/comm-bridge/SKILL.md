---
name: comm-bridge
description: >-
  C4 communication bridge — central gateway for ALL external communication (Telegram, Lark, etc.).
  Use when replying to users via the "reply via" path, sending proactive messages to external channels,
  querying recent conversations or checkpoint status (prefer c4-db.js CLI; sqlite3 OK for unsupported queries),
  fetching conversation history for Memory Sync, or creating checkpoints after sync.
  Incoming messages are durably queued by channel bots and delivered to the active runtime via a PM2 dispatcher daemon.
  Session-start hooks automatically provide conversation context and can trigger Memory Sync when unsummarized conversations exceed the configured threshold.
capabilities:
  - id: communication.message
    title: Message routing
    operations: [send, receive]
    keywords: [message, communication, c4]
    stability: stable
---

# Communication Bridge (C4)

Central message hub - ALL runtime communication goes through C4.

## Architecture

```
Web Console ──┐
Telegram    ───┼──► C4 Bridge ◄──► Active runtime
Lark        ───┘
```

## Components

| Script | Purpose | Reference |
|--------|---------|-----------|
| `c4-receive.js` | External → Claude (queue incoming messages) | [c4-receive](references/c4-receive.md) |
| `c4-send.js` | Claude → External (route outgoing messages) | [c4-send](references/c4-send.md) |
| `c4-control.js` | System control plane (heartbeat, maintenance) | [c4-control](references/c4-control.md) |
| `c4-dispatcher.js` | PM2 daemon: polls pending queue, delivers to tmux | — |
| `c4-session-init.js` | Hook (session start): context + Memory Sync trigger | [hooks](references/hooks.md) |
| `c4-fetch.js` | Fetch conversations by id range | [c4-fetch](references/c4-fetch.md) |
| `c4-db.js` | Database module and CLI for querying conversations and checkpoints | [c4-db](references/c4-db.md) |
| `c4-checkpoint.js` | Create/query checkpoints (sync boundaries) | [c4-checkpoint](references/c4-checkpoint.md) |

## Sending Messages

```bash
# Send to Telegram DM
cat <<'EOF' | node ~/yos/.claude/skills/comm-bridge/scripts/c4-send.js telegram 8101553026
Hello! Quotes, $vars, **markdown** — all safe via stdin.
EOF

# Send to Lark group thread
cat <<'EOF' | node ~/yos/.claude/skills/comm-bridge/scripts/c4-send.js lark "chat_xxx|type:group|root:msg_yyy"
Report ready.
EOF
```

Always pipe messages via stdin heredoc — never pass as CLI arguments. See [c4-send](references/c4-send.md) for full reference.
Treat the heredoc wrapper as fixed shell syntax: only the message body goes between the start line and the closing terminator line, and the terminator itself must never be copied into the actual outgoing message.

## Database

SQLite at `~/yos/comm-bridge/c4.db`:
- `conversations`: All messages (in/out) with priority, status, retry tracking and optional source-message deduplication
- `checkpoints`: Recovery points with conversation id ranges
- `control_queue`: System control messages (heartbeat, maintenance) with priority, ack deadlines, and status lifecycle

## Health & Status

The activity monitor writes `~/yos/activity-monitor/agent-status.json` which includes a `health` field:

| Value | Meaning |
|-------|---------|
| `ok` | System healthy, messages accepted normally |
| `recovering` | Legacy persisted liveness state; normalized to unavailable at runtime |
| `down` | Legacy persisted liveness state; normalized to unavailable at runtime |

**Fail-open semantics**: If the status file is missing or malformed, health is assumed `ok` — intake is never blocked by a read failure.

When health is not `ok`, `c4-receive.js` still writes the original message as `pending` before sending a status acknowledgement. The dispatcher waits while the runtime is unhealthy and automatically delivers the pending message after recovery. Status-notice cooldowns suppress repeated notices without changing or discarding the original content.

Channel adapters should pass their stable event/message ID through `--message-id`. Repeated `(channel, message-id)` intake returns the existing row and is not dispatched twice. Endpoints containing a `msg:` or `req:` segment are supported as a transitional implicit source ID.

If delivery reaches `MAX_RETRIES`, the row becomes `failed`. Configure both `YOS_ADMIN_CHANNEL` and `YOS_ADMIN_ENDPOINT` to receive a metadata-only operational alert; user message content is never included.

## Keystroke Delivery

The dispatcher supports `[KEYSTROKE]` control messages for sending raw keystrokes to the tmux session. This is an **ops-level capability** — no source gating is applied.

When a control message content starts with `[KEYSTROKE]`, the dispatcher:
- Extracts the key name (e.g., `Enter`, `Tab`, `Escape`)
- Sends it directly via `tmux send-keys` (no buffer paste, no "Meanwhile" prefix, no verification)
- Auto-acks the control immediately after delivery

Example: the permission auto-approve hook enqueues `[KEYSTROKE]Enter` at priority 0 with bypass-state to auto-confirm Claude Code's permission prompts.

Any process with access to `c4-control.js` can enqueue keystroke controls. This mirrors the existing reality that any process can call `tmux send-keys` directly — the C4 queue adds priority ordering and delivery guarantees, not access control.

## Service Management

```bash
pm2 status c4-dispatcher
pm2 logs c4-dispatcher
pm2 restart c4-dispatcher
```
