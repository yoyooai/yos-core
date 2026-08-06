/**
 * Which copies of YOS are allowed to write to ~/yos.
 *
 * The integration test (test/postinstall-checkout-safety.test.js) runs the real
 * postinstall from this repository, so it only ever exercises the checkout case
 * — this repository has a .git directory. These cover the rest of the decision,
 * in particular the one that has no natural home anywhere else: an unrecognised
 * layout must DECLINE. That default is the whole safety argument, and without a
 * test flipping it to "allow" was a silent, green change.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { classifyInstallContext, FORCE_ENV, formatDeclinedMessage } from '../install-context.js';

/** A file system where only the listed absolute paths exist. */
function fakeFs(existing = []) {
  const set = new Set(existing.map((p) => path.resolve(p)));
  return { existsSync: (p) => set.has(path.resolve(p)) };
}

describe('classifyInstallContext', () => {
  it('treats a copy under node_modules as an install', () => {
    const context = classifyInstallContext({
      packageRoot: '/usr/lib/node_modules/yos',
      env: {},
      fsApi: fakeFs(),
    });
    assert.equal(context.isInstall, true);
    assert.equal(context.kind, 'installed-package');
  });

  it('treats a nested node_modules copy as an install too', () => {
    const context = classifyInstallContext({
      packageRoot: '/home/someone/project/node_modules/yos',
      env: {},
      fsApi: fakeFs(),
    });
    assert.equal(context.isInstall, true);
  });

  it('does not mistake a directory merely NAMED like node_modules for one', () => {
    const context = classifyInstallContext({
      packageRoot: '/home/someone/my-node_modules-backup/yos',
      env: {},
      fsApi: fakeFs(),
    });
    assert.equal(context.isInstall, false);
  });

  it('declines a source checkout', () => {
    const context = classifyInstallContext({
      packageRoot: '/home/someone/src/yos',
      env: {},
      fsApi: fakeFs(['/home/someone/src/yos/.git']),
    });
    assert.equal(context.isInstall, false);
    assert.equal(context.kind, 'source-checkout');
  });

  it('DECLINES an unrecognised layout — neither node_modules nor a checkout', () => {
    const context = classifyInstallContext({
      packageRoot: '/opt/somewhere/yos',
      env: {},
      fsApi: fakeFs(),
    });
    assert.equal(context.isInstall, false, 'an unrecognised layout must not write to ~/yos');
    assert.equal(context.kind, 'unrecognised-layout');
  });

  it('lets the force switch override a declined layout', () => {
    for (const packageRoot of ['/home/someone/src/yos', '/opt/somewhere/yos']) {
      const context = classifyInstallContext({
        packageRoot,
        env: { [FORCE_ENV]: '1' },
        fsApi: fakeFs([`${packageRoot}/.git`]),
      });
      assert.equal(context.isInstall, true);
      assert.equal(context.kind, 'forced');
    }
  });

  it('refuses to guess when given no package root', () => {
    assert.throws(() => classifyInstallContext({ packageRoot: '' }), TypeError);
    assert.throws(() => classifyInstallContext({ packageRoot: undefined }), TypeError);
  });

  it('names the reason and the override in the declined message', () => {
    const context = classifyInstallContext({
      packageRoot: '/opt/somewhere/yos',
      env: {},
      fsApi: fakeFs(),
    });
    const message = formatDeclinedMessage(context);
    assert.match(message, /declining to write/);
    assert.match(message, new RegExp(FORCE_ENV));
  });
});
