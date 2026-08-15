/**
 * Shared tmux helper functions for runtime adapters.
 *
 * All child-process calls use execFileSync (no shell) with finite timeouts
 * to prevent event-loop hangs when the tmux server is unresponsive.
 */

import { execFileSync } from 'node:child_process';

const CMD_TIMEOUT = 3000;
const LAUNCH_TIMEOUT = 10_000;
const TERM_GRACE_MS = 1000;
const KILL_GRACE_MS = 500;

/**
 * Check whether a tmux session exists.
 * @param {string} session
 * @returns {boolean}
 */
export function tmuxHasSession(session) {
  try {
    execFileSync('tmux', ['has-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux has-session', err);
    return false;
  }
}

/**
 * Get the pane PID for a tmux session.
 * @param {string} session
 * @returns {number} PID or 0
 */
export function tmuxGetPanePid(session) {
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const lines = out.split('\n');
    const pid = parseInt(lines[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux list-panes', err);
    return 0;
  }
}

/**
 * Kill a tmux session.
 * @param {string} session
 */
export function tmuxKillSession(session) {
  try {
    execFileSync('tmux', ['kill-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* session may not exist */ }
}

function readProcessTable(execFileSyncImpl) {
  try {
    const output = execFileSyncImpl('ps', ['-eo', 'pid=,ppid=,stat=,comm='], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(output).split('\n').flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]) }];
    });
  } catch {
    return [];
  }
}

function collectProcessTree(rootPid, processTable) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const childrenByParent = new Map();
  for (const entry of processTable) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return result;
}

function isProcessAlive(pid, signalProcess) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultWaitForExit(pids, timeoutMs, { signalProcess, sleep = sleepSync }) {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(pid => isProcessAlive(pid, signalProcess));
  while (remaining.length > 0 && Date.now() < deadline) {
    sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    remaining = remaining.filter(pid => isProcessAlive(pid, signalProcess));
  }
  return remaining;
}

function bestEffortSignal(pids, signal, signalProcess) {
  for (const pid of pids) {
    try {
      signalProcess(pid, signal);
    } catch { /* process already exited */ }
  }
}

/**
 * Stop a runtime session and reap the exact process tree that belonged to its
 * tmux pane. Capture PIDs before killing tmux because stopped children may be
 * reparented and become undiscoverable after the session disappears.
 */
export function stopTmuxSessionProcessTree(session, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const signalProcess = options.signalProcess ?? process.kill.bind(process);
  const waitForExit = options.waitForExit ?? ((pids, timeoutMs) => (
    defaultWaitForExit(pids, timeoutMs, { signalProcess })
  ));

  let panePid = 0;
  try {
    const output = execFileSyncImpl('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    panePid = Number.parseInt(String(output).trim().split('\n')[0], 10) || 0;
  } catch { /* session may already be gone */ }

  const targets = collectProcessTree(panePid, readProcessTable(execFileSyncImpl));
  try {
    execFileSyncImpl('tmux', ['kill-session', '-t', session], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* session may already be gone */ }

  const afterTmux = targets.filter(pid => isProcessAlive(pid, signalProcess));
  bestEffortSignal(afterTmux, 'SIGCONT', signalProcess);
  bestEffortSignal(afterTmux, 'SIGTERM', signalProcess);
  const afterTerm = waitForExit(afterTmux, TERM_GRACE_MS);
  bestEffortSignal(afterTerm, 'SIGKILL', signalProcess);
  const remaining = waitForExit(afterTerm, KILL_GRACE_MS);

  return {
    observed: targets.length,
    graceful: Math.max(0, targets.length - afterTerm.length),
    forced: afterTerm.length,
    remaining: remaining.length,
  };
}

/**
 * Send text to a tmux session via the buffer-paste technique.
 * Handles special characters safely.
 *
 * @param {string} session
 * @param {string} tmpFile - Path to a temp file containing the text
 * @param {string} bufferName - Unique tmux buffer name
 */
export function tmuxPasteBuffer(session, tmpFile, bufferName) {
  execFileSync('tmux', ['load-buffer', '-b', bufferName, tmpFile], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
  execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', session], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
  execFileSync('tmux', ['send-keys', '-t', session, 'Enter'], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
}

/**
 * Delete a tmux buffer (best-effort).
 * @param {string} bufferName
 */
export function tmuxDeleteBuffer(bufferName) {
  try {
    execFileSync('tmux', ['delete-buffer', '-b', bufferName], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
  } catch { /* best-effort */ }
}

/**
 * Capture tmux pane content.
 * @param {string} session
 * @returns {string|null}
 */
export function tmuxCapturePaneText(session) {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-t', session], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (isTimeoutError(err)) _debugTimeout('tmux capture-pane', err);
    return null;
  }
}

/**
 * Send keys to a tmux session.
 * @param {string} session
 * @param {...string} keys
 */
export function tmuxSendKeys(session, ...keys) {
  execFileSync('tmux', ['send-keys', '-t', session, ...keys], {
    timeout: CMD_TIMEOUT,
    stdio: 'ignore',
  });
}

/**
 * Create a new tmux session.
 * @param {string[]} args - Full argument list for `tmux new-session`
 */
export function tmuxNewSession(args) {
  execFileSync('tmux', args, { timeout: LAUNCH_TIMEOUT });
}

/**
 * Get the process name for a PID.
 * @param {number} pid
 * @returns {string|null}
 */
export function getProcessName(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: CMD_TIMEOUT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if a PID has a child matching a pattern.
 * @param {number} parentPid
 * @param {string} pattern
 * @returns {boolean}
 */
export function hasChildProcess(parentPid, pattern) {
  try {
    execFileSync('pgrep', ['-P', String(parentPid), '-f', pattern], {
      timeout: CMD_TIMEOUT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function isTimeoutError(err) {
  return err?.code === 'ETIMEDOUT';
}

function _debugTimeout(label, err) {
  const signal = err.signal || 'unknown';
  process.stderr.write(`[tmux-helpers] ${label} timed out (code=${err?.code}, signal=${signal})\n`);
}
