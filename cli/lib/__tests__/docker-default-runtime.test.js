import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'docker', 'entrypoint.sh');

function runCredentialSelection(env = {}) {
  const source = fs.readFileSync(ENTRYPOINT, 'utf8');
  const block = source.match(/RUNTIME_FLAG=""([\s\S]*?)# Build init flags/);
  assert.ok(block, 'Docker runtime credential selection must remain inspectable');
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nRUNTIME_FLAG=""${block[1]}printf '%s' "$RUNTIME_FLAG"`], {
    env: {
      PATH: process.env.PATH,
      YOS_RUNTIME: '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      OPENAI_API_KEY: '',
      CODEX_API_KEY: '',
      ...env,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function runConfigFallback(config = null) {
  const home = makeTempDir('yos-docker-runtime-');
  try {
    const yosDir = path.join(home, 'yos');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    if (config !== null) {
      fs.writeFileSync(path.join(yosDir, '.yos', 'config.json'), JSON.stringify(config));
    }
    const source = fs.readFileSync(ENTRYPOINT, 'utf8');
    const step4Source = source.slice(source.indexOf('# ── Step 4:'));
    const block = step4Source.match(/if \[ -z "\$\{YOS_RUNTIME:-\}" \]; then([\s\S]*?)\nfi\n\nstep 4/);
    assert.ok(block, 'Docker config fallback must remain inspectable');
    const result = spawnSync('bash', ['-c', `set -euo pipefail\nYOS_RUNTIME=""\nYOS_DIR=${JSON.stringify(yosDir)}\nif [ -z "\${YOS_RUNTIME:-}" ]; then${block[1]}\nfi\nprintf '%s' "$YOS_RUNTIME"`], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('Docker default runtime selection', () => {
  test('explicitly chooses Claude when only Claude credentials exist', () => {
    assert.equal(runCredentialSelection({ ANTHROPIC_API_KEY: 'claude-key' }), '--runtime claude');
  });

  test('explicitly chooses Codex when only Codex credentials exist', () => {
    assert.equal(runCredentialSelection({ OPENAI_API_KEY: 'codex-key' }), '--runtime codex');
  });

  test('leaves the runtime unresolved when both credential families exist', () => {
    assert.equal(runCredentialSelection({ ANTHROPIC_API_KEY: 'claude-key', OPENAI_API_KEY: 'codex-key' }), '');
  });

  test('falls back to Codex when config has no runtime', () => {
    assert.equal(runConfigFallback({}), 'codex');
    assert.equal(runConfigFallback(null), 'codex');
  });

  test('preserves an existing Claude runtime', () => {
    assert.equal(runConfigFallback({ runtime: 'claude' }), 'claude');
  });
});
