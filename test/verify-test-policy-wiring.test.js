import { describe, expect, test } from '@jest/globals';

import { runVerification } from '../scripts/verify.js';

describe('verification test-policy wiring', () => {
  test('runs the test policy before packaging and fails closed', () => {
    const calls = [];
    const common = {
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyVersionsImpl: () => calls.push('version'),
      verifyExecutedTestsImpl: () => {
        calls.push('tests');
        return { jest: 193, node: 1063 };
      },
      testBaselines: { jest: { minimumPassed: 186 }, node: { minimumPassed: 1063 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    };

    expect(runVerification({
      ...common,
      verifyTestPolicyImpl: () => calls.push('policy'),
    })).toBe(true);
    expect(calls).toEqual(['policy', 'version', 'tests', 'audit', 'pack']);

    calls.length = 0;
    expect(runVerification({
      ...common,
      verifyTestPolicyImpl: () => {
        calls.push('policy');
        throw new Error('policy unavailable');
      },
    })).toBe(false);
    expect(calls).toEqual(['policy']);
  });

  test('fails closed when executed-test accounting fails before audits and packaging', () => {
    const calls = [];
    expect(runVerification({
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyTestPolicyImpl: () => calls.push('policy'),
      verifyVersionsImpl: () => calls.push('version'),
      verifyExecutedTestsImpl: () => {
        calls.push('tests');
        throw new Error('test count below baseline');
      },
      testBaselines: { jest: { minimumPassed: 186 }, node: { minimumPassed: 1063 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    })).toBe(false);
    expect(calls).toEqual(['policy', 'version', 'tests']);
  });

  test('fails closed when executed-test accounting is replaced with a no-op', () => {
    const calls = [];
    expect(runVerification({
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyTestPolicyImpl: () => calls.push('policy'),
      verifyVersionsImpl: () => calls.push('version'),
      verifyExecutedTestsImpl: () => {
        calls.push('tests');
        return undefined;
      },
      testBaselines: { jest: { minimumPassed: 186 }, node: { minimumPassed: 1063 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    })).toBe(false);
    expect(calls).toEqual(['policy', 'version', 'tests']);
  });

  test('fails closed when the working tree cannot be inspected', () => {
    expect(runVerification({
      root: '/unused',
      runPrerequisites: false,
      gitStatusImpl: () => { throw new Error('git unavailable'); },
      verifyTestPolicyImpl: () => { throw new Error('must not run'); },
      verifyReproduciblePackImpl: () => { throw new Error('must not run'); },
    })).toBe(false);
  });
});
