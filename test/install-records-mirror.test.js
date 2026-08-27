/**
 * A machine must remember which mirror it was installed from.
 *
 * The installer recorded YOS_RELEASE_REPO — which repository — and stopped
 * there. The mirror was left to the built-in default on every later command, so
 * a machine installed from a private mirror resolved the public default on its
 * next upgrade and quietly left the origin it came from. On a host that cannot
 * reach the default (the reason the mirror exists at all) that machine simply
 * stops being able to upgrade, with nothing in the output saying why.
 *
 * The tests below run the installer's own `record_dist_base` text rather than a
 * restatement of it: the function lives inside `_main` and cannot be sourced, so
 * it is extracted and evaluated against a temporary HOME. Copying the condition
 * into the test would let the two drift, which is the failure this file exists
 * to catch.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(ROOT, 'scripts', 'install.sh');
const script = fs.readFileSync(INSTALL_SH, 'utf8');
const DEFAULT_DIST_BASE = 'https://dist.yoyooai.com';

/** The real `record_dist_base` definition, lifted out of `_main`. */
function extractRecorder() {
  const start = script.indexOf('record_dist_base() {');
  expect(start).toBeGreaterThan(-1);
  const end = script.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end + 3);
}

/**
 * Run the extracted recorder against a throwaway HOME.
 * @param {string|undefined} distBase value of YOS_DIST_BASE at install time
 * @returns {string} the resulting ~/yos/.env ('' when never created)
 */
function recordInto(distBase, { seedEnv = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-mirror-record-'));
  if (seedEnv !== null) {
    fs.mkdirSync(path.join(home, 'yos'), { recursive: true });
    fs.writeFileSync(path.join(home, 'yos', '.env'), seedEnv, 'utf8');
  }

  const program = [
    'set -euo pipefail',
    `DEFAULT_DIST_BASE=${JSON.stringify(DEFAULT_DIST_BASE)}`,
    `YOS_DIST_BASE=${JSON.stringify(distBase ?? DEFAULT_DIST_BASE)}`,
    extractRecorder(),
    'record_dist_base',
  ].join('\n');

  execFileSync('bash', ['-c', program], { env: { ...process.env, HOME: home }, stdio: 'pipe' });

  const envFile = path.join(home, 'yos', '.env');
  return fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
}

describe('the installer records a non-default mirror', () => {
  test('a private mirror is written to ~/yos/.env', () => {
    const written = recordInto('https://mirror.internal.example/dist');
    expect(written).toMatch(/^YOS_DIST_BASE=https:\/\/mirror\.internal\.example\/dist$/m);
  });

  test('an explicitly empty value is recorded too — "use GitHub" is a choice', () => {
    // Losing this is the same bug in the other direction: a machine deliberately
    // installed without the mirror would silently start using it again.
    const written = recordInto('');
    expect(written).toMatch(/^YOS_DIST_BASE=$/m);
  });

  test('the default is NOT recorded, so the origin behind it stays re-pointable', () => {
    // Clients are meant to know only a stable domain. Writing today's default
    // into every .env would freeze every machine onto it.
    expect(recordInto(DEFAULT_DIST_BASE)).toBe('');
    expect(recordInto(undefined)).toBe('');
  });

  test('an existing value is never overwritten', () => {
    const seeded = 'YOS_DIST_BASE=https://chosen.example/dist\n';
    const written = recordInto('https://different.example/dist', { seedEnv: seeded });
    expect(written).toBe(seeded);
  });

  test('it appends rather than replacing what is already in .env', () => {
    const seeded = 'YOS_RELEASE_REPO=yoyooai/yos-core\n';
    const written = recordInto('https://mirror.internal.example/dist', { seedEnv: seeded });
    expect(written).toContain(seeded);
    expect(written).toMatch(/YOS_DIST_BASE=https:\/\/mirror\.internal\.example\/dist/);
  });
});

describe('the recorder is actually wired in', () => {
  // A recorder nobody calls records nothing. Both install paths matter: --no-init
  // is documented, and a machine installed that way would otherwise never know
  // its own mirror.
  test('every place that records the repository also records the mirror', () => {
    const repoCalls = script.match(/^ *record_release_source$/gm) ?? [];
    const mirrorCalls = script.match(/^ *record_dist_base$/gm) ?? [];
    expect(repoCalls.length).toBeGreaterThan(0);
    expect(mirrorCalls.length).toBe(repoCalls.length);
  });

  test('the default lives in one variable, shared by the default and the comparison', () => {
    // Two spellings of the same URL is how "not the default" starts being true
    // for a value that is the default.
    expect(script).toMatch(/^DEFAULT_DIST_BASE="https:\/\/dist\.yoyooai\.com"$/m);
    expect(script).toMatch(/^YOS_DIST_BASE="\$\{YOS_DIST_BASE-\$DEFAULT_DIST_BASE\}"$/m);
    const literals = script.match(/https:\/\/dist\.yoyooai\.com/g) ?? [];
    // The URL may still appear in comments and repair hints; what must not
    // happen is a second *assignment* of it.
    const assignments = script.match(/^[A-Z_]+="https:\/\/dist\.yoyooai\.com"$/gm) ?? [];
    expect(assignments).toHaveLength(1);
    expect(literals.length).toBeGreaterThan(0);
  });
});
