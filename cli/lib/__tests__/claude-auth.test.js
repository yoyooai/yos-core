import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const tmpDirs = [];

const fakeBinDir = makeTempDir('yos-claude-fakebin-');
const fakeClaudePath = path.join(fakeBinDir, 'claude');
const envCapturePath = path.join(fakeBinDir, 'env.json');
const fakeYOSDir = path.join(fakeBinDir, 'yos');
fs.writeFileSync(
  fakeClaudePath,
  `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_ENV_OUT, JSON.stringify({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
  CLAUDECODE: process.env.CLAUDECODE || '',
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || ''
}));
const mode = process.env.FAKE_CLAUDE_MODE || 'success';
if (mode === 'success') {
  console.log('pong');
  process.exit(0);
}
if (mode === 'not_logged_in_stdout') {
  console.log('Not logged in');
  process.exit(0);
}
if (mode === 'auth_error') {
  console.error('authentication_error');
  process.exit(1);
}
if (mode === 'rate_limit') {
  console.error('rate_limit_error');
  process.exit(1);
}
console.error('unknown failure');
process.exit(1);
`,
  { mode: 0o755 }
);

process.env.CLAUDE_BIN = fakeClaudePath;
process.env.FAKE_CLAUDE_ENV_OUT = envCapturePath;
process.env.YOS_DIR = fakeYOSDir;

after(() => { try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch {} });

const { ClaudeAdapter } = await import('../runtime/claude.js');

let originalHome;
let originalYOSDir;
let originalClaudeCode;
let originalClaudeCodeEntrypoint;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalYOSDir = process.env.YOS_DIR;
  originalClaudeCode = process.env.CLAUDECODE;
  originalClaudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;

  const tmpHome = makeTempDir('yos-claude-auth-home-');
  tmpDirs.push(tmpHome);
  fs.rmSync(fakeYOSDir, { recursive: true, force: true });
  fs.mkdirSync(fakeYOSDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeYOSDir, '.env'),
    [
      'ANTHROPIC_API_KEY=sk-ant-test',
      'CLAUDE_CODE_OAUTH_TOKEN=oauth-test',
      'ANTHROPIC_BASE_URL=https://claude-proxy.example.com',
      '',
    ].join('\n'),
    'utf8'
  );
  process.env.HOME = tmpHome;
  process.env.YOS_DIR = fakeYOSDir;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalYOSDir === undefined) delete process.env.YOS_DIR;
  else process.env.YOS_DIR = originalYOSDir;
  if (originalClaudeCode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = originalClaudeCode;
  if (originalClaudeCodeEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalClaudeCodeEntrypoint;
  delete process.env.FAKE_CLAUDE_MODE;
});

describe('Claude auth checks', () => {
  it('returns success and injects Anthropic credentials plus base URL into the probe env', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';

    const result = await new ClaudeAdapter({}).checkAuth();
    const env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-test');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://claude-proxy.example.com');
    assert.equal(env.CLAUDECODE, '');
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, '');
  });

  it('returns failure for explicit logged-out and authentication-error signals', async () => {
    const adapter = new ClaudeAdapter({});

    process.env.FAKE_CLAUDE_MODE = 'not_logged_in_stdout';
    assert.equal((await adapter.checkAuth()).status, 'failure');

    process.env.FAKE_CLAUDE_MODE = 'auth_error';
    const result = await adapter.checkAuth();
    assert.equal(result.status, 'failure');
    assert.equal(result.reason, 'cli_probe_authentication_error');
  });

  it('returns uncertain for transient probe failures', async () => {
    process.env.FAKE_CLAUDE_MODE = 'rate_limit';

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'cli_probe_uncertain');
  });
});
