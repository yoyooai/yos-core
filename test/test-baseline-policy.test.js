import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import {
  loadApprovedTestBaselines,
  parseNodeTapSummary,
  verifyJestResult,
  verifyNodeTapResult,
} from '../scripts/test-baseline-policy.js';

function digest(baselines) {
  return crypto.createHash('sha256').update(JSON.stringify(baselines)).digest('hex');
}

describe('executed test baselines', () => {
  test('rejects a baseline change until its approval digest is updated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-test-baselines-'));
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
