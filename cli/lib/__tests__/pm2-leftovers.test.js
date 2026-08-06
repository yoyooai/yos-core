/**
 * A machine was reinstalled by wiping the home directory. PM2 is a daemon, so
 * wiping a home does not stop it: three God Daemons stayed up, still holding the
 * Web Console port, and the new install could not bind it. `yos init` had no
 * idea — nothing in it looked for a PM2 process it had not started. (TD-21)
 *
 * These tests pin the sorting, and pin that we never claim "no leftovers" when
 * what actually happened is "could not tell".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { parseJlist, classifyLeftovers, describeLeftovers } from '../pm2-leftovers.js';

const YOS = '/home/cust/yos';
const proc = (name, script, status = 'online', pid = 1) => ({
  name, pid, pm2_env: { pm_exec_path: script, status },
});

describe('parseJlist', () => {
  it('reads a normal jlist', () => {
    const r = parseJlist(JSON.stringify([proc('web-console', `${YOS}/x.js`)]));
    assert.equal(r.ok, true);
    assert.equal(r.processes.length, 1);
  });

  it('tolerates a warning printed before the JSON', () => {
    const r = parseJlist(`[PM2][WARN] something\n${JSON.stringify([proc('a', `${YOS}/a.js`)])}`);
    assert.equal(r.ok, true);
    assert.equal(r.processes[0].name, 'a');
  });

  it('⭐ reports "could not tell" rather than "nothing there" for empty or broken output', () => {
    // The distinction matters: absent PM2 and unreadable output must not be
    // presented to a customer as proof that the machine is clean.
    for (const bad of ['', '   ', 'not json', '{"not":"an array"}', '[oops']) {
      const r = parseJlist(bad);
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must not be reported as a successful read`);
      assert.deepEqual(r.processes, []);
    }
  });
});

describe('classifyLeftovers', () => {
  const exists = (p) => p.includes('present');

  it('a script that is gone is stale — this is the wiped-home case', () => {
    const r = classifyLeftovers({
      processes: [proc('web-console', `${YOS}/gone/server.js`)],
      yosDir: YOS,
      exists,
    });
    assert.equal(r.stale.length, 1);
    assert.equal(r.live.length, 0);
    assert.equal(r.stale[0].name, 'web-console');
    assert.match(r.stale[0].script, /gone/);
  });

  it('a script still on disk under our directory is a live previous install', () => {
    const r = classifyLeftovers({
      processes: [proc('dispatcher', `${YOS}/present/d.js`)],
      yosDir: YOS,
      exists,
    });
    assert.equal(r.live.length, 1);
    assert.equal(r.stale.length, 0);
  });

  it('anything outside our directory is foreign and stays untouched', () => {
    const r = classifyLeftovers({
      processes: [proc('their-app', '/opt/theirs/app.js'), proc('other', '/home/cust/other/x.js')],
      yosDir: YOS,
      exists,
    });
    assert.equal(r.foreign.length, 2);
    assert.equal(r.stale.length + r.live.length, 0);
  });

  it('a path that merely shares a prefix with our directory is foreign', () => {
    // /home/cust/yos-old is not inside /home/cust/yos.
    const r = classifyLeftovers({
      processes: [proc('old', '/home/cust/yos-old/present.js')],
      yosDir: YOS,
      exists,
    });
    assert.equal(r.foreign.length, 1);
    assert.equal(r.live.length, 0);
  });

  it('the three piles always account for every process', () => {
    const processes = [
      proc('a', `${YOS}/gone/a.js`),
      proc('b', `${YOS}/present/b.js`),
      proc('c', '/opt/x/c.js'),
      proc('d', ''),
    ];
    const r = classifyLeftovers({ processes, yosDir: YOS, exists });
    assert.equal(r.total, 4);
    assert.equal(r.stale.length + r.live.length + r.foreign.length, 4);
  });
});

describe('describeLeftovers', () => {
  it('says nothing when there is nothing of ours running', () => {
    assert.equal(describeLeftovers({ stale: [], live: [], foreign: [] }), null);
  });

  it('foreign processes alone are not worth interrupting anyone about', () => {
    assert.equal(describeLeftovers({ stale: [], live: [], foreign: [{ name: 'theirs' }] }), null);
  });

  it('names the count that can no longer start, and offers a command naming them', () => {
    const d = describeLeftovers({
      stale: [{ name: 'web-console', status: 'online', script: '/gone/a.js' }],
      live: [{ name: 'dispatcher', status: 'online', script: '/here/b.js' }],
      foreign: [{ name: 'theirs' }],
    });
    assert.match(d.headline, /can no longer start/);
    assert.match(d.command, /^pm2 delete /);
    assert.match(d.command, /web-console/);
    assert.match(d.command, /dispatcher/);
    assert.ok(d.details.some((l) => /script is gone/.test(l)));
    assert.ok(d.details.some((l) => /will not touch/.test(l)), 'foreign count is disclosed, not hidden');
  });

  it('falls back to pm2 kill when the leftovers have no usable names', () => {
    const d = describeLeftovers({ stale: [{ name: '(unnamed)', status: 'online', script: '/gone/a.js' }] });
    assert.equal(d.command, 'pm2 kill');
  });
});

// The pure module being green says nothing about whether init consults it.
describe('init actually looks for leftovers', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', '..', 'commands', 'init.js'), 'utf8',
  );

  it('imports the module', () => {
    assert.match(source, /from '\.\.\/lib\/pm2-leftovers\.js'/);
  });

  it('asks pm2 for its process list', () => {
    assert.match(source, /jlist/);
  });

  it('⭐ never kills anything on its own — a reinstall is the worst time to guess', () => {
    const idx = source.indexOf('reportPm2Leftovers');
    assert.ok(idx !== -1, 'the reporting function must exist');
    const block = source.slice(idx, idx + 2600);
    assert.doesNotMatch(block, /spawnSync\('pm2', \['kill'/);
    assert.doesNotMatch(block, /spawnSync\('pm2', \['delete'/);
  });
});
