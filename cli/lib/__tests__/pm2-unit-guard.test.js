/**
 * `yos init` used to write /etc/systemd/system/pm2-<user>.service with no
 * questions asked. On a shared host, an init-flavoured test running under an
 * isolated HOME repointed the machine's boot hook at a sandbox: a reboot would
 * have started none of the real services, and the unit's original content was
 * gone for good. (TD-10 — it happened on our own build host, whose production
 * PM2 ran the dashboard and its tunnel.)
 *
 * These tests pin both halves of the guard: a sandbox never touches the
 * machine's unit, and a real run never destroys an existing one silently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  looksIsolated,
  describeUnitDiff,
  classifyUnitWrite,
  backupUnitPath,
} from '../pm2-unit-guard.js';

const HOME = '/home/cust';
const unit = ({ home = HOME, pm2Home = `${home}/.pm2`, exec = '/usr/bin/pm2', pathEnv = '/usr/bin' } = {}) => `[Unit]
Description=PM2 process manager for cust

[Service]
Type=simple
User=cust
Environment=PATH=${pathEnv}
Environment=PM2_HOME=${pm2Home}
Environment=HOME=${home}
ExecStart=${exec} resurrect --no-daemon

[Install]
WantedBy=multi-user.target
`;

describe('looksIsolated', () => {
  it('a real account with nothing overridden is not isolated', () => {
    const r = looksIsolated({ home: HOME, env: {}, pm2Path: '/usr/bin/pm2', tmpDir: '/tmp' });
    assert.equal(r.isolated, false);
    assert.equal(r.reason, null);
  });

  it('HOME inside the temp dir is isolated — this is the TD-10 run', () => {
    const r = looksIsolated({ home: '/tmp/yos-rehearsal-a1/home', env: {}, pm2Path: '/usr/bin/pm2', tmpDir: '/tmp' });
    assert.equal(r.isolated, true);
    assert.match(r.reason, /HOME is inside/);
  });

  it('an overridden PM2_HOME is isolated — that is the hijack itself', () => {
    const r = looksIsolated({
      home: HOME, env: { PM2_HOME: '/tmp/sandbox/.pm2' }, pm2Path: '/usr/bin/pm2', tmpDir: '/tmp',
    });
    assert.equal(r.isolated, true);
    assert.match(r.reason, /PM2_HOME is overridden/);
  });

  it('PM2_HOME set to exactly the real one is not an override', () => {
    const r = looksIsolated({ home: HOME, env: { PM2_HOME: `${HOME}/.pm2` }, pm2Path: '/usr/bin/pm2', tmpDir: '/tmp' });
    assert.equal(r.isolated, false);
  });

  it('a pm2 binary in the temp dir is isolated — it is gone after a reboot', () => {
    const r = looksIsolated({ home: HOME, env: {}, pm2Path: '/tmp/npm-x/node_modules/.bin/pm2', tmpDir: '/tmp' });
    assert.equal(r.isolated, true);
    assert.match(r.reason, /pm2 binary is inside/);
  });

  it('a path that merely starts with the same letters is not inside the temp dir', () => {
    // /tmpfoo is not under /tmp — a prefix test without the separator would
    // call a real account isolated and quietly stop configuring boot start.
    const r = looksIsolated({ home: '/tmpfoo/cust', env: {}, pm2Path: '/usr/bin/pm2', tmpDir: '/tmp' });
    assert.equal(r.isolated, false);
  });
});

describe('classifyUnitWrite', () => {
  it('writes when no unit is installed', () => {
    const r = classifyUnitWrite({ existing: null, next: unit() });
    assert.equal(r.action, 'write');
  });

  it('does nothing when the installed unit is byte-identical', () => {
    const same = unit();
    const r = classifyUnitWrite({ existing: same, next: same });
    assert.equal(r.action, 'skip-identical');
    assert.deepEqual(r.changes, []);
  });

  it('backs up first when a different unit is installed, and says what changes', () => {
    const r = classifyUnitWrite({
      existing: unit({ home: '/home/cust', pm2Home: '/home/cust/.pm2' }),
      next: unit({ home: '/tmp/sandbox', pm2Home: '/tmp/sandbox/.pm2' }),
    });
    assert.equal(r.action, 'backup-then-write');
    const keys = r.changes.map((c) => c.key);
    assert.ok(keys.includes('Environment=PM2_HOME'), 'the PM2_HOME change is the one that hijacks a reboot');
    assert.ok(keys.includes('Environment=HOME'));
    const pm2HomeChange = r.changes.find((c) => c.key === 'Environment=PM2_HOME');
    assert.equal(pm2HomeChange.from, '/home/cust/.pm2');
    assert.equal(pm2HomeChange.to, '/tmp/sandbox/.pm2');
  });

  it('⭐ an isolated run never touches the machine unit, even when one exists', () => {
    const r = classifyUnitWrite({
      existing: unit(),
      next: unit({ home: '/tmp/sandbox' }),
      isolation: { isolated: true, reason: 'HOME is inside /tmp' },
    });
    assert.equal(r.action, 'skip-isolated');
    assert.match(r.reason, /HOME is inside/);
  });

  it('⭐ isolation wins over "there is no unit yet" — a sandbox may not create one either', () => {
    const r = classifyUnitWrite({
      existing: null,
      next: unit(),
      isolation: { isolated: true, reason: 'PM2_HOME is overridden' },
    });
    assert.equal(r.action, 'skip-isolated');
  });

  it('an explicit YOS_SKIP_SYSTEMD opt out is honoured and named', () => {
    const r = classifyUnitWrite({ existing: null, next: unit(), skipRequested: true });
    assert.equal(r.action, 'skip-requested');
    assert.match(r.reason, /YOS_SKIP_SYSTEMD/);
  });
});

describe('describeUnitDiff', () => {
  it('reports nothing for identical content', () => {
    assert.deepEqual(describeUnitDiff(unit(), unit()), []);
  });

  it('reports an ExecStart change with both sides', () => {
    const changes = describeUnitDiff(unit({ exec: '/usr/bin/pm2' }), unit({ exec: '/tmp/x/pm2' }));
    const exec = changes.find((c) => c.key === 'ExecStart');
    assert.equal(exec.from, '/usr/bin/pm2 resurrect --no-daemon');
    assert.equal(exec.to, '/tmp/x/pm2 resurrect --no-daemon');
  });

  it('treats an absent line as null rather than skipping it', () => {
    const changes = describeUnitDiff('[Service]\nUser=cust\n', unit());
    const exec = changes.find((c) => c.key === 'ExecStart');
    assert.equal(exec.from, null);
    assert.ok(exec.to);
  });
});

// A green pure module proves nothing about whether init actually consults it.
// The wiring is the part that got reverted-by-omission for three weeks, so it
// gets its own assertion against the source.
describe('init actually uses the guard', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'commands', 'init.js'), 'utf8',
  );

  it('imports the guard', () => {
    assert.match(source, /from '\.\.\/lib\/pm2-unit-guard\.js'/);
  });

  it('reads the installed unit before deciding', () => {
    assert.match(source, /readFileSync\(unitPath, 'utf8'\)/);
  });

  it('routes the write through classifyUnitWrite, not straight to sudo install', () => {
    assert.match(source, /classifyUnitWrite\(\{/);
    const installIdx = source.indexOf("['install', '-m', '0644', tempUnitPath, unitPath]");
    const decideIdx = source.indexOf('classifyUnitWrite({');
    assert.ok(decideIdx !== -1 && installIdx !== -1, 'both the decision and the write must exist');
    assert.ok(decideIdx < installIdx, 'the decision has to come before the write');
  });

  it('honours every skip the guard can return', () => {
    for (const action of ['skip-isolated', 'skip-requested', 'skip-identical']) {
      assert.match(source, new RegExp(`'${action}'`), `init must handle ${action}`);
    }
  });

  it('an isolated run does not fall through to the crontab fallback either', () => {
    // A user crontab belongs to the real account no matter which HOME this
    // process was handed, so the sandbox hijack would just take that road.
    const skipBlock = source.slice(
      source.indexOf("decision.action === 'skip-isolated'"),
      source.indexOf("if (decision.action === 'skip-identical')"),
    );
    assert.ok(skipBlock.length > 0, 'the isolated branch must exist');
    assert.doesNotMatch(skipBlock, /setupBootAutostartWithoutRoot/);
  });
});

describe('backupUnitPath', () => {
  it('is timestamped so a second run cannot overwrite the backup that mattered', () => {
    const a = backupUnitPath('/etc/systemd/system/pm2-cust.service', '2026-08-06T12:00:00.000Z');
    const b = backupUnitPath('/etc/systemd/system/pm2-cust.service', '2026-08-06T12:00:01.000Z');
    assert.notEqual(a, b);
    assert.match(a, /^\/etc\/systemd\/system\/pm2-cust\.service\.yos-bak-/);
    assert.doesNotMatch(a, /:/, 'colons in a filename are a nuisance to type back');
  });
});
