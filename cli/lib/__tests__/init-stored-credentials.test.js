/**
 * `yos init` must read the credential yos itself stored, and must name a
 * key/runtime mismatch instead of describing it as a typo.
 *
 * Regression 1: every other part of the product reads ~/yos/.env — the runtime
 * adapter injects it at launch, doctor checks against it — but init read only
 * process.env and CLI flags. A key written into ~/yos/.env was invisible to
 * init, which then reported "not authenticated" and asked for a key the user
 * had already provided.
 *
 * Regression 2: handing the Claude runtime an OpenAI key produced "Invalid API
 * key. It should start with sk-ant-", which reads as a typo. The user's actual
 * mistake — wrong vendor for this runtime — was never named.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { readStoredCredentials, validateInitOptions } = await import('../../commands/init.js');

/** Stand-in for readEnvFile()'s Map-like return. */
const storedEnv = (entries) => () => new Map(Object.entries(entries));

const baseOpts = {
  setupToken: null, apiKey: null, codexApiKey: null,
  runtime: 'claude', timezone: null, domain: null, baseUrl: null,
};

describe('readStoredCredentials', () => {
  test('finds an API key that was written into the stored env file', () => {
    const creds = readStoredCredentials(storedEnv({ ANTHROPIC_API_KEY: 'sk-ant-stored' }));
    assert.equal(creds.apiKey, 'sk-ant-stored');
  });

  test('finds a stored setup token', () => {
    const creds = readStoredCredentials(storedEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-stored' }));
    assert.equal(creds.setupToken, 'sk-ant-oat-stored');
  });

  test('accepts either name for a stored OpenAI key', () => {
    assert.equal(readStoredCredentials(storedEnv({ OPENAI_API_KEY: 'sk-a' })).codexApiKey, 'sk-a');
    assert.equal(readStoredCredentials(storedEnv({ CODEX_API_KEY: 'sk-b' })).codexApiKey, 'sk-b');
  });

  test('returns empty strings when nothing is stored', () => {
    assert.deepEqual(readStoredCredentials(storedEnv({})),
      { setupToken: '', apiKey: '', codexApiKey: '' });
  });

  test('an unreadable env file means "nothing stored", not a crash', () => {
    // Init must still run on a machine with no ~/yos/.env yet.
    const creds = readStoredCredentials(() => { throw new Error('ENOENT'); });
    assert.deepEqual(creds, { setupToken: '', apiKey: '', codexApiKey: '' });
  });
});

describe('validateInitOptions — key/runtime mismatch', () => {
  test('names the vendor mismatch when an OpenAI key is given to Claude', () => {
    const err = validateInitOptions({ ...baseOpts, apiKey: 'sk-proj-abc123' });
    assert.match(err, /OpenAI key/);
    assert.match(err, /Claude runtime/);
    assert.match(err, /--runtime codex/, 'must say what to do instead');
  });

  test('names the mismatch in the other direction too', () => {
    const err = validateInitOptions({
      ...baseOpts, runtime: 'codex', codexApiKey: 'sk-ant-abc123',
    });
    assert.match(err, /Anthropic key/);
    assert.match(err, /--runtime claude/);
  });

  test('a plain malformed key still gets the plain message', () => {
    const err = validateInitOptions({ ...baseOpts, apiKey: 'not-a-key-at-all' });
    assert.match(err, /should start with "sk-ant-"/);
    assert.doesNotMatch(err, /OpenAI/, 'do not accuse the user of the wrong mistake');
  });

  test('a correct Anthropic key passes', () => {
    assert.equal(validateInitOptions({ ...baseOpts, apiKey: 'sk-ant-api03-real' }), null);
  });

  test('a correct OpenAI key on the Codex runtime passes', () => {
    assert.equal(
      validateInitOptions({ ...baseOpts, runtime: 'codex', codexApiKey: 'sk-proj-real' }),
      null
    );
  });
});
