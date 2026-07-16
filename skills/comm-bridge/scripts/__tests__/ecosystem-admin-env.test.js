import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ecosystemPath = fileURLToPath(new URL('../../../../templates/pm2/ecosystem.config.cjs', import.meta.url));

it('loads the configured administrator target into the c4-dispatcher process', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-ecosystem-env-'));
  try {
    const yosDir = path.join(home, 'yos');
    fs.mkdirSync(yosDir, { recursive: true });
    fs.writeFileSync(path.join(yosDir, '.env'), [
      'YOS_ADMIN_CHANNEL=lark',
      'YOS_ADMIN_ENDPOINT="owner-chat"',
      ''
    ].join('\n'));

    const script = `
      const config = require(${JSON.stringify(ecosystemPath)});
      const app = config.apps.find((candidate) => candidate.name === 'c4-dispatcher');
      process.stdout.write(JSON.stringify(app.env));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr);
    const env = JSON.parse(result.stdout);
    assert.equal(env.YOS_ADMIN_CHANNEL, 'lark');
    assert.equal(env.YOS_ADMIN_ENDPOINT, 'owner-chat');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
