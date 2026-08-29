import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const ecosystemPath = fileURLToPath(
  new URL('../../../templates/pm2/ecosystem.config.cjs', import.meta.url)
);

// `yos init --timezone` records TZ in ~/yos/.env and sets it on the host, but
// PM2 services were started without it. Node then formats every timestamp in
// UTC while the machine reads local, so `yos status` and activity.log ran 8h
// behind on an Asia/Shanghai box — unlabelled, so nobody could see it was
// wrong. Whoever reads those logs concludes the agent has been dead for hours.
//
// Real-machine evidence (WorkTest, 2026-08-27): agent-status.json said
// last_check_human 03:41:37 while `date` on the same box said 11:41:37.

function readEnvsWith(envLines, appNames, extraSetup) {
  const home = makeTempDir('yos-ecosystem-tz-');
  try {
    const yosDir = path.join(home, 'yos');
    fs.mkdirSync(yosDir, { recursive: true });
    fs.writeFileSync(path.join(yosDir, '.env'), envLines.join('\n'));
    if (extraSetup) extraSetup({ home, yosDir });

    const script = `
      const config = require(${JSON.stringify(ecosystemPath)});
      const names = ${JSON.stringify(appNames)};
      const out = {};
      for (const name of names) {
        const app = config.apps.find((candidate) => candidate.name === name);
        out[name] = app ? app.env : null;
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const CORE_SERVICES = ['scheduler', 'web-console', 'c4-dispatcher', 'activity-monitor'];

describe('ecosystem template — timezone', () => {
  it('passes the recorded timezone to every core service', () => {
    const envs = readEnvsWith(['TZ=Asia/Shanghai', ''], CORE_SERVICES);
    for (const name of CORE_SERVICES) {
      assert.ok(envs[name], `${name} should be defined`);
      assert.equal(
        envs[name].TZ, 'Asia/Shanghai',
        `${name} must inherit TZ, or its timestamps silently fall back to UTC`
      );
    }
  });

  it('quotes and comments in .env do not defeat it', () => {
    const envs = readEnvsWith(
      ['# timezone', 'TZ="America/New_York"', 'SOMETHING=else', ''],
      CORE_SERVICES
    );
    for (const name of CORE_SERVICES) {
      assert.equal(envs[name].TZ, 'America/New_York');
    }
  });

  // The dangerous half of this fix. Node treats TZ='' as UTC, so injecting an
  // empty value is worse than injecting nothing: a machine that never set a
  // timezone would be *moved* to UTC by the very change meant to fix drift.
  // Absent TZ must stay absent so the process inherits the host zone.
  it('never injects an empty TZ when .env does not record one', () => {
    const envs = readEnvsWith(['SOMETHING=else', ''], CORE_SERVICES);
    for (const name of CORE_SERVICES) {
      assert.ok(
        !('TZ' in envs[name]) || envs[name].TZ === undefined,
        `${name} must omit TZ entirely when unset, got ${JSON.stringify(envs[name].TZ)}`
      );
    }
  });

  it('an explicitly empty TZ= line is treated as unset, not as UTC', () => {
    const envs = readEnvsWith(['TZ=', ''], CORE_SERVICES);
    for (const name of CORE_SERVICES) {
      assert.ok(
        !('TZ' in envs[name]) || envs[name].TZ === undefined,
        `${name} must omit TZ for an empty TZ= line, got ${JSON.stringify(envs[name].TZ)}`
      );
    }
  });

  it('reaches component services declared through SKILL.md too', () => {
    const envs = readEnvsWith(['TZ=Asia/Shanghai', ''], ['weixin'], ({ home }) => {
      const skillDir = path.join(home, 'yos', '.claude', 'skills', 'weixin');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: weixin',
        'service:',
        '  name: weixin',
        '  entry: scripts/server.js',
        '---',
        '',
      ].join('\n'));
      const metaDir = path.join(home, 'yos', '.yos');
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(
        path.join(metaDir, 'components.json'),
        JSON.stringify({ weixin: { skillDir } })
      );
    });
    assert.ok(envs.weixin, 'component service should be loaded');
    assert.equal(
      envs.weixin.TZ, 'Asia/Shanghai',
      'component services log timestamps too — they need TZ as much as core ones'
    );
  });

  it('reaches component services that ship their own ecosystem file', () => {
    const envs = readEnvsWith(['TZ=Asia/Shanghai', ''], ['feishu'], ({ home }) => {
      const skillDir = path.join(home, 'yos', '.claude', 'skills', 'feishu');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'ecosystem.config.cjs'), [
        'module.exports = { apps: [{',
        "  name: 'feishu',",
        "  script: 'server.js',",
        "  env: { NODE_ENV: 'production' },",
        '}] };',
        '',
      ].join('\n'));
      const metaDir = path.join(home, 'yos', '.yos');
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(
        path.join(metaDir, 'components.json'),
        JSON.stringify({ feishu: { skillDir } })
      );
    });
    assert.ok(envs.feishu, 'component service should be loaded');
    assert.equal(envs.feishu.TZ, 'Asia/Shanghai');
  });
});
