/**
 * On a machine where the customer is not an administrator, no boot hook could be
 * installed and the install said the missing hook was optional and cost nothing.
 * It cost everything a reboot touches: the machine came back with all services
 * down and nobody was told to expect it.
 *
 * These tests pin the no-root fallback (`@reboot` in the user's own crontab),
 * its idempotency, and the honesty of the message when even that is impossible.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  buildRebootCrontabLine,
  mergeCrontab,
  CRONTAB_MARKER,
} = await import('../boot-autostart.js');

const OPTS = { pm2Path: '/home/cust/.local/bin/pm2', home: '/home/cust' };

describe('buildRebootCrontabLine', () => {
  it('runs pm2 resurrect at boot', () => {
    const line = buildRebootCrontabLine(OPTS);
    assert.match(line, /^@reboot /);
    assert.match(line, /\/home\/cust\/\.local\/bin\/pm2 resurrect/);
  });

  it('spells out the environment, because cron gives a job almost none', () => {
    const line = buildRebootCrontabLine(OPTS);
    assert.match(line, /HOME=\/home\/cust/);
    assert.match(line, /PM2_HOME=\/home\/cust\/\.pm2/);
    assert.match(line, /PATH=\S+/);
  });

  it('uses an absolute pm2 path — cron cannot be trusted to find it', () => {
    const line = buildRebootCrontabLine(OPTS);
    const command = line.split(/PATH=\S+\s+/)[1] || '';
    assert.ok(command.startsWith('/'), `pm2 must be absolute, got: ${command}`);
  });

  it('sends its output to a log instead of mailing the customer', () => {
    const line = buildRebootCrontabLine(OPTS);
    assert.match(line, />> \S+ 2>&1/);
  });

  it('honours an explicit log path', () => {
    const line = buildRebootCrontabLine({ ...OPTS, logPath: '/home/cust/yos/pm2/reboot.log' });
    assert.match(line, /\/home\/cust\/yos\/pm2\/reboot\.log/);
  });

  it('refuses to build a half-specified line', () => {
    assert.throws(() => buildRebootCrontabLine({ home: '/home/cust' }));
    assert.throws(() => buildRebootCrontabLine({ pm2Path: '/bin/pm2' }));
  });
});

describe('mergeCrontab', () => {
  it('adds the entry to an empty crontab', () => {
    const line = buildRebootCrontabLine(OPTS);
    const out = mergeCrontab('', line);
    assert.ok(out.includes(CRONTAB_MARKER));
    assert.ok(out.includes(line));
    assert.ok(out.endsWith('\n'));
  });

  it('does not stack copies when init runs again', () => {
    const line = buildRebootCrontabLine(OPTS);
    const once = mergeCrontab('', line);
    const twice = mergeCrontab(once, line);
    assert.equal(twice, once);
    assert.equal(twice.split('@reboot').length - 1, 1);
  });

  it('replaces an older entry rather than leaving both', () => {
    const oldLine = buildRebootCrontabLine({ ...OPTS, pm2Path: '/old/path/pm2' });
    const newLine = buildRebootCrontabLine(OPTS);
    const out = mergeCrontab(mergeCrontab('', oldLine), newLine);
    assert.ok(out.includes('/home/cust/.local/bin/pm2'));
    assert.ok(!out.includes('/old/path/pm2'));
    assert.equal(out.split('@reboot').length - 1, 1);
  });

  it('keeps entries that belong to someone else, exactly', () => {
    const theirs = [
      '# nightly backup',
      '0 3 * * * /usr/local/bin/backup.sh',
      '*/5 * * * * /usr/bin/check-disk',
    ].join('\n');
    const out = mergeCrontab(theirs, buildRebootCrontabLine(OPTS));
    for (const kept of theirs.split('\n')) assert.ok(out.includes(kept), `lost: ${kept}`);
  });

  it('cleans up a previous entry whose marker was deleted by hand', () => {
    const orphan = '@reboot HOME=/home/cust /old/pm2 resurrect >> /tmp/x.log 2>&1';
    const out = mergeCrontab(orphan, buildRebootCrontabLine(OPTS));
    assert.equal(out.split('@reboot').length - 1, 1);
    assert.ok(!out.includes('/old/pm2'));
  });

  it('does not touch an unrelated @reboot entry', () => {
    const theirs = '@reboot /usr/local/bin/start-my-thing';
    const out = mergeCrontab(theirs, buildRebootCrontabLine(OPTS));
    assert.ok(out.includes('/usr/local/bin/start-my-thing'));
    assert.equal(out.split('@reboot').length - 1, 2);
  });
});

describe('what the customer is told', () => {
  const initSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'commands', 'init.js'), 'utf8'
  );

  it('never calls a missing boot hook harmless', () => {
    // The old text: "This is optional — YOS works fine without it."
    assert.ok(!initSource.includes('works fine without it'),
      'a machine that comes back from a reboot with every service down is not fine');
  });

  it('says outright that the services will not come back', () => {
    assert.match(initSource, /will NOT come back/);
  });

  it('gives the one command that brings them back now', () => {
    assert.match(initSource, /pm2 resurrect/);
  });

  it('reaches for the no-root fallback instead of giving up', () => {
    assert.match(initSource, /installRebootCrontab\(/);
    // Every privileged path must hand off to it, not print and return. Counted
    // as call sites, excluding the definition — otherwise deleting one call site
    // still satisfies a loose total.
    const calls = (initSource.match(/setupBootAutostartWithoutRoot\(/g) || []).length
      - (initSource.match(/function setupBootAutostartWithoutRoot\(/g) || []).length;
    assert.ok(calls >= 4, `every failing route must fall back; found ${calls} call sites`);
  });
});
