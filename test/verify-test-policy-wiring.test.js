import { describe, expect, test } from '@jest/globals';

import { runVerification } from '../scripts/verify.js';

describe('verification test-policy wiring', () => {
  test('runs the test policy before packaging and fails closed', () => {
    const calls = [];
    const common = {
      root: '/unused',
      runPrerequisites: false,
      gitStatusImpl: () => '',
      verifyReproduciblePackImpl: () => calls.push('pack'),
    };

    expect(runVerification({
      ...common,
      verifyTestPolicyImpl: () => calls.push('policy'),
    })).toBe(true);
    expect(calls).toEqual(['policy', 'pack']);

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
