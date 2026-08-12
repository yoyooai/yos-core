import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from '@jest/globals';

import {
  buildSystemdUnits,
  installSystemdUnits,
} from '../scripts/install-shelf-auto-backup.mjs';

function config(root) {
  const file = path.join(root, 'backup.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    localRepo: process.cwd(),
    stateDir: path.join(root, 'state'),
    restoreRoot: path.join(root, 'restore'),
    shelf: { sshTarget: 'host', nodePath: '/usr/local/bin/node', repoDir: '/srv/repo', root: '/srv/shelf' },
    cos: { bucket: 'bucket-1234567890', region: 'ap-test', basePrefix: 'scheduled/' },
    credentialCommand: ['/secure/mint-token'],
    alertCommand: ['/secure/send-alert'],
    keepSuccessful: 30,
    restoreEvery: 7,
    lockStaleSeconds: 14400,
    commandTimeoutSeconds: 7200,
  }));
  return file;
}

describe('shelf automatic backup systemd installer', () => {
  test('builds a persistent oneshot timer without embedding credential values', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-units-'));
    const configPath = config(root);
    const units = await buildSystemdUnits({
      configPath,
      repoDir: process.cwd(),
      nodePath: process.execPath,
      onCalendar: '*-*-* 03:17:00',
      randomizedDelaySeconds: 1800,
    });

    expect(units.service).toContain('Type=oneshot');
    expect(units.service).toContain(`--config "${configPath}"`);
    expect(units.service).toContain('UMask=0077');
    expect(units.service).toContain('ProtectSystem=strict');
    expect(units.service).toContain(`ReadWritePaths="${path.join(root, 'state')}" "${path.join(root, 'restore')}"`);
    expect(units.timer).toContain('Persistent=true');
    expect(units.timer).toContain('RandomizedDelaySec=1800');
    expect(units.service).toContain('TimeoutStartSec=65100');
    expect(units.service).not.toMatch(/SECRET|TOKEN|AKID/);
  });

  test('writes units atomically but does not invoke systemctl', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-install-'));
    const outputDir = path.join(root, 'units');
    const result = await installSystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      onCalendar: 'daily',
      randomizedDelaySeconds: 900,
    });

    expect(fs.existsSync(result.servicePath)).toBe(true);
    expect(fs.existsSync(result.timerPath)).toBe(true);
    expect(fs.readdirSync(outputDir).sort()).toEqual([
      'yos-shelf-backup.service',
      'yos-shelf-backup.timer',
    ]);
    expect(fs.statSync(path.join(root, 'state')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'restore')).mode & 0o777).toBe(0o700);
  });

  test('writes units accepted by systemd-analyze', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-systemd-'));
    const outputDir = path.join(root, 'units');
    const repoDir = path.join(root, 'repo with spaces');
    fs.mkdirSync(repoDir);
    const result = await installSystemdUnits({
      configPath: config(root),
      repoDir,
      nodePath: process.execPath,
      outputDir,
      onCalendar: 'daily',
      randomizedDelaySeconds: 900,
    });
    const service = fs.readFileSync(result.servicePath, 'utf8');

    // WorkingDirectory= does not unquote a whole value like ExecStart= does.
    expect(service).toContain(`WorkingDirectory=${repoDir.replaceAll(' ', '\\x20')}\n`);
    expect(service).not.toContain(`WorkingDirectory="${repoDir}"`);

    const version = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (process.platform === 'linux') {
      expect(version.status).toBe(0, version.error?.message || version.stderr);
      const verified = spawnSync(
        'systemd-analyze',
        ['verify', result.servicePath, result.timerPath],
        { encoding: 'utf8' },
      );
      expect(verified.status).toBe(0, verified.stderr || verified.stdout);
    }
  });

  async function expectUnitRejected(override) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-unit-bad-'));
    await expect(buildSystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      onCalendar: 'daily',
      randomizedDelaySeconds: 900,
      ...override,
    })).rejects.toThrow();
  }

  test('rejects a calendar expression containing a newline', async () => {
    await expectUnitRejected({ onCalendar: 'daily\nExecStart=/bin/false' });
  });

  test('rejects a negative randomized delay', async () => {
    await expectUnitRejected({ randomizedDelaySeconds: -1 });
  });

  test('rejects a relative config path', async () => {
    await expectUnitRejected({ configPath: 'backup.json' });
  });
});
