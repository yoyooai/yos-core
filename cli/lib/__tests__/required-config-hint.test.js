import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { describeRequiredConfig } from '../env.js';

/**
 * A channel that stops for want of credentials names the two values it needs.
 * Naming them is not the same as telling the customer where they come from --
 * and the component already declares that, so leaving it out was our omission,
 * not missing information.
 */

const ADD_SOURCE = fs.readFileSync(new URL('../../commands/add.js', import.meta.url), 'utf8');

describe('the missing-configuration message says where the values come from', () => {
  it('pairs each unset name with what the component declared about it', () => {
    const required = [
      { name: 'FEISHU_APP_ID', description: 'App ID (open.feishu.cn/app -> Credentials)' },
      { name: 'FEISHU_APP_SECRET', description: 'App Secret (same page as App ID)', sensitive: true },
    ];
    const described = describeRequiredConfig(required, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
    assert.deepEqual(described, [
      { name: 'FEISHU_APP_ID', description: 'App ID (open.feishu.cn/app -> Credentials)' },
      { name: 'FEISHU_APP_SECRET', description: 'App Secret (same page as App ID)' },
    ]);
  });

  it('describes only what was asked for, in the order asked', () => {
    const required = [
      { name: 'A', description: 'first' },
      { name: 'B', description: 'second' },
      { name: 'C', description: 'third' },
    ];
    assert.deepEqual(describeRequiredConfig(required, ['C', 'A']), [
      { name: 'C', description: 'third' },
      { name: 'A', description: 'first' },
    ]);
  });

  it('degrades to an empty description rather than inventing one', () => {
    // Bare strings and description-less objects are both legal declarations.
    assert.deepEqual(describeRequiredConfig(['TOKEN'], ['TOKEN']), [{ name: 'TOKEN', description: '' }]);
    assert.deepEqual(describeRequiredConfig([{ name: 'TOKEN' }], ['TOKEN']), [{ name: 'TOKEN', description: '' }]);
    assert.deepEqual(describeRequiredConfig(undefined, ['TOKEN']), [{ name: 'TOKEN', description: '' }]);
    assert.deepEqual(describeRequiredConfig([{ name: 'TOKEN', description: '   ' }], ['TOKEN']), [
      { name: 'TOKEN', description: '' },
    ]);
  });

  it('is actually wired into the branch that reports a channel that will not stay up', () => {
    // Without this the helper can exist, be tested, and never run -- the same
    // way a guardrail passed on 2026-08-05 while the code path went around it.
    const branch = ADD_SOURCE.slice(ADD_SOURCE.indexOf('const unset = findUnsetRequiredConfig(config.required)'));
    assert.match(branch.slice(0, 900), /describeRequiredConfig\(config\.required, unset\)/);
    assert.match(ADD_SOURCE, /import \{[^}]*describeRequiredConfig[^}]*\} from '\.\.\/lib\/env\.js'/);
  });
});
