import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { writeEnvEntries } from '../env.js';
import {
  parseInitFlags,
  recordAdministratorAlertTarget,
  resolveFromEnv,
  validateInitOptions
} from '../../commands/init.js';

describe('administrator alert configuration', () => {
  test('init accepts an explicit administrator target', () => {
    const opts = parseInitFlags([
      '--admin-channel', 'feishu',
      '--admin-endpoint', 'oc_admin'
    ]);
    assert.equal(opts.adminChannel, 'feishu');
    assert.equal(opts.adminEndpoint, 'oc_admin');
    assert.equal(validateInitOptions(opts), null);
  });

  test('environment values fill only missing administrator options', () => {
    const previousChannel = process.env.YOS_ADMIN_CHANNEL;
    const previousEndpoint = process.env.YOS_ADMIN_ENDPOINT;
    process.env.YOS_ADMIN_CHANNEL = 'weixin';
    process.env.YOS_ADMIN_ENDPOINT = 'wx_admin';
    try {
      const opts = parseInitFlags([]);
      resolveFromEnv(opts);
      assert.equal(opts.adminChannel, 'weixin');
      assert.equal(opts.adminEndpoint, 'wx_admin');
    } finally {
      if (previousChannel === undefined) delete process.env.YOS_ADMIN_CHANNEL;
      else process.env.YOS_ADMIN_CHANNEL = previousChannel;
      if (previousEndpoint === undefined) delete process.env.YOS_ADMIN_ENDPOINT;
      else process.env.YOS_ADMIN_ENDPOINT = previousEndpoint;
    }
  });

  test('rejects a half-configured administrator target', () => {
    const opts = parseInitFlags(['--admin-channel', 'feishu']);
    assert.match(validateInitOptions(opts), /admin-channel.*admin-endpoint/i);
  });

  test('installation can replace only blank administrator placeholders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-admin-env-'));
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, [
      'EXISTING=value',
      'YOS_ADMIN_CHANNEL=',
      'YOS_ADMIN_ENDPOINT=',
      ''
    ].join('\n'));
    try {
      const result = writeEnvEntries({
        YOS_ADMIN_CHANNEL: 'feishu',
        YOS_ADMIN_ENDPOINT: 'oc_admin'
      }, 'YOS administrator alert target', { envFile, replaceEmpty: true });
      assert.deepEqual(result.written.sort(), ['YOS_ADMIN_CHANNEL', 'YOS_ADMIN_ENDPOINT']);
      const content = fs.readFileSync(envFile, 'utf8');
      assert.match(content, /^EXISTING=value$/m);
      assert.match(content, /^YOS_ADMIN_CHANNEL=feishu$/m);
      assert.match(content, /^YOS_ADMIN_ENDPOINT=oc_admin$/m);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('installation records an explicit target and warns when delivery has none', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-admin-record-'));
    const envFile = path.join(root, '.env');
    const warnings = [];
    fs.writeFileSync(envFile, 'YOS_ADMIN_CHANNEL=\nYOS_ADMIN_ENDPOINT=\n');
    try {
      assert.deepEqual(recordAdministratorAlertTarget({
        adminChannel: 'feishu',
        adminEndpoint: 'oc_admin'
      }, { envFile, warnUser: (message) => warnings.push(message) }), { configured: true });
      assert.equal(warnings.length, 0);

      fs.writeFileSync(envFile, 'YOS_ADMIN_CHANNEL=\nYOS_ADMIN_ENDPOINT=\n');
      assert.deepEqual(recordAdministratorAlertTarget({}, {
        envFile,
        warnUser: (message) => warnings.push(message)
      }), { configured: false });
      assert.match(warnings.at(-1), /administrator alerts are not configured/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('an explicit init target replaces the previous target without touching other settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-admin-replace-'));
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, [
      'EXISTING=keep-me',
      'YOS_ADMIN_CHANNEL=weixin',
      'YOS_ADMIN_ENDPOINT=old-owner',
      ''
    ].join('\n'));
    try {
      assert.deepEqual(recordAdministratorAlertTarget({
        adminChannel: 'feishu',
        adminEndpoint: 'new-owner'
      }, { envFile }), { configured: true });
      const env = fs.readFileSync(envFile, 'utf8');
      assert.match(env, /^EXISTING=keep-me$/m);
      assert.match(env, /^YOS_ADMIN_CHANNEL=feishu$/m);
      assert.match(env, /^YOS_ADMIN_ENDPOINT=new-owner$/m);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  test('template deployment persists the target into the generated installation env', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-admin-deploy-'));
    const yosDir = path.join(home, 'yos');
    const initUrl = new URL('../../commands/init.js', import.meta.url).href;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', [
        `import { deployTemplates } from ${JSON.stringify(initUrl)};`,
        `deployTemplates({ freshInstall: true, adminChannel: 'feishu', adminEndpoint: 'oc_admin' });`
      ].join('\n')], {
        env: { ...process.env, HOME: home, YOS_DIR: yosDir },
        encoding: 'utf8'
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const env = fs.readFileSync(path.join(yosDir, '.env'), 'utf8');
      assert.match(env, /^YOS_ADMIN_CHANNEL=feishu$/m);
      assert.match(env, /^YOS_ADMIN_ENDPOINT=oc_admin$/m);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
