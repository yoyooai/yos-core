/**
 * A source checkout must not write to ~/yos.
 *
 * On 2026-08-01 a plain `npm ci` inside a candidate checkout replaced five live
 * skill directories and rewrote two Codex configs on a machine whose services
 * kept serving the old code from memory (TD-39). The action was development;
 * the damage was production.
 *
 * These tests run the REAL scripts/postinstall.js as a child process from this
 * repository — which is itself a source checkout, the exact situation that used
 * to cause the damage. Nothing is stubbed and no alternate implementation is
 * injected, so deleting the guard turns the first test red rather than leaving
 * it green against a test double.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSTINSTALL = path.join(REPO_ROOT, 'scripts', 'postinstall.js');

/** A fake ~/yos that looks initialized and holds one hand-edited core skill. */
function makeFakeYosDir() {
  const yosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-postinstall-test-'));
  const skillDir = path.join(yosDir, '.claude', 'skills', 'comm-bridge');
  fs.mkdirSync(skillDir, { recursive: true });
  const sentinel = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(sentinel, 'LOCAL EDIT — must survive a checkout npm ci\n', 'utf8');
  return { yosDir, sentinel };
}

function runPostinstall(yosDir, extraEnv = {}) {
  const env = { ...process.env, YOS_DIR: yosDir, ...extraEnv };
  // CI short-circuits postinstall entirely, which would make these tests
  // vacuous on a CI runner. Clear it so the real decision path executes.
  delete env.CI;
  delete env.YOS_POSTINSTALL_FORCE;
  for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  return spawnSync(process.execPath, [POSTINSTALL], { env, encoding: 'utf8' });
}

describe('postinstall in a source checkout', () => {
  test('leaves a hand-edited live skill byte-for-byte untouched', () => {
    const { yosDir, sentinel } = makeFakeYosDir();
    const before = fs.readFileSync(sentinel);

    const result = runPostinstall(yosDir);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(sentinel)).toEqual(before);
  });

  test('says why it declined, and how to override', () => {
    const { yosDir } = makeFakeYosDir();

    const result = runPostinstall(yosDir);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).toMatch(/source checkout/i);
    expect(output).toMatch(/Nothing in ~\/yos was modified/i);
    expect(output).toMatch(/YOS_POSTINSTALL_FORCE/);
  });

  test('does not create a skills tree that was not already there', () => {
    const yosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-postinstall-test-'));
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });

    const result = runPostinstall(yosDir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(yosDir, '.claude', 'skills'))).toBe(false);
  });

  // The counterpart: the guard is the ONLY thing holding the sync back. If this
  // went green while the tests above also went green, the sync would be broken
  // rather than guarded, and the first test would prove nothing.
  test('with the force switch, the same run does sync — proving the guard, not a broken sync, stopped it', () => {
    const { yosDir, sentinel } = makeFakeYosDir();
    const before = fs.readFileSync(sentinel);

    const result = runPostinstall(yosDir, { YOS_POSTINSTALL_FORCE: '1' });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(sentinel)).not.toEqual(before);
  });
});
