import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKickPrompt } from '../kick-prompt.js';

// The kick prompt is the very first thing a Codex agent ever reads. Every
// constraint below was paid for by a real failure, so each one is pinned:
// break any of them and this file goes red rather than the damage showing up
// as odd behaviour on a customer's machine.
describe('kick prompt', () => {
  it('announces itself as a system signal rather than a human turn', () => {
    const prompt = buildKickPrompt();
    assert.match(prompt, /system startup trigger/i);
    assert.match(prompt, /not a user message/i);
  });

  it('never uses human-greeting wording (regression: reply-route misattribution)', () => {
    const prompt = buildKickPrompt();
    assert.doesNotMatch(prompt, /\bhello\b/i);
    assert.doesNotMatch(prompt, /\bhi\b/i);
    assert.doesNotMatch(prompt, /welcome back/i);
    assert.doesNotMatch(prompt, /你好/);
  });

  it('stays minimal — guidance belongs to the hook-injected startup context', () => {
    const prompt = buildKickPrompt();
    assert.ok(prompt.length <= 160,
      `kick must stay short, got ${prompt.length} chars: ${prompt}`);
  });

  it('is stateless — no first-run/resume branch encoded in the text', () => {
    assert.equal(buildKickPrompt(), buildKickPrompt());
    assert.doesNotMatch(buildKickPrompt(), /lifecycle=|resume|first run/i);
  });

  it('stays safe inside a double-quoted shell string', () => {
    // One launch branch interpolates this into `codex "<prompt>"`, so a quote,
    // dollar sign, backslash, backtick or newline would break the command or
    // let the text be evaluated by the shell.
    assert.doesNotMatch(buildKickPrompt(), /["$\\`\n]/);
  });
});
