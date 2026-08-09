/**
 * Two defects, one module.
 *
 * TD-114 — `yos uninstall --self` said YOS was gone while the key and gateway
 * address it had written into the customer's own ~/.claude/settings.json stayed
 * exactly where they were. Removing them blindly is not the fix either: if the
 * customer was running Claude Code before YOS existed, that key is his.
 *
 * TD-115 — registering an approved key suffix in ~/.claude.json had two
 * independent implementations. Editing one left the other behind and nothing
 * went red.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLAUDE_SETTINGS_ENV_KEYS,
  approveCustomApiKey,
  credentialSuffix,
  forgetApprovedCredentials,
  reclaimClaudeCredentials,
} from '../claude-credentials.js';

let home;
let yosDir;

function writeSettings(env) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env }, null, 2) + '\n');
}

function readSettings() {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
}

function writeYosEnv(body) {
  fs.mkdirSync(yosDir, { recursive: true });
  fs.writeFileSync(path.join(yosDir, '.env'), body);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-cred-home-'));
  yosDir = path.join(home, 'yos');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('CLAUDE_SETTINGS_ENV_KEYS', () => {
  it('names every env key YOS writes into Claude settings', () => {
    assert.deepEqual(CLAUDE_SETTINGS_ENV_KEYS, [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ]);
  });

  it('⭐ stays in step with the writers in runtime-setup.js', () => {
    // The list is only worth having if adding a fourth writer over there
    // without adding it here turns this red.
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'runtime-setup.js'), 'utf8');
    const written = [...source.matchAll(/settings\.env\.([A-Z_]+)\s*=/g)].map((m) => m[1]);
    assert.ok(written.length > 0, 'expected runtime-setup.js to write settings.env keys');
    for (const key of new Set(written)) {
      assert.ok(
        CLAUDE_SETTINGS_ENV_KEYS.includes(key),
        `runtime-setup.js writes settings.env.${key} but CLAUDE_SETTINGS_ENV_KEYS does not list it — uninstall would leave it behind`,
      );
    }
  });
});

describe('approveCustomApiKey', () => {
  it('registers the key suffix so Claude Code skips its confirmation prompt', () => {
    approveCustomApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', { home });
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.deepEqual(config.customApiKeyResponses.approved, ['fghijklmnopqrstuvwxyz'.slice(-20)]);
  });

  it('is idempotent — a second call does not duplicate the entry', () => {
    approveCustomApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', { home });
    fs.chmodSync(path.join(home, '.claude.json'), 0o644);
    approveCustomApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', { home });
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(config.customApiKeyResponses.approved.length, 1);
    assert.equal(fs.statSync(path.join(home, '.claude.json')).mode & 0o777, 0o600);
  });

  it('keeps unrelated content in ~/.claude.json', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }) + '\n');
    approveCustomApiKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', { home });
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(config.hasCompletedOnboarding, true);
  });

  it('does nothing when handed an empty credential', () => {
    assert.equal(approveCustomApiKey('', { home }), false);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
  });
});

describe('reclaimClaudeCredentials — takes back only what YOS installed', () => {
  it('removes the key and gateway address it wrote', () => {
    writeSettings({ ANTHROPIC_API_KEY: 'sk-ant-ours', ANTHROPIC_BASE_URL: 'https://gw.example.com' });
    writeYosEnv('ANTHROPIC_API_KEY=sk-ant-ours\nANTHROPIC_BASE_URL=https://gw.example.com\n');

    const result = reclaimClaudeCredentials({ home, yosDir });

    assert.deepEqual(result.removed, ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    assert.deepEqual(result.kept, []);
    assert.equal(readSettings().env, undefined);
  });

  it('⭐ keeps a value the customer changed — that key is his, not ours', () => {
    writeSettings({ ANTHROPIC_API_KEY: 'sk-ant-his-own-key' });
    writeYosEnv('ANTHROPIC_API_KEY=sk-ant-ours\n');

    const result = reclaimClaudeCredentials({ home, yosDir });

    assert.deepEqual(result.removed, []);
    assert.equal(result.kept.length, 1);
    assert.match(result.kept[0].reason, /changed since install/);
    assert.equal(readSettings().env.ANTHROPIC_API_KEY, 'sk-ant-his-own-key');
  });

  it('⭐ keeps everything when ~/yos/.env is gone — no receipt, no deletion', () => {
    writeSettings({ ANTHROPIC_API_KEY: 'sk-ant-ours' });

    const result = reclaimClaudeCredentials({ home, yosDir });

    assert.deepEqual(result.removed, []);
    assert.match(result.kept[0].reason, /cannot read/);
    assert.equal(readSettings().env.ANTHROPIC_API_KEY, 'sk-ant-ours');
  });

  it('keeps a key that is in settings but was never in our .env', () => {
    writeSettings({ ANTHROPIC_API_KEY: 'sk-ant-his' });
    writeYosEnv('ANTHROPIC_BASE_URL=https://gw.example.com\n');

    const result = reclaimClaudeCredentials({ home, yosDir });

    assert.deepEqual(result.removed, []);
    assert.match(result.kept[0].reason, /did not write it/);
  });

  it('never touches settings entries outside env', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ skipDangerousModePermissionPrompt: true, env: { ANTHROPIC_API_KEY: 'sk-ant-ours', EDITOR: 'vim' } }, null, 2),
    );
    writeYosEnv('ANTHROPIC_API_KEY=sk-ant-ours\n');

    reclaimClaudeCredentials({ home, yosDir });

    const settings = readSettings();
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.env.EDITOR, 'vim');
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
  });

  it('also clears the approved suffix of the credential it removed', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    writeSettings({ ANTHROPIC_API_KEY: key });
    writeYosEnv(`ANTHROPIC_API_KEY=${key}\n`);
    approveCustomApiKey(key, { home });
    approveCustomApiKey('sk-other-credential-of-his', { home });

    const result = reclaimClaudeCredentials({ home, yosDir });

    assert.equal(result.approvedRemoved, 1);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.deepEqual(config.customApiKeyResponses.approved, [credentialSuffix('sk-other-credential-of-his')]);
  });

  it('reports nothing when there is no settings file at all', () => {
    const result = reclaimClaudeCredentials({ home, yosDir });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.kept, []);
  });

  it('tolerates an unreadable/garbage settings file instead of throwing', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), 'not json');
    const result = reclaimClaudeCredentials({ home, yosDir });
    assert.deepEqual(result.removed, []);
  });

  it('handles quoted values in .env the same as bare ones', () => {
    writeSettings({ ANTHROPIC_API_KEY: 'sk-ant-ours' });
    writeYosEnv("ANTHROPIC_API_KEY='sk-ant-ours'\n");
    const result = reclaimClaudeCredentials({ home, yosDir });
    assert.deepEqual(result.removed, ['ANTHROPIC_API_KEY']);
  });
});

describe('forgetApprovedCredentials', () => {
  it('drops only the suffixes it is given', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ customApiKeyResponses: { approved: ['aaaa', credentialSuffix('sk-ours')] } }),
    );
    const dropped = forgetApprovedCredentials(['sk-ours'], { home });
    assert.equal(dropped, 1);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.deepEqual(config.customApiKeyResponses.approved, ['aaaa']);
  });

  it('is a no-op when there is nothing to forget', () => {
    assert.equal(forgetApprovedCredentials([], { home }), 0);
  });
});
