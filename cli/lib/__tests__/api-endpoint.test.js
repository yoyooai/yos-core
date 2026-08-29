/**
 * Guards the rule that every credential/reachability probe targets the endpoint
 * the install actually uses.
 *
 * Regression this locks down: `yos init` verified API keys against
 * api.anthropic.com even when the customer configured a private gateway. Behind
 * a firewall the probe failed, init declared the (good) key invalid, refused to
 * save it, and the install came up mute. `yos doctor` had the same defect and
 * reported the vendor host reachable while the gateway in use was never checked.
 */

import assert from 'node:assert/strict';
import { before, after, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(HERE, '..', '..');

const tmpRoot = makeTempDir('yos-api-endpoint-');
const yosDir = path.join(tmpRoot, 'yos');
const claudeSettings = path.join(tmpRoot, '.claude', 'settings.json');
const codexConfig = path.join(tmpRoot, '.codex', 'config.toml');

const originalEnv = {
  HOME: process.env.HOME,
  YOS_DIR: process.env.YOS_DIR,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
};

let endpoint;

before(async () => {
  // config.js freezes YOS_DIR at import time — set the environment first.
  process.env.HOME = tmpRoot;
  process.env.YOS_DIR = yosDir;
  fs.mkdirSync(yosDir, { recursive: true });
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  endpoint = await import('../api-endpoint.js');
});

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(yosDir, '.env'), { force: true });
  fs.rmSync(claudeSettings, { force: true });
  fs.rmSync(codexConfig, { force: true });
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
});

describe('resolveClaudeBaseUrl', () => {
  test('falls back to the official endpoint when nothing is configured', () => {
    assert.equal(endpoint.resolveClaudeBaseUrl(), endpoint.OFFICIAL_CLAUDE_BASE_URL);
  });

  test('an explicit override wins over every stored value', () => {
    fs.writeFileSync(path.join(yosDir, '.env'), 'ANTHROPIC_BASE_URL=https://stored.example.com\n');
    process.env.ANTHROPIC_BASE_URL = 'https://ambient.example.com';

    assert.equal(
      endpoint.resolveClaudeBaseUrl('https://flag.example.com'),
      'https://flag.example.com'
    );
  });

  test('reads the gateway from ~/yos/.env', () => {
    fs.writeFileSync(path.join(yosDir, '.env'), 'ANTHROPIC_BASE_URL=https://gw.example.com/anthropic\n');
    assert.equal(endpoint.resolveClaudeBaseUrl(), 'https://gw.example.com/anthropic');
  });

  test('reads the gateway from ~/.claude/settings.json when .env is silent', () => {
    fs.writeFileSync(claudeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://settings.example.com' } }));
    assert.equal(endpoint.resolveClaudeBaseUrl(), 'https://settings.example.com');
  });

  test('falls back to the ambient environment last', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://ambient.example.com';
    assert.equal(endpoint.resolveClaudeBaseUrl(), 'https://ambient.example.com');
  });

  test('strips trailing slashes and quotes so probe URLs stay well-formed', () => {
    fs.writeFileSync(path.join(yosDir, '.env'), 'ANTHROPIC_BASE_URL="https://gw.example.com/"\n');
    assert.equal(endpoint.resolveClaudeBaseUrl(), 'https://gw.example.com');
  });

  test('ignores an empty configured value instead of probing an empty host', () => {
    fs.writeFileSync(path.join(yosDir, '.env'), 'ANTHROPIC_BASE_URL=\n');
    assert.equal(endpoint.resolveClaudeBaseUrl(), endpoint.OFFICIAL_CLAUDE_BASE_URL);
  });
});

describe('resolveCodexBaseUrl', () => {
  test('falls back to the official endpoint when nothing is configured', () => {
    assert.equal(endpoint.resolveCodexBaseUrl(), endpoint.OFFICIAL_CODEX_BASE_URL);
  });

  test('reads openai_base_url from ~/.codex/config.toml', () => {
    fs.writeFileSync(codexConfig, 'model = "gpt-5.6"\nopenai_base_url = "https://codex-gw.example.com/v1"\n');
    assert.equal(endpoint.resolveCodexBaseUrl(), 'https://codex-gw.example.com/v1');
  });

  test('config.toml wins over the ambient environment', () => {
    fs.writeFileSync(codexConfig, 'openai_base_url = "https://codex-gw.example.com/v1"\n');
    process.env.OPENAI_BASE_URL = 'https://ambient.example.com/v1';
    assert.equal(endpoint.resolveCodexBaseUrl(), 'https://codex-gw.example.com/v1');
  });

  test('an explicit override wins over config.toml', () => {
    fs.writeFileSync(codexConfig, 'openai_base_url = "https://codex-gw.example.com/v1"\n');
    assert.equal(endpoint.resolveCodexBaseUrl('https://flag.example.com/v1'), 'https://flag.example.com/v1');
  });
});

describe('resolveRuntimeBaseUrl', () => {
  test('dispatches on the active runtime', () => {
    assert.equal(endpoint.resolveRuntimeBaseUrl('codex'), endpoint.OFFICIAL_CODEX_BASE_URL);
    assert.equal(endpoint.resolveRuntimeBaseUrl('claude'), endpoint.OFFICIAL_CLAUDE_BASE_URL);
    // Unknown runtime must not crash the caller — default to Claude.
    assert.equal(endpoint.resolveRuntimeBaseUrl(undefined), endpoint.OFFICIAL_CLAUDE_BASE_URL);
  });
});

describe('describeEndpoint', () => {
  test('splits a gateway URL into probe parts', () => {
    const d = endpoint.describeEndpoint('https://gw.example.com:8443/anthropic');
    assert.equal(d.origin, 'https://gw.example.com:8443');
    assert.equal(d.hostname, 'gw.example.com');
    assert.equal(d.custom, true);
    assert.equal(d.isIpLiteral, false);
  });

  test('keeps a plain-http gateway on http — probing it over https would false-fail', () => {
    assert.equal(endpoint.describeEndpoint('http://10.0.0.5:3000/v1').origin, 'http://10.0.0.5:3000');
  });

  test('flags IP literals so callers skip a meaningless DNS lookup', () => {
    assert.equal(endpoint.describeEndpoint('https://10.0.0.5/v1').isIpLiteral, true);
    assert.equal(endpoint.describeEndpoint('https://gw.example.com').isIpLiteral, false);
  });

  test('marks the vendor endpoints as not custom', () => {
    assert.equal(endpoint.describeEndpoint(endpoint.OFFICIAL_CLAUDE_BASE_URL).custom, false);
    assert.equal(endpoint.describeEndpoint(endpoint.OFFICIAL_CODEX_BASE_URL).custom, false);
  });

  test('degrades to the fallback on an unparseable value rather than throwing', () => {
    const d = endpoint.describeEndpoint('not-a-url', endpoint.OFFICIAL_CODEX_BASE_URL);
    assert.equal(d.origin, new URL(endpoint.OFFICIAL_CODEX_BASE_URL).origin);
  });
});

describe('buildProbeUrl', () => {
  test('appends the API path to a bare gateway', () => {
    assert.deepEqual(
      endpoint.buildProbeUrl('https://gw.example.com', '/v1/messages'),
      { url: 'https://gw.example.com/v1/messages', host: 'gw.example.com' }
    );
  });

  test('keeps a path prefix and does not double a trailing slash', () => {
    assert.equal(
      endpoint.buildProbeUrl('https://gw.example.com/anthropic/', '/v1/messages').url,
      'https://gw.example.com/anthropic/v1/messages'
    );
  });

  test('does not duplicate /v1 when the base URL already ends in it', () => {
    // Blind concatenation yields /v1/v1/models, which a gateway answers 404 —
    // indistinguishable from a bad key unless the path is right.
    assert.equal(
      endpoint.buildProbeUrl('https://gw.example.com/v1', '/v1/models').url,
      'https://gw.example.com/v1/models'
    );
  });

  test('preserves scheme and port for a private http gateway', () => {
    assert.deepEqual(
      endpoint.buildProbeUrl('http://10.0.0.5:3000/v1', '/v1/models'),
      { url: 'http://10.0.0.5:3000/v1/models', host: '10.0.0.5:3000' }
    );
  });

  test('refuses a non-http scheme instead of probing it', () => {
    assert.equal(endpoint.buildProbeUrl('ftp://gw.example.com', '/v1/models'), null);
  });

  test('refuses an unparseable base URL', () => {
    assert.equal(endpoint.buildProbeUrl('not-a-url', '/v1/models'), null);
  });
});

describe('no probe hardcodes a vendor endpoint', () => {
  // api-endpoint.js is the only place allowed to name the vendors' hosts.
  // Anything else that names them is probing a host the install may not use.
  const GUARDED = [
    'commands/init.js',
    'commands/doctor.js',
    'lib/runtime/codex.js',
    'lib/runtime/claude.js',
    'lib/runtime-setup.js',
  ];

  for (const rel of GUARDED) {
    test(`${rel} resolves the endpoint instead of hardcoding it`, () => {
      const source = fs.readFileSync(path.join(CLI_DIR, rel), 'utf8');
      const offenders = source
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /\bapi\.(anthropic|openai)\.com\b/.test(line));

      assert.deepEqual(
        offenders,
        [],
        `${rel} names a vendor API host directly; import from lib/api-endpoint.js instead:\n` +
          offenders.map(([n, line]) => `  ${n}: ${line.trim()}`).join('\n')
      );
    });
  }
});
