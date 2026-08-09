import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideCredentialPrompt,
  explainSkippedPrompt,
  hookInteractionEnv,
  requiredConfigNames,
} from '../interaction-mode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADD_JS = path.join(HERE, '..', '..', 'commands', 'add.js');

const REQUIRED = [
  { name: 'FEISHU_APP_ID', description: 'App ID (open.feishu.cn/app -> Credentials)' },
  { name: 'FEISHU_APP_SECRET', description: 'App Secret (same page as App ID)', sensitive: true },
];

describe('requiredConfigNames', () => {
  it('reads both the string form and the object form', () => {
    assert.deepEqual(requiredConfigNames(['A', { name: 'B' }]), ['A', 'B']);
  });

  it('answers empty for anything that is not a list of names', () => {
    for (const bad of [undefined, null, 'FEISHU_APP_ID', {}, [{}], [''], [null]]) {
      assert.deepEqual(requiredConfigNames(bad), [], `input: ${JSON.stringify(bad)}`);
    }
  });
});

describe('decideCredentialPrompt', () => {
  it('asks only when there is a terminal and --yes was not given', () => {
    const d = decideCredentialPrompt({ required: REQUIRED, isTTY: true, skipConfirm: false });
    assert.equal(d.ask, true);
    assert.equal(d.reason, 'interactive');
  });

  // The bug this whole module exists for: `-y` says "stop asking me things",
  // and an unattended install that stops on a credential prompt never finishes.
  it('does NOT ask when --yes was given, even on a terminal', () => {
    const d = decideCredentialPrompt({ required: REQUIRED, isTTY: true, skipConfirm: true });
    assert.equal(d.ask, false);
    assert.equal(d.reason, 'yes-flag');
    assert.deepEqual(d.names, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  });

  it('does not ask when there is no terminal, and says that is why', () => {
    const d = decideCredentialPrompt({ required: REQUIRED, isTTY: false, skipConfirm: false });
    assert.equal(d.ask, false);
    assert.equal(d.reason, 'no-tty');
    assert.deepEqual(d.names, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  });

  it('carries the names in every not-asking case, so the caller can list them', () => {
    for (const [isTTY, skipConfirm] of [[true, true], [false, false], [false, true]]) {
      const d = decideCredentialPrompt({ required: REQUIRED, isTTY, skipConfirm });
      assert.equal(d.ask, false);
      assert.deepEqual(d.names, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
    }
  });

  it('stays quiet for a component that declares no credentials', () => {
    const d = decideCredentialPrompt({ required: [], isTTY: true, skipConfirm: false });
    assert.equal(d.ask, false);
    assert.equal(d.reason, 'none-required');
    assert.equal(explainSkippedPrompt(d.reason), null, 'nothing to explain when nothing was needed');
  });
});

describe('explainSkippedPrompt', () => {
  // Not asserting the wording — asserting that a skip reason can never reach
  // the screen as a blank. A new reason without a phrase must fail here.
  it('gives a non-empty sentence for every reason that skips asking', () => {
    for (const reason of ['yes-flag', 'no-tty']) {
      const text = explainSkippedPrompt(reason);
      assert.equal(typeof text, 'string', `${reason} has no sentence`);
      assert.ok(text.trim().length > 0, `${reason} explains nothing`);
    }
  });

  it('explains nothing when we did ask, or when there was nothing to ask', () => {
    assert.equal(explainSkippedPrompt('interactive'), null);
    assert.equal(explainSkippedPrompt('none-required'), null);
  });
});

// Structural guards. The unit tests above prove the decision is right; these
// prove `yos add` still routes through it. Without them the decision function
// can keep passing while add.js goes back to prompting unconditionally —
// which is exactly the state this fix replaced.
describe('yos add wiring (structural)', () => {
  const source = fs.readFileSync(ADD_JS, 'utf8');

  it('asks the decision function instead of deciding inline', () => {
    assert.match(source, /decideCredentialPrompt\(/, 'add.js no longer consults decideCredentialPrompt');
    assert.match(source, /explainSkippedPrompt\(/, 'add.js no longer prints why it skipped');
  });

  it('never reaches a credential prompt except under that decision', () => {
    // Both prompt calls that collect credentials must sit inside the
    // `credentialPlan.ask` branch. If either escapes it, a --yes install can
    // stop and wait for a human again.
    const branch = source.indexOf('if (credentialPlan.ask) {');
    assert.ok(branch > 0, 'the credentialPlan.ask branch is gone');
    for (const call of ['await promptSecret(`  ${name}${hint}: `)', 'await prompt(`  ${name}${hint}: `)']) {
      const at = source.indexOf(call);
      assert.ok(at > branch, `credential prompt sits outside the ask branch: ${call}`);
    }
  });

  it('tells a terminal user that Enter skips a credential', () => {
    assert.match(source, /Press Enter to skip/, 'the bare-cursor prompt is back');
  });
});

describe('hookInteractionEnv', () => {
  // The second half of the same bug: `yos add -y` honoured the flag itself and
  // then handed the terminal to the component's post-install hook, which asked
  // its own question and hung the install. The hook has to be told.
  it('tells the hook not to ask when --yes was given', () => {
    assert.deepEqual(hookInteractionEnv({ isTTY: true, skipConfirm: true }), { YOS_ASSUME_YES: '1' });
  });

  it('tells the hook not to ask when there is no terminal', () => {
    assert.deepEqual(hookInteractionEnv({ isTTY: false, skipConfirm: false }), { YOS_ASSUME_YES: '1' });
  });

  it('says nothing when the customer is sitting there and did not pass --yes', () => {
    assert.deepEqual(hookInteractionEnv({ isTTY: true, skipConfirm: false }), {});
  });
});

describe('post-install hook wiring (structural)', () => {
  const source = fs.readFileSync(ADD_JS, 'utf8');

  it('passes the interaction mode down to the post-install hook', () => {
    // stdio:'inherit' hands the hook this terminal. If the env stops being
    // built from hookInteractionEnv, a --yes install can hang inside a hook
    // again — with nothing in this repo's own tests going red.
    const at = source.indexOf("stdio: 'inherit'");
    assert.ok(at > 0, 'the post-install hook no longer inherits stdio — re-check this guard');
    const after = source.slice(at, at + 500);
    assert.match(after, /hookInteractionEnv\(/, 'the hook is spawned without being told whether it may ask');
  });
});
