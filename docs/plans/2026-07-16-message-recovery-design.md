# Durable Inbound Message Recovery Design

## Goal

When the runtime is unavailable, YOS must persist inbound work, acknowledge receipt without asking the user to resend, and automatically dispatch the original message after recovery.

## Product Contract

1. An accepted inbound message is durable before YOS sends a status acknowledgement.
2. Runtime health controls dispatch timing, not message acceptance.
3. Unhealthy intake remains `pending`; it is never marked `delivered` until dispatcher submission succeeds.
4. A supplied source message ID is unique within its channel. Repeated delivery returns the existing conversation record and does not create or notify twice.
5. After delivery retries are exhausted, the row becomes `failed`. YOS sends a content-free operational alert to the explicitly configured administrator when possible and always writes a visible error log.

## Architecture

The existing `conversations` table remains the durable queue. `c4-receive` inserts unhealthy messages as `pending` and sends a queue acknowledgement. `c4-dispatcher` already refuses to dispatch while health is not `ok`; after recovery it claims the pending row and follows the existing retry lifecycle.

Add an optional `source_message_id` column with a partial unique index on `(channel, source_message_id)`. Channel adapters should pass `--message-id`; endpoints containing a stable `msg:` or `req:` segment can supply it implicitly during the transition. Duplicate intake returns the original row without changing content or queue state.

Administrator escalation uses `YOS_ADMIN_CHANNEL` and `YOS_ADMIN_ENDPOINT`. It sends only conversation ID, source channel, endpoint and retry count, never user message content.

## Failure Handling

- Status acknowledgement failure does not discard the queued message.
- Missing administrator configuration leaves the message `failed` and emits an operator-visible log.
- A failed administrator send is logged and does not requeue the user message indefinitely.
- Database migration is additive and idempotent.

## Not Included

- Execution-level exactly-once semantics after tmux submission.
- Automatic replay of rows already marked `delivered` by older versions.
- Changes to external channel repositories beyond the new `--message-id` contract.
- A customer-facing failed-message management UI.

## Acceptance

- Unhealthy reply-capable and no-reply intake stays `pending`.
- Recovery dispatches the original queued message once.
- Duplicate source IDs return one database row.
- Retry exhaustion marks `failed` and attempts configured administrator notification.
- Existing healthy intake and status-notice cooldown behavior remain compatible.
- `npm run verify` passes.
