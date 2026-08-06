/**
 * The runtime is the one download a fresh machine cannot skip. Before this,
 * `yos init` had exactly one source for it (claude.ai) and no route out when
 * that host was unreachable — a customer on a poor link got stuck with no
 * second option. These tests pin the fallback chain, its ordering, and the
 * honesty of what gets reported.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

// ── Module mocks ───────────────────────────────────────────────────────────
// Recorded per import; the harness below resets them for every case.
const calls = { curl: [], bash: [], npm: [] };
const behavior = {
  downloadOk: false,  // the installer script could be fetched
  scriptRunOk: true,  // the fetched installer script ran without error
  npmOk: new Map(),   // registry key ('default' | url) → boolean
  claudeOnPath: false,
};

mock.module('node:child_process', {
  namedExports: {
    execSync() {
      return Buffer.from('');
    },
    execFileSync(file, args, opts) {
      if (file === 'curl') {
        calls.curl.push({ file, args, opts });
        if (!behavior.downloadOk) throw new Error('curl failed');
        return Buffer.from('');
      }
      if (file === 'bash') {
        calls.bash.push({ file, args, opts });
        if (!behavior.scriptRunOk) throw new Error('installer script failed');
        return Buffer.from('');
      }
      calls.npm.push({ file, args, opts });
      const registryArg = (args || []).find(a => String(a).startsWith('--registry='));
      const key = registryArg ? registryArg.slice('--registry='.length) : 'default';
      if (!behavior.npmOk.get(key)) throw new Error('npm failed');
      return Buffer.from('');
    },
    spawnSync() {
      return { stdout: '', stderr: '', status: 0 };
    },
  },
});

mock.module('../shell-utils.js', {
  namedExports: {
    commandExists() {
      return behavior.claudeOnPath;
    },
  },
});

const {
  planClaudeInstall,
  installClaude,
  describeClaudeInstallFailure,
  CLAUDE_NATIVE_INSTALL_URL,
  CLAUDE_NPM_PACKAGE,
  DEFAULT_NPM_MIRROR,
} = await import('../runtime-setup.js');

function reset() {
  calls.curl.length = 0;
  calls.bash.length = 0;
  calls.npm.length = 0;
  behavior.downloadOk = false;
  behavior.scriptRunOk = true;
  behavior.npmOk = new Map();
  behavior.claudeOnPath = false;
}

// ── Ordering / overrides (pure) ────────────────────────────────────────────

describe('planClaudeInstall', () => {
  it('tries the native installer first, then npm, then the mirror registry', () => {
    const steps = planClaudeInstall({});
    assert.deepEqual(steps.map(s => s.id), ['native', 'npm', 'npm-mirror']);
    assert.equal(steps[0].url, CLAUDE_NATIVE_INSTALL_URL);
    assert.equal(steps[1].registry, null);
    assert.equal(steps[2].registry, DEFAULT_NPM_MIRROR);
    assert.ok(steps.every(s => s.label && s.label.length > 0));
  });

  it('always leaves a source that does not depend on claude.ai', () => {
    // The whole point of the change: claude.ai unreachable must not be fatal.
    const steps = planClaudeInstall({});
    const independent = steps.filter(s => s.kind === 'npm');
    assert.ok(independent.length >= 1);
    assert.ok(independent.every(s => s.pkg === CLAUDE_NPM_PACKAGE));
  });

  it('drops the native step when YOS_CLAUDE_INSTALL_URL is explicitly empty', () => {
    const steps = planClaudeInstall({ YOS_CLAUDE_INSTALL_URL: '' });
    assert.deepEqual(steps.map(s => s.id), ['npm', 'npm-mirror']);
  });

  it('uses a custom native installer URL when one is configured', () => {
    const steps = planClaudeInstall({ YOS_CLAUDE_INSTALL_URL: 'https://mirror.example.com/install.sh' });
    assert.equal(steps[0].url, 'https://mirror.example.com/install.sh');
    assert.match(steps[0].label, /mirror\.example\.com/);
  });

  it('drops the mirror step when YOS_NPM_REGISTRY is explicitly empty', () => {
    const steps = planClaudeInstall({ YOS_NPM_REGISTRY: '' });
    assert.deepEqual(steps.map(s => s.id), ['native', 'npm']);
  });

  it('uses a custom mirror registry when one is configured', () => {
    const steps = planClaudeInstall({ YOS_NPM_REGISTRY: 'https://npm.internal.example.com' });
    assert.equal(steps[2].registry, 'https://npm.internal.example.com');
    assert.match(steps[2].label, /npm\.internal\.example\.com/);
  });
});

// ── Execution ──────────────────────────────────────────────────────────────

describe('installClaude', () => {
  it('stops at the first source that works and does not touch the others', () => {
    reset();
    behavior.downloadOk = true;
    behavior.claudeOnPath = true;

    const result = installClaude({ env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'native');
    assert.equal(result.fellBack, false);
    assert.equal(calls.npm.length, 0, 'npm must not run once the native installer worked');
  });

  it('falls back to npm when claude.ai cannot be reached', () => {
    reset();
    behavior.downloadOk = false;          // claude.ai unreachable
    behavior.npmOk.set('default', true);
    behavior.claudeOnPath = true;

    const result = installClaude({ env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'npm');
    assert.equal(result.fellBack, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].installed, false);
    assert.equal(calls.npm[0].args.includes(CLAUDE_NPM_PACKAGE), true);
  });

  it('falls back again to the mirror registry when the default registry fails', () => {
    reset();
    behavior.downloadOk = false;
    behavior.npmOk.set(DEFAULT_NPM_MIRROR, true);   // only the mirror answers
    behavior.claudeOnPath = true;

    const result = installClaude({ env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'npm-mirror');
    assert.equal(result.attempts.length, 3);
    const last = calls.npm.at(-1);
    assert.ok(last.args.includes(`--registry=${DEFAULT_NPM_MIRROR}`));
  });

  it('passes no --registry on the default npm step', () => {
    reset();
    behavior.downloadOk = false;
    behavior.npmOk.set('default', true);
    behavior.claudeOnPath = true;

    installClaude({ env: {} });
    assert.equal(calls.npm[0].args.some(a => String(a).startsWith('--registry=')), false);
  });

  it('does not run the installer it failed to download', () => {
    // `curl … | bash` returns bash's status, so a download that never happened
    // still exits 0 and looks installed. Fetch and run are separate for exactly
    // this reason — a blocked host must not be reported as a PATH problem.
    reset();
    behavior.downloadOk = false;
    const result = installClaude({ env: {} });
    assert.equal(calls.bash.length, 0, 'nothing was downloaded, so nothing may be executed');
    assert.equal(result.attempts[0].installed, false, 'a failed download is a failed install');
  });

  it('downloads the installer to a file rather than piping it into a shell', () => {
    reset();
    installClaude({ env: {} });
    assert.ok(calls.curl[0].args.includes('-o'), 'the installer is written to a file first');
  });

  it('keeps trying when a source reports success but leaves no runnable claude', () => {
    reset();
    behavior.downloadOk = true;           // installer downloads and exits 0 …
    behavior.npmOk.set('default', true);
    behavior.claudeOnPath = false;      // … but nothing usable landed on PATH

    const result = installClaude({ env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].installed, true);
    assert.equal(result.attempts[0].found, false, 'an unusable install must not count as success');
    assert.equal(result.attempts.length, 3, 'every remaining source still gets a turn');
  });

  it('reports failure with every source it tried when nothing works', () => {
    reset();
    const result = installClaude({ env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.via, null);
    assert.deepEqual(result.attempts.map(a => a.id), ['native', 'npm', 'npm-mirror']);
  });

  it('announces each source before trying it', () => {
    reset();
    behavior.downloadOk = false;
    behavior.npmOk.set('default', true);
    behavior.claudeOnPath = true;

    const announced = [];
    installClaude({ env: {}, onAttempt: step => announced.push(step.id) });
    assert.deepEqual(announced, ['native', 'npm']);
  });

  it('gives the native installer a connect timeout so an unreachable host cannot eat the whole budget', () => {
    reset();
    installClaude({ env: {} });
    assert.ok(calls.curl[0].args.includes('--connect-timeout'));
  });

  it('honours env overrides end to end, not just in the plan', () => {
    reset();
    behavior.npmOk.set('default', true);
    behavior.claudeOnPath = true;

    const result = installClaude({ env: { YOS_CLAUDE_INSTALL_URL: '' } });
    assert.equal(result.ok, true);
    assert.equal(result.via, 'npm');
    assert.equal(calls.curl.length, 0, 'the native installer must not run when it is disabled');
  });
});

// ── Structural guards ──────────────────────────────────────────────────────
// The original single point of failure was an inline `curl … claude.ai … | bash`
// copied into a command file. Unit tests above cannot see that copy, so these
// guards fail if anyone re-introduces one instead of going through the chain.

describe('install sources stay in one place', () => {
  const cliRoot = path.join(import.meta.dirname, '..', '..');

  function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('no command file executes the installer URL directly', () => {
    // Quote characters are written as escapes: the repo's test counter strips
    // strings with a simple state machine and a literal quote inside a regex
    // would make it lose count of the cases below.
    const inlineExec = /exec(?:Sync|FileSync)\s*\(\s*[\x60\x27\x22][^\x60\x27\x22]*claude\.ai\/install\.sh/;
    const offenders = sourceFiles(cliRoot)
      .filter(file => inlineExec.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(cliRoot, file));
    assert.deepEqual(offenders, [], 'install the runtime through installClaude() so the fallback chain applies');
  });

  it('yos init installs the runtime through the shared chain', () => {
    const init = fs.readFileSync(path.join(cliRoot, 'commands', 'init.js'), 'utf8');
    assert.match(init, /installClaude\(/);
  });

  it('yos runtime installs the runtime through the shared chain', () => {
    const runtime = fs.readFileSync(path.join(cliRoot, 'commands', 'runtime.js'), 'utf8');
    assert.match(runtime, /installClaude\(/);
  });
});

describe('describeClaudeInstallFailure', () => {
  it('names each failed source and offers a route that avoids the failing host', () => {
    reset();
    const result = installClaude({ env: {} });
    const lines = describeClaudeInstallFailure(result).join('\n');
    assert.match(lines, /native installer/);
    assert.ok(lines.includes(`npm install -g ${CLAUDE_NPM_PACKAGE}`));
    assert.ok(lines.includes(DEFAULT_NPM_MIRROR));
  });

  it('calls out a PATH problem instead of blaming the download', () => {
    reset();
    behavior.downloadOk = true;
    behavior.claudeOnPath = false;
    const result = installClaude({ env: {} });
    const lines = describeClaudeInstallFailure(result).join('\n');
    assert.match(lines, /no \x22claude\x22 on PATH/);
  });

  it('does not send someone to fix PATH when the download is what failed', () => {
    reset();
    behavior.downloadOk = false;
    const result = installClaude({ env: {} });
    const lines = describeClaudeInstallFailure(result).join('\n');
    assert.doesNotMatch(lines, /no \x22claude\x22 on PATH/);
    assert.match(lines, /Tried native installer[^\n]*failed/);
  });
});
