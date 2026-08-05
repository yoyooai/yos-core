import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(ROOT, 'scripts', 'install.sh');

const script = fs.readFileSync(INSTALL_SH, 'utf8');

/**
 * Pull the terminal probe out of the shipped installer so the behavioural test
 * below runs the real definition rather than a copy of it. Restating the
 * condition inside the test would let the two drift apart, which is the exact
 * failure this file exists to prevent.
 */
function extractTtyProbe() {
  const match = script.match(/^_tty_readable\(\)\s*\{(.*)\}\s*$/m);
  return match ? match[1].trim() : null;
}

function hasSetsid() {
  try {
    execFileSync('sh', ['-c', 'command -v setsid'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Every place that reads from the terminal, and what breaks when it guesses wrong. */
const TERMINAL_READERS = [
  { name: 'security consent prompt', pattern: /read -r answer < \/dev\/tty/ },
  { name: 'yos init hand-off', pattern: /yos init .*< \/dev\/tty/ },
];

describe('installer detects a reachable terminal instead of a present device node', () => {
  test('nothing tests /dev/tty for mere existence', () => {
    // An existence test passes with no controlling terminal, so the redirect
    // that follows it fails: the consent prompt aborts the install outright and
    // the init hand-off is skipped while the installer still claims success.
    expect(script).not.toMatch(/\[[^\]]*-[ef]\s+\/dev\/tty[^\]]*\]/);
  });

  test('one shared probe decides it, so the three call sites cannot disagree', () => {
    expect(extractTtyProbe()).toBeTruthy();
    for (const { name, pattern } of TERMINAL_READERS) {
      expect({ name, matched: pattern.test(script) }).toEqual({ name, matched: true });
    }
    // Guarding each reader with the shared probe is what keeps them consistent.
    const guardCount = script.match(/_tty_readable/g)?.length ?? 0;
    expect(guardCount).toBeGreaterThanOrEqual(TERMINAL_READERS.length + 1);
  });

  test('a failing yos init propagates out of the installer', () => {
    // Without this the caller sees exit code 0 and hands over a machine that is
    // installed but unconfigured, which then breaks on the first `yos add`.
    expect(script).toMatch(/return\s+"\$init_exit"/);
  });

  test('the shipped probe reports no terminal when there is none', () => {
    const probe = extractTtyProbe();
    expect(probe).toBeTruthy();

    if (!hasSetsid()) {
      // Detaching from the controlling terminal is what makes this assertion
      // mean anything; without setsid the run would silently prove nothing.
      console.warn('setsid unavailable — skipping the detached-process check');
      return;
    }

    const program = `_tty_readable() { ${probe} }; if _tty_readable; then echo HAS_TTY; else echo NO_TTY; fi`;
    // setsid puts the probe in a fresh session with no controlling terminal —
    // the situation an unattended install runs in.
    const detached = execFileSync('setsid', ['bash', '-c', program], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    expect(detached).toBe('NO_TTY');
  });
});
