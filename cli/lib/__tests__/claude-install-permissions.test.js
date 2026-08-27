/**
 * TD-118. TD-116 taught the PM2 install to elevate past a root-owned npm
 * prefix, and installCodex already went through the same helper. The runtime
 * install did not: `installClaude()` called a bare single-registry helper, so
 * on a machine with a system-installed Node the default command
 *
 *     curl -fsSL https://dist.yoyooai.com/install.sh | bash
 *
 * died at exit 1 — one step after `install.sh` had elevated past that very
 * directory to put `yos` there. Measured in a clean container: the identical
 * npm command succeeded in 8 seconds under sudo, while claude.ai answered 302
 * and the mirror answered 200. Nothing was wrong with the network, and the
 * advice on the way out sent the customer to change mirrors.
 *
 * These tests pin all three halves: elevate when (and only when) the failure is
 * a permission failure and sudo needs no password; never hand a downloaded
 * script to root; and describe the cause we actually had.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const calls = { exec: [] };
const behavior = {
  nativeWorks: false,        // the native installer script succeeds
  plainFails: true,
  plainPermissionDenied: true,
  sudoWorks: true,
  passwordlessSudo: true,
  binaryAfter: null,         // which runner makes `claude` appear
  sudoPresent: true,
  uid: 1000,
};

mock.module('node:child_process', {
  namedExports: {
    execSync() { return Buffer.from(''); },
    execFileSync(file, args) {
      calls.exec.push({ file, args });
      if (file === 'npm' && args[0] === 'config') return '/usr/local';
      // The native installer is fetched with curl, then run with bash.
      if (file === 'curl') {
        if (!behavior.nativeWorks) throw new Error('curl: (22) The requested URL returned error: 404');
        return Buffer.from('');
      }
      if (file === 'bash') {
        if (!behavior.nativeWorks) throw new Error('installer failed');
        behavior.binaryAfter = 'native';
        return Buffer.from('');
      }
      if (file === 'sudo') {
        if (!behavior.sudoWorks) throw new Error('npm ERR! code E404');
        behavior.binaryAfter = 'sudo';
        return Buffer.from('');
      }
      if (behavior.plainFails) {
        const err = new Error('npm install failed');
        err.stderr = behavior.plainPermissionDenied
          ? 'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@anthropic-ai'
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

const { installClaude, describeClaudeInstallFailure } = await import('../runtime-setup.js');

function reset(overrides = {}) {
  calls.exec.length = 0;
  Object.assign(behavior, {
    nativeWorks: false,
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
const sudoAnything = () => calls.exec.filter(c => c.file === 'sudo' && c.args?.[0] !== '-n' ? true : false);

describe('TD-118: a root-owned npm prefix must not end the runtime install', () => {
  it('elevates after a permission failure, the same way PM2 and Codex already do', () => {
    reset();
    const result = installClaude();
    assert.equal(result.ok, true, 'the install must not stop where install.sh succeeded');
    assert.equal(result.elevated, true);
    assert.equal(result.permissionDenied, true);
    assert.ok(sudoInstalls().length > 0, 'the retry has to actually go through sudo');
    assert.ok(sudoInstalls()[0].args.includes('-n'), 'sudo must never wait on a password prompt');
  });

  it('does NOT elevate when the failure was not about permissions', () => {
    reset({ plainPermissionDenied: false });
    const result = installClaude();
    assert.equal(result.ok, false);
    assert.equal(result.permissionDenied, false);
    assert.equal(sudoInstalls().length, 0, 'an unreachable registry is not fixed by root');
  });

  it('does NOT elevate when sudo would ask for a password', () => {
    reset({ passwordlessSudo: false });
    const result = installClaude();
    assert.equal(result.ok, false);
    assert.equal(sudoInstalls().length, 0, 'a prompt nobody can answer would hang the install');
    assert.equal(result.permissionDenied, true, 'the cause must still be reported');
  });

  it('does NOT elevate when already root', () => {
    reset({ uid: 0 });
    installClaude();
    assert.equal(sudoInstalls().length, 0, 'root has nothing to elevate to');
  });

  it('does NOT elevate when sudo is not installed', () => {
    reset({ sudoPresent: false });
    installClaude();
    assert.equal(sudoInstalls().length, 0);
  });

  it('the elevated retry covers the npm step only — the installer script is not run again', () => {
    reset();
    const result = installClaude();

    // Handing a just-downloaded script to root is a far bigger thing than the
    // failure being repaired, and re-running an installer that already failed
    // buys nothing but another timeout. The elevated pass must skip it.
    const nativeAttempts = result.attempts.filter(a => a.id === 'native');
    assert.equal(
      nativeAttempts.length, 1,
      'the native installer belongs to the plain pass only; a second attempt means the elevated pass swept it up too',
    );
    assert.equal(nativeAttempts[0].elevated, false);
    assert.ok(
      result.attempts.some(a => a.elevated === true && a.id !== 'native'),
      'the elevated pass must still have happened — otherwise this proves nothing',
    );
    assert.deepEqual(
      calls.exec.filter(c => c.file === 'sudo' && c.args?.includes('bash')), [],
      'nothing downloaded may be executed as root',
    );
  });

  it('does not reach for sudo at all when the native installer already worked', () => {
    reset({ nativeWorks: true });
    const result = installClaude();
    assert.equal(result.ok, true);
    assert.equal(result.via, 'native');
    assert.equal(sudoInstalls().length, 0, 'nothing failed, so there is nothing to elevate past');
  });
});

describe('TD-118: the advice must name the cause it actually had', () => {
  it('says permissions, not network, for a permission failure', () => {
    reset({ passwordlessSudo: false });
    const result = installClaude();
    const lines = describeClaudeInstallFailure(result).join('\n');
    assert.match(lines, /permissions problem, not a network one/);
    assert.doesNotMatch(
      lines,
      /point npm at a reachable mirror/,
      'every mirror answers fine when the prefix is unwritable — that advice costs the customer the afternoon',
    );
    assert.match(lines, /npm config set prefix/, 'name the way out that needs no root');
    assert.match(lines, /\/usr\/local/, 'name the directory the failure is actually about');
  });

  it('still gives the mirror advice when the registry really was the problem', () => {
    reset({ plainPermissionDenied: false });
    const result = installClaude();
    const lines = describeClaudeInstallFailure(result).join('\n');
    assert.match(lines, /point npm at a reachable mirror/);
    assert.doesNotMatch(lines, /permissions problem/);
  });

  it('marks which attempts were elevated, so the log is readable afterwards', () => {
    reset({ sudoWorks: false });
    const result = installClaude();
    const lines = describeClaudeInstallFailure(result).join('\n');
    assert.match(lines, /with sudo/, 'a retry that also failed must say it was the elevated one');
  });
});
