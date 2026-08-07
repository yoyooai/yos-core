/**
 * TD-116. A machine with a system-installed Node has a root-owned npm global
 * prefix. `install.sh` knows this and elevates to install `yos`; `yos init`
 * then installed PM2 without doing the same, so the install died one step after
 * the installer succeeded — on the very same directory, for the very same
 * reason. The advice printed on the way out blamed the registry, which is the
 * one thing that was working.
 *
 * These tests pin both halves: elevate when (and only when) the failure is a
 * permission failure and sudo needs no password, and describe the cause we
 * actually had.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const calls = { exec: [] };
const behavior = {
  // key: 'npm' | 'sudo' → outcome for that runner
  plainFails: true,
  plainPermissionDenied: true,
  sudoWorks: true,
  passwordlessSudo: true,
  binaryAfter: null, // which runner makes the binary appear
  sudoPresent: true,
  uid: 1000,
};

mock.module('node:child_process', {
  namedExports: {
    execSync() { return Buffer.from(''); },
    execFileSync(file, args) {
      calls.exec.push({ file, args });
      if (file === 'npm' && args[0] === 'config') return 'value';
      const elevated = file === 'sudo';
      if (elevated) {
        if (!behavior.sudoWorks) throw new Error('npm ERR! code E404');
        behavior.binaryAfter = 'sudo';
        return Buffer.from('');
      }
      if (behavior.plainFails) {
        const err = new Error('npm install failed');
        err.stderr = behavior.plainPermissionDenied
          ? "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/pm2"
          : 'npm error network request to https://registry.npmjs.org failed';
        throw err;
      }
      behavior.binaryAfter = 'npm';
      return Buffer.from('');
    },
    spawnSync(file, args) {
      calls.exec.push({ file, args });
      if (file === 'sudo' && args[0] === '-n' && args[1] === 'true') {
        return { status: behavior.passwordlessSudo ? 0 : 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  },
});

mock.module('../shell-utils.js', {
  namedExports: {
    commandExists(cmd) {
      if (cmd === 'sudo') return behavior.sudoPresent;
      return behavior.binaryAfter !== null;
    },
  },
});

const {
  installGlobalPackageWithFallback,
  describeNpmInstallFailure,
} = await import('../runtime-setup.js');

function reset(overrides = {}) {
  calls.exec.length = 0;
  Object.assign(behavior, {
    plainFails: true,
    plainPermissionDenied: true,
    sudoWorks: true,
    passwordlessSudo: true,
    binaryAfter: null,
    sudoPresent: true,
    uid: 1000,
  }, overrides);
  process.getuid = () => behavior.uid;
}

const sudoInstalls = () => calls.exec.filter(c => c.file === 'sudo' && c.args?.includes('install'));

describe('TD-116: a root-owned npm prefix must not end the install', () => {
  it('elevates after a permission failure, the same way the installer did', () => {
    reset();
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, true, 'a permission failure must not be the end of it');
    assert.equal(result.elevated, true);
    assert.equal(result.permissionDenied, true);
    assert.ok(sudoInstalls().length > 0, 'the retry has to actually go through sudo');
    assert.ok(sudoInstalls()[0].args.includes('-n'), 'sudo must never wait on a password prompt');
  });

  it('does NOT elevate when the failure was not about permissions', () => {
    reset({ plainPermissionDenied: false });
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, false);
    assert.equal(result.permissionDenied, false);
    assert.equal(sudoInstalls().length, 0, 'an unreachable registry is not fixed by root');
  });

  it('does NOT elevate when sudo would ask for a password', () => {
    reset({ passwordlessSudo: false });
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, false);
    assert.equal(sudoInstalls().length, 0, 'a prompt nobody can answer would hang the install');
    assert.equal(result.permissionDenied, true, 'the cause must still be reported');
  });

  it('does NOT elevate when already root', () => {
    reset({ uid: 0 });
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(sudoInstalls().length, 0, 'root has nothing to elevate to');
  });

  it('does NOT elevate when sudo is not installed', () => {
    reset({ sudoPresent: false });
    installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(sudoInstalls().length, 0);
  });
});

describe('TD-116: the advice must name the cause it actually had', () => {
  it('says permissions, not network, for a permission failure', () => {
    reset({ passwordlessSudo: false });
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    const lines = describeNpmInstallFailure('pm2', result).join('\n');
    assert.match(lines, /permissions problem, not a network one/);
    assert.doesNotMatch(
      lines,
      /point npm at a reachable mirror/,
      'sending someone at a mirror costs them the afternoon: every mirror works, none is the problem',
    );
    assert.match(lines, /npm config set prefix/, 'name the way out that needs no root');
  });

  it('still gives the mirror advice when the registry really was the problem', () => {
    reset({ plainPermissionDenied: false });
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    const lines = describeNpmInstallFailure('pm2', result).join('\n');
    assert.match(lines, /point npm at a reachable mirror/);
    assert.doesNotMatch(lines, /permissions problem/);
  });
});
