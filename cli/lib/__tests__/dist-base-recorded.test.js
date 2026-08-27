/**
 * The CLI must honour the mirror recorded on the machine.
 *
 * Recording it at install time is only half the fix. The CLI is invoked from a
 * plain shell that never loads ~/yos/.env, so without this fallback the recorded
 * value is a note nobody reads and the machine still resolves the built-in
 * default on its next upgrade — the whole point of TD-102.
 *
 * The other half is a boundary that is easy to get wrong in the dangerous
 * direction: the fallback must apply to the real process environment ONLY.
 * A caller that passes an explicit env object is stating the entire environment
 * on purpose (that is how the acceptance runs pin a local mirror, and how these
 * tests stay hermetic); reading this machine's file behind its back would make
 * every such caller depend on whatever happens to be installed here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDistBase } from '../dist-origin.js';

const DEFAULT = 'https://dist.yoyooai.com';
const recorded = (map) => () => new Map(Object.entries(map));

describe('resolveDistBase with a recorded mirror', () => {
  it('uses the recorded mirror when the shell says nothing', () => {
    const result = resolveDistBase(process.env, {
      readEnvFile: recorded({ YOS_DIST_BASE: 'https://mirror.internal.example/dist' }),
    });
    assert.deepEqual(result, { enabled: true, base: 'https://mirror.internal.example/dist' });
  });

  it('honours a recorded empty value as "mirror deliberately off"', () => {
    // Present-but-empty and absent are different answers, and collapsing them
    // would silently switch the mirror back on for a machine installed without it.
    const result = resolveDistBase(process.env, {
      readEnvFile: recorded({ YOS_DIST_BASE: '' }),
    });
    assert.deepEqual(result, { enabled: false, base: null });
  });

  it('falls back to the built-in default when nothing was recorded', () => {
    const result = resolveDistBase(process.env, { readEnvFile: recorded({}) });
    assert.deepEqual(result, { enabled: true, base: DEFAULT });
  });

  it('lets the shell win over the recorded value', () => {
    // An explicit YOS_DIST_BASE in front of a command is how a human overrides
    // the machine's own record for one run.
    const result = resolveDistBase(
      { ...process.env, YOS_DIST_BASE: 'https://one-off.example/dist' },
      { readEnvFile: recorded({ YOS_DIST_BASE: 'https://mirror.internal.example/dist' }) }
    );
    assert.equal(result.base, 'https://one-off.example/dist');
  });

  it('does NOT read the machine file for an explicit env object', () => {
    let read = 0;
    const result = resolveDistBase({}, {
      readEnvFile: () => { read += 1; return new Map([['YOS_DIST_BASE', 'https://leaked.example/dist']]); },
    });
    assert.equal(read, 0, 'an explicit environment is the whole environment');
    assert.equal(result.base, DEFAULT);
  });

  it('survives an unreadable machine file instead of failing the command', () => {
    const result = resolveDistBase(process.env, {
      readEnvFile: () => { throw new Error('EACCES'); },
    });
    assert.deepEqual(result, { enabled: true, base: DEFAULT });
  });

  it('still rejects a malformed recorded value rather than silently ignoring it', () => {
    // A typo in the recorded mirror has to be loud: quietly reverting to the
    // default is the coin flip dist-origin.js exists to remove.
    assert.throws(
      () => resolveDistBase(process.env, { readEnvFile: recorded({ YOS_DIST_BASE: 'http://mirror.example/dist' }) }),
      /https/
    );
  });
});
