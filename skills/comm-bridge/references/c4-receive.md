# c4-receive.js — Receive Interface

Receives messages from external channels and queues them for delivery to the active runtime.

Messages are written to DB with `status='pending'`. The c4-dispatcher daemon handles serial delivery to Claude via tmux.

## Usage

```bash
~/yos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel <channel> [options] --content "<message>"
```

## Options

| Option | Description |
|--------|-------------|
| `--channel <name>` | Channel name (required unless `--no-reply`) |
| `--endpoint <id>` | Endpoint identifier. Can contain multiple space-separated parts (e.g., `"chat_id topic_id"` for Lark topics) |
| `--message-id <id>` | Stable channel event/message ID. Repeated IDs in the same channel return the existing queue record |
| `--content <text>` | Message content (required) |
| `--priority <1-3>` | Priority level (default: 3) |
| `--no-reply` | Mark the message as having no reply target; defaults channel to `system` |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles |
| `--json` | Output structured JSON instead of plain text |

## Priority Levels

| Priority | Type | Description |
|----------|------|-------------|
| 1 | Urgent | System alerts, immediate execution |
| 2 | High | Important user messages |
| 3 | Normal | Default priority |

## Examples

```bash
# Standard user message from Telegram
~/yos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel telegram --endpoint 8101553026 \
    --message-id update_123456 \
    --content '[TG DM] user said: hello'

# System message (no reply routing)
~/yos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel system --priority 1 --no-reply \
    --content '[System] Check context usage'

# Idle-only delivery
~/yos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel scheduler --block-queue-until-idle \
    --content 'Run daily report'

# Lark topic (endpoint with multiple parts)
~/yos/.claude/skills/comm-bridge/scripts/c4-receive.js \
    --channel lark --endpoint "chat_xxx topic_yyy" \
    --content '[Lark] user said: hello'
```

## Message Storage And Deduplication

Inbound content is stored in the conversations DB exactly as received. `c4-receive.js` does not append reply-routing text and does not replace large messages with attachment previews.

The optional `source_message_id` column is unique together with `channel`. Channel adapters should always pass `--message-id` when the upstream platform provides one. A duplicate returns:

```json
{"ok": true, "action": "duplicate", "id": 42}
```

The existing row is not changed and no second status acknowledgement is sent.

## Health Routing

`c4-receive.js` writes the message as `pending` before asking the activity monitor MessageRouter about runtime health. If health is `ok` or recovered, normal dispatch continues. If health is unavailable, rate limited, or authentication failed, the row remains `pending`, the current channel receives a queue acknowledgement when replies are enabled, and dispatch resumes automatically after recovery. `--no-reply` messages remain pending without a status reply.

If the MessageRouter IPC is unavailable, `c4-receive.js` reads `~/yos/activity-monitor/agent-status.json` and applies the same fallback behavior. Missing, unreadable, or malformed status files fail open as `ok`.

## JSON Output

When `--json` is passed, all output uses structured JSON on stdout.

**Success:**

```json
{"ok": true, "action": "queued", "id": 42}
```

**Error:**

```json
{"ok": false, "error": {"code": "INVALID_ARGS", "message": "--content is required"}}
```

Error codes: `INVALID_ARGS`, `INTERNAL_ERROR`.

Failure to send the health/status acknowledgement is written to stderr but does not turn an already-persisted message into an intake failure.

## Fail-Open Behavior

If the status file is missing, unreadable, or contains malformed JSON, health defaults to `ok` and the message passes through normally. This ensures a broken status file never blocks message intake.

## Reply Protocol

When a queued message is delivered to the agent, c4-dispatcher adds a `reply via` suffix for inbound messages that have an endpoint. Session startup context uses the same agent-facing formatting. Stored DB content and `c4-fetch` output remain clean:

```
[TG DM] user said: hello ---- reply via: node ~/yos/.claude/skills/comm-bridge/scripts/c4-send.js "telegram" "8101553026"
```
