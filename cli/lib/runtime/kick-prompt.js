// Codex kick prompt: the synthetic first message whose only job is to fire the
// SessionStart hook so startup context loads without waiting for a human. It is
// an internal lifecycle sentinel, never a human-looking greeting — a bare
// 'hello' let an agent treat the kick as a human turn and answer through a
// stale reply route, and read oddly when a session resumed after rotation.
//
// The sentinel is deliberately stateless and deliberately short: one constant
// that covers both a fresh start and a resume. Distinguishing the two would
// require persisted state plus proof that a launch actually succeeded before
// committing it — complexity nothing consumes, since the authoritative
// first-boot signal is the onboarding state in memory, not the kick text. And
// it stays one sentence because the kick only fires the hook: the real guidance
// belongs to the hook-injected startup context, and a preachy prompt would
// itself skew the agent's behaviour.
//
// The prompt is interpolated into a double-quoted shell string in one launch
// branch, so its text must stay free of `"`, `$`, backslash, and backtick.

// "from any channel" is ours, not upstream's, and it is the whole point on a
// YOS machine: every inbound message arrives through C4 carrying its own reply
// route, so an agent that mistakes the kick for a user turn does not merely
// answer nothing — it answers *somebody*, down whichever route was last in
// context. Naming the channels closes the exact door the failure walks through.
const KICK_PROMPT =
  'YOS startup signal, not a user message from any channel. Continue with startup context.';

export function buildKickPrompt() {
  return KICK_PROMPT;
}
