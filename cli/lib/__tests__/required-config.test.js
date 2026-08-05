import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findUnsetRequiredConfig } from '../env.js';

const readEnv = (entries) => () => new Map(Object.entries(entries));

describe('finding the required config a component has no value for', () => {
  it('reports the declared names that are set nowhere', () => {
    const unset = findUnsetRequiredConfig(
      [{ name: 'FEISHU_APP_ID' }, { name: 'FEISHU_APP_SECRET', sensitive: true }],
      { env: {}, readEnv: readEnv({}) },
    );
    assert.deepEqual(unset, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  });

  it('accepts a value from either .env or the environment', () => {
    const unset = findUnsetRequiredConfig(
      ['A', 'B', 'C'],
      { env: { B: 'from-process' }, readEnv: readEnv({ A: 'from-file' }) },
    );
    assert.deepEqual(unset, ['C']);
  });

  it('treats a present-but-empty value as unset', () => {
    // An .env line left as `FEISHU_APP_ID=` is the most common half-configured
    // state; calling it configured would send the user looking in the wrong place.
    const unset = findUnsetRequiredConfig(['A', 'B'], { env: { B: '   ' }, readEnv: readEnv({ A: '' }) });
    assert.deepEqual(unset, ['A', 'B']);
  });

  it('accepts both the string and object spellings of a declaration', () => {
    const unset = findUnsetRequiredConfig(
      ['PLAIN', { name: 'OBJECT' }, { description: 'no name' }, null],
      { env: {}, readEnv: readEnv({}) },
    );
    assert.deepEqual(unset, ['PLAIN', 'OBJECT']);
  });

  it('reports nothing when the component declares nothing', () => {
    assert.deepEqual(findUnsetRequiredConfig(undefined, { env: {}, readEnv: readEnv({}) }), []);
    assert.deepEqual(findUnsetRequiredConfig([], { env: {}, readEnv: readEnv({}) }), []);
  });
});
