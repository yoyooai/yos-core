import { describe, expect, test } from '@jest/globals';

import { runVerification, verifyExecutedTestCounts } from '../scripts/verify.js';

describe('verification test-policy wiring', () => {
  test('runs the test policy before packaging and fails closed', () => {
    const calls = [];
    const common = {
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyProgressLogImpl: () => {},
      verifyVersionsImpl: () => calls.push('version'),
      verifyExecutedTestsImpl: () => {
        calls.push('tests');
        return { jest: 193, node: 1063 };
      },
      verifyExecutedTestCountsImpl: (counts) => {
        calls.push('counts');
        return counts;
      },
      testBaselines: { jest: { minimumPassed: 186 }, node: { minimumPassed: 1063 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    };

    expect(runVerification({
      ...common,
      verifyTestPolicyImpl: () => calls.push('policy'),
    })).toBe(true);
    expect(calls).toEqual(['policy', 'version', 'tests', 'counts', 'audit', 'pack']);

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

  test('fails closed when executed-test validation fails before audits and packaging', () => {
    const calls = [];
    expect(runVerification({
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyProgressLogImpl: () => {},
      verifyTestPolicyImpl: () => calls.push('policy'),
      verifyVersionsImpl: () => calls.push('version'),
      verifyExecutedTestsImpl: () => {
        calls.push('tests');
        return { jest: 185, node: 1062 };
      },
      verifyExecutedTestCountsImpl: () => {
        calls.push('counts');
        throw new Error('test count below baseline');
      },
      testBaselines: { jest: { minimumPassed: 186 }, node: { minimumPassed: 1063 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    })).toBe(false);
    expect(calls).toEqual(['policy', 'version', 'tests', 'counts']);
  });

  test('fails closed when the test gate returns invalid recorded counts', () => {
    for (const invalidCounts of [true, {}, undefined]) {
      const calls = [];
      expect(runVerification({
        root: '/unused',
        runPrerequisites: true,
        gitStatusImpl: () => '',
      verifyProgressLogImpl: () => {},
        verifyTestPolicyImpl: () => calls.push('policy'),
        verifyVersionsImpl: () => calls.push('version'),
        executeTestGateImpl: () => {
          calls.push('gate');
          return invalidCounts;
        },
        verifyExecutedTestCountsImpl: (counts, baselines) => {
          calls.push('counts');
          return verifyExecutedTestCounts(counts, baselines);
        },
        testBaselines: { jest: { minimumPassed: 186 }, node: { minimumPassed: 1063 } },
        verifyAuditsImpl: () => calls.push('audit'),
        verifyReproduciblePackImpl: () => calls.push('pack'),
      })).toBe(false);
      expect(calls).toEqual(['policy', 'version', 'gate', 'counts']);
    }
  });

  test('fails closed when an outer wrapper swallows the executed-test failure and returns true', () => {
    const calls = [];
    expect(runVerification({
      root: '/unused',
      runPrerequisites: true,
      gitStatusImpl: () => '',
      verifyProgressLogImpl: () => {},
      verifyTestPolicyImpl: () => calls.push('policy'),
      verifyVersionsImpl: () => calls.push('version'),
      executeTestGateImpl: () => {
        calls.push('swallowed-test-gate');
        try {
          throw new Error('test command failed');
        } catch {
          return true;
        }
      },
      verifyExecutedTestCountsImpl: (counts, baselines) => {
        calls.push('counts');
        return verifyExecutedTestCounts(counts, baselines);
      },
      testBaselines: { jest: { minimumPassed: 194 }, node: { minimumPassed: 1064 } },
      verifyAuditsImpl: () => calls.push('audit'),
      verifyReproduciblePackImpl: () => calls.push('pack'),
    })).toBe(false);
    expect(calls).toEqual(['policy', 'version', 'swallowed-test-gate', 'counts']);
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
