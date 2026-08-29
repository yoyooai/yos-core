import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import { makeTempDir } from './helpers/temp-dir.js';

import {
  loadApprovedTestBaselines,
  parseNodeTapSummary,
  verifyJestResult,
  verifyNodeTapResult,
  assertBaselineIsCurrent,
} from '../scripts/test-baseline-policy.js';

function digest(baselines) {
  return crypto.createHash('sha256').update(JSON.stringify(baselines)).digest('hex');
}

describe('executed test baselines', () => {

  // ── The floor must keep up with reality (TD-84) ──
  //
  // minimumPassed is a floor, which is right. But it was raised by hand with a
  // line in a process document asking people to remember, so tests added and
  // forgotten sat outside it: deleting them kept the gate green, reopening the
  // hole the floor exists to close, a few tests at a time.

  test('passing more than the floor fails, and says what number to write down', () => {
    expect(() => assertBaselineIsCurrent('Node', 1330, { minimumPassed: 1325 }))
      .toThrow(/passed 1330 tests but the approved floor is 1325/);
    expect(() => assertBaselineIsCurrent('Node', 1330, { minimumPassed: 1325 }))
      .toThrow(/set baselines\.Node\.minimumPassed to 1330/);
  });

  test('passing exactly the floor is the only clean state', () => {
    expect(assertBaselineIsCurrent('Jest', 249, { minimumPassed: 249 })).toBe(249);
  });

  test('a declared drift allowance is honoured, and only up to its limit', () => {
    expect(assertBaselineIsCurrent('Jest', 251, { minimumPassed: 249, driftAllowance: 2 })).toBe(251);
    expect(() => assertBaselineIsCurrent('Jest', 252, { minimumPassed: 249, driftAllowance: 2 }))
      .toThrow(/allowed drift/);
  });

  test('the drift allowance sits inside the approval digest, so it cannot be widened quietly', () => {
    const root = makeTempDir('yos-test-drift-');
    const policyPath = path.join(root, 'baselines.json');
    const tight = { jest: { minimumPassed: 10 }, node: { minimumPassed: 20 } };
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, baselines: tight, approvedDigest: digest(tight) }));
    expect(loadApprovedTestBaselines(policyPath)).toEqual(tight);

    // Widen the allowance but keep the old digest: must be rejected.
    const loose = { jest: { minimumPassed: 10, driftAllowance: 500 }, node: { minimumPassed: 20 } };
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, baselines: loose, approvedDigest: digest(tight) }));
    expect(() => loadApprovedTestBaselines(policyPath)).toThrow(/approval digest mismatch/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a negative drift allowance is not a valid declaration', () => {
    const root = makeTempDir('yos-test-drift-neg-');
    const policyPath = path.join(root, 'baselines.json');
    const bad = { jest: { minimumPassed: 10, driftAllowance: -1 }, node: { minimumPassed: 20 } };
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, baselines: bad, approvedDigest: digest(bad) }));
    expect(() => loadApprovedTestBaselines(policyPath)).toThrow(/driftAllowance must be a non-negative integer/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('⭐ the two real verifiers route through the lock, not just the helper', () => {
    // Asserting the helper alone would let someone unwire it and stay green.
    expect(() => verifyJestResult(
      { numPassedTests: 300, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 },
      { minimumPassed: 249 },
    )).toThrow(/approved floor is 249/);

    const tap = ['# tests 1400', '# pass 1400', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0'].join('\n');
    expect(() => verifyNodeTapResult(tap, { minimumPassed: 1325 })).toThrow(/approved floor is 1325/);
  });
  test('rejects a baseline change until its approval digest is updated', () => {
    const root = makeTempDir('yos-test-baselines-');
    const policyPath = path.join(root, 'baselines.json');
    const baselines = {
      jest: { minimumPassed: 186 },
      node: { minimumPassed: 1063 },
    };
    fs.writeFileSync(policyPath, JSON.stringify({
      version: 1,
      baselines,
      approvedDigest: digest({ ...baselines, jest: { minimumPassed: 3 } }),
    }));

    expect(() => loadApprovedTestBaselines(policyPath)).toThrow(/approval digest mismatch/);
    fs.writeFileSync(policyPath, JSON.stringify({
      version: 1,
      baselines,
      approvedDigest: digest(baselines),
    }));
    expect(loadApprovedTestBaselines(policyPath)).toEqual(baselines);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('uses Jest passed tests rather than total tests and rejects non-passing states', () => {
    const baseline = { minimumPassed: 186 };
    expect(() => verifyJestResult({
      numPassedTests: 186,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    }, baseline)).not.toThrow();

    expect(() => verifyJestResult({
      numPassedTests: 0,
      numTotalTests: 186,
      numFailedTests: 0,
      numPendingTests: 186,
      numTodoTests: 0,
    }, baseline)).toThrow(/passed 0.*minimum 186/);
    expect(() => verifyJestResult({
      numPassedTests: 186,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
    }, baseline)).toThrow(/pending 1/);
  });

  test('parses Node TAP pass, fail, cancelled, skipped, and todo counts', () => {
    expect(parseNodeTapSummary([
      'TAP version 13',
      '# tests 1063',
      '# pass 1063',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
    ].join('\n'))).toEqual({
      tests: 1063,
      passed: 1063,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    });
  });

  test('rejects a low Node pass count and every non-passing TAP state', () => {
    const baseline = { minimumPassed: 1063 };
    const healthy = '# tests 1063\n# pass 1063\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    expect(() => verifyNodeTapResult(healthy, baseline)).not.toThrow();
    expect(() => verifyNodeTapResult(healthy.replace('# pass 1063', '# pass 613'), baseline))
      .toThrow(/passed 613.*minimum 1063/);
    expect(() => verifyNodeTapResult(healthy.replace('# skipped 0', '# skipped 1'), baseline))
      .toThrow(/skipped 1/);
    expect(() => verifyNodeTapResult(healthy.replace('# cancelled 0', '# cancelled 1'), baseline))
      .toThrow(/cancelled 1/);
    expect(() => verifyNodeTapResult(healthy.replace('# todo 0', '# todo 1'), baseline))
      .toThrow(/todo 1/);
  });

  test('fails closed when a TAP summary field is absent', () => {
    expect(() => parseNodeTapSummary('# tests 1063\n# pass 1063\n'))
      .toThrow(/missing TAP summary field/);
  });
});
