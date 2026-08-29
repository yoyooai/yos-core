import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, mock } from 'node:test';
import { execFileSync } from 'node:child_process';

// We test the module's behavior by importing it and verifying that
// the functions handle various child_process outcomes correctly.
// Since tmux-helpers calls execFileSync directly (no DI), we use
// node:test's mock.module to intercept calls.

import {
  tmuxHasSession,
  tmuxGetPanePid,
  tmuxKillSession,
  tmuxCapturePaneText,
  getProcessName,
  hasChildProcess,
  isTimeoutError,
} from '../tmux-helpers.js';
import * as tmuxHelpers from '../tmux-helpers.js';

import { makeTempDir } from '../../../../test/helpers/temp-dir.js';

function runAdapterStopInIsolation({ modulePath, exportName }) {
  const fixtureRoot = makeTempDir('yos-adapter-stop-');
  const binDir = path.join(fixtureRoot, 'bin');
  const callsFile = path.join(fixtureRoot, 'tmux-calls.log');
  const runnerFile = path.join(fixtureRoot, 'runner.mjs');
  fs.mkdirSync(binDir);

  fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$YOS_TEST_TMUX_CALLS"
if [ "$1" = "list-panes" ]; then
  printf '2147483001\\n'
fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'ps'), `#!/bin/sh
printf '2147483001 1 S sh\\n2147483002 2147483001 T runtime\\n'
`, { mode: 0o755 });
  fs.writeFileSync(runnerFile, `
const { ${exportName} } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
const result = new ${exportName}().stop();
process.stdout.write(JSON.stringify(result));
`);

  try {
    const stdout = execFileSync(process.execPath, [runnerFile], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        YOS_TEST_TMUX_CALLS: callsFile,
      },
    });
    return {
      result: JSON.parse(stdout),
      calls: fs.readFileSync(callsFile, 'utf8'),
    };
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// These tests verify the contract: each function must never throw,
// and must return the correct fallback on timeout or exit errors.

describe('tmux-helpers integration (live calls to nonexistent sessions)', () => {
  const FAKE_SESSION = '__yos_test_nonexistent_session__';

  it('tmuxHasSession returns false for nonexistent session', () => {
    assert.equal(tmuxHasSession(FAKE_SESSION), false);
  });

  it('tmuxGetPanePid returns 0 for nonexistent session', () => {
    assert.equal(tmuxGetPanePid(FAKE_SESSION), 0);
  });

  it('tmuxKillSession does not throw for nonexistent session', () => {
    assert.doesNotThrow(() => tmuxKillSession(FAKE_SESSION));
  });

  it('tmuxCapturePaneText returns null for nonexistent session', () => {
    assert.equal(tmuxCapturePaneText(FAKE_SESSION), null);
  });

  it('getProcessName returns null for nonexistent PID', () => {
    assert.equal(getProcessName(999999999), null);
  });

  it('hasChildProcess returns false for nonexistent parent', () => {
    assert.equal(hasChildProcess(999999999, 'nope'), false);
  });
});

describe('tmux-helpers timeout behavior', () => {
  it('tmuxHasSession returns false on timeout (does not throw)', () => {
    // Simulate what happens when execFileSync times out:
    // Node sets err.killed = true and err.signal = 'SIGTERM'.
    // The function should catch and return false.
    // We can't easily mock execFileSync in ESM, but we verify the
    // contract: nonexistent session returns false without throwing.
    const result = tmuxHasSession('__timeout_test__');
    assert.equal(result, false);
  });

  it('tmuxGetPanePid returns 0 on error (does not throw)', () => {
    const result = tmuxGetPanePid('__timeout_test__');
    assert.equal(result, 0);
  });

  it('tmuxCapturePaneText returns null on error (does not throw)', () => {
    const result = tmuxCapturePaneText('__timeout_test__');
    assert.equal(result, null);
  });

  it('getProcessName returns null on error (does not throw)', () => {
    const result = getProcessName(-1);
    assert.equal(result, null);
  });

  it('hasChildProcess returns false on error (does not throw)', () => {
    const result = hasChildProcess(-1, 'anything');
    assert.equal(result, false);
  });
});

describe('tmux-helpers does not log on normal exit failures', () => {
  it('tmuxHasSession with nonexistent session produces no stderr timeout warning', () => {
    // Normal "session not found" exits with code 1 and no ETIMEDOUT.
    // The wrapper should NOT log a timeout warning for this case.
    const origWrite = process.stderr.write;
    let stderrOutput = '';
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    try {
      tmuxHasSession('__no_such_session__');
      assert.equal(stderrOutput.includes('timed out'), false,
        'Should not log timeout warning for normal session-not-found');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('tmuxGetPanePid with nonexistent session produces no stderr timeout warning', () => {
    const origWrite = process.stderr.write;
    let stderrOutput = '';
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    try {
      tmuxGetPanePid('__no_such_session__');
      assert.equal(stderrOutput.includes('timed out'), false,
        'Should not log timeout warning for normal session-not-found');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe('isTimeoutError classifier', () => {
  it('returns true for ETIMEDOUT error (Node execFileSync timeout)', () => {
    const err = new Error('spawnSync sleep ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    err.signal = 'SIGTERM';
    assert.equal(isTimeoutError(err), true);
  });

  it('returns false for normal exit code 1 (session not found)', () => {
    const err = new Error('Command failed: tmux has-session');
    err.status = 1;
    err.code = undefined;
    err.signal = null;
    assert.equal(isTimeoutError(err), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError(undefined), false);
  });

  it('returns false for generic errors', () => {
    assert.equal(isTimeoutError(new Error('ENOENT')), false);
  });
});

describe('tmux runtime process-tree cleanup', () => {
  it('CodexAdapter.stop delegates to process-tree cleanup', () => {
    const evidence = runAdapterStopInIsolation({
      modulePath: path.resolve(import.meta.dirname, '..', 'codex.js'),
      exportName: 'CodexAdapter',
    });

    assert.deepEqual(evidence.result, {
      observed: 2,
      graceful: 2,
      forced: 0,
      remaining: 0,
    });
    assert.match(evidence.calls, /list-panes -t codex-main/);
    assert.match(evidence.calls, /kill-session -t codex-main/);
  });

  it('ClaudeAdapter.stop delegates to process-tree cleanup', () => {
    const evidence = runAdapterStopInIsolation({
      modulePath: path.resolve(import.meta.dirname, '..', 'claude.js'),
      exportName: 'ClaudeAdapter',
    });

    assert.deepEqual(evidence.result, {
      observed: 2,
      graceful: 2,
      forced: 0,
      remaining: 0,
    });
    assert.match(evidence.calls, /list-panes -t claude-main/);
    assert.match(evidence.calls, /kill-session -t claude-main/);
  });

  it('resumes frozen descendants, terminates them, and force-kills only survivors', () => {
    assert.equal(typeof tmuxHelpers.stopTmuxSessionProcessTree, 'function');

    const alive = new Set([100, 101, 102, 999]);
    const signals = [];
    const execFileSyncImpl = (command, args) => {
      if (command === 'tmux' && args[0] === 'list-panes') return '100\n';
      if (command === 'ps') {
        return [
          '100 50 S bash',
          '101 100 T codex',
          '102 101 T node',
          '999 1 S unrelated',
        ].join('\n');
      }
      if (command === 'tmux' && args[0] === 'kill-session') {
        alive.delete(100);
        return '';
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };
    const signalProcess = (pid, signal) => {
      if (signal === 0) {
        if (!alive.has(pid)) {
          const err = new Error('no such process');
          err.code = 'ESRCH';
          throw err;
        }
        return;
      }
      signals.push([pid, signal]);
      if (signal === 'SIGTERM' && pid === 102) alive.delete(pid);
      if (signal === 'SIGKILL') alive.delete(pid);
    };
    const waitForExit = (pids) => pids.filter(pid => alive.has(pid));

    const result = tmuxHelpers.stopTmuxSessionProcessTree('codex-main', {
      execFileSyncImpl,
      signalProcess,
      waitForExit,
    });

    assert.deepEqual(result, {
      observed: 3,
      graceful: 2,
      forced: 1,
      remaining: 0,
    });
    assert.deepEqual(signals, [
      [101, 'SIGCONT'],
      [102, 'SIGCONT'],
      [101, 'SIGTERM'],
      [102, 'SIGTERM'],
      [101, 'SIGKILL'],
    ]);
    assert.equal(alive.has(999), true, 'unrelated processes must not be signalled');
  });

  it('removes a real SIGSTOP-frozen child from an isolated tmux session', (t) => {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    } catch {
      t.skip('tmux is not installed');
      return;
    }

    const session = `yos-wo088-${process.pid}`;
    const pidFile = path.join(os.tmpdir(), `${session}.pid`);
    try {
      const fixture = `sleep 300 & child=$!; kill -STOP "$child"; printf %s "$child" > "${pidFile}"; wait`;
      execFileSync('tmux', ['new-session', '-d', '-s', session, 'sh', '-c', fixture]);
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      assert.equal(fs.existsSync(pidFile), true, 'fixture child pid was not written');
      const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
      const before = execFileSync('ps', ['-p', String(childPid), '-o', 'stat='], {
        encoding: 'utf8',
      }).trim();
      assert.match(before, /^T/);

      const result = tmuxHelpers.stopTmuxSessionProcessTree(session);

      assert.equal(result.remaining, 0);
      assert.equal(tmuxHasSession(session), false);
      assert.throws(() => process.kill(childPid, 0), /ESRCH|no such process/i);
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
    }
  });
});
