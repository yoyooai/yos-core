import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, test } from '@jest/globals';

import {
  buildSystemdUnits,
  installAndVerifySystemdUnits,
  installSystemdUnits,
  runCli,
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
  async function expectBusyServiceRejected(activeState, status) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-running-service-'));
    const outputDir = path.join(root, 'units');
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'systemctl' && args[0] === 'show' && args[2] === '-p') {
        return { status, stdout: `${activeState}\n`, stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'is-enabled') {
        return { status: 0, stdout: 'enabled\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'is-active' && args[1] === 'yos-shelf-backup.timer') {
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      if (command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: `${process.getuid()}\n`, stderr: '' };
    };

    await expect(installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/usr/bin:/bin',
    }, { runCommand, systemUnitDir: outputDir })).rejects.toThrow(/backup service is already running/);

    expect(fs.existsSync(outputDir)).toBe(false);
    expect(calls).toContainEqual([
      'systemctl', 'show', 'yos-shelf-backup.service', '-p', 'ActiveState', '--value',
    ]);
    expect(calls).not.toContainEqual(['systemctl', 'stop', 'yos-shelf-backup.timer']);
  }

  async function expectSignalRestoresInstallation(signal) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-system-signal-'));
    const outputDir = path.join(root, 'units');
    const stateDir = path.join(root, 'state');
    const restoreDir = path.join(root, 'restore');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(stateDir, { mode: 0o750 });
    fs.mkdirSync(restoreDir, { mode: 0o750 });
    const servicePath = path.join(outputDir, 'yos-shelf-backup.service');
    const timerPath = path.join(outputDir, 'yos-shelf-backup.timer');
    fs.writeFileSync(servicePath, 'old service\n', { mode: 0o640 });
    fs.writeFileSync(timerPath, 'old timer\n', { mode: 0o640 });
    const calls = [];
    const signalSource = new EventEmitter();
    let daemonReloads = 0;
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'id' && args[0] === '-u') return { status: 0, stdout: `${process.getuid()}\n`, stderr: '' };
      if (command === 'id' && args[0] === '-g') return { status: 0, stdout: `${process.getgid()}\n`, stderr: '' };
      if (command === 'systemctl' && args[0] === 'is-enabled') return { status: 0, stdout: 'enabled\n', stderr: '' };
      if (command === 'systemctl' && args[0] === 'is-active' && args[1] === 'yos-shelf-backup.timer') {
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'show' && args[2] === '-p') {
        return { status: 3, stdout: 'inactive\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'daemon-reload') {
        daemonReloads += 1;
        if (daemonReloads === 1) setImmediate(() => signalSource.emit(signal));
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/usr/bin:/bin',
    }, { runCommand, systemUnitDir: outputDir, signalSource })).rejects.toThrow(new RegExp(`interrupted by ${signal}`));

    expect(fs.readFileSync(servicePath, 'utf8')).toBe('old service\n');
    expect(fs.readFileSync(timerPath, 'utf8')).toBe('old timer\n');
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o750);
    expect(fs.statSync(restoreDir).mode & 0o777).toBe(0o750);
    expect(calls).toContainEqual(['systemctl', 'disable', '--now', 'yos-shelf-backup.timer']);
    expect(calls).toContainEqual(['systemctl', 'enable', '--now', 'yos-shelf-backup.timer']);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  }

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

  test('builds a system unit for the selected unprivileged operator without weakening the sandbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-system-unit-'));
    const messageDir = path.join(root, 'comm-bridge');
    const units = await buildSystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/home/backup-operator/.nvm/bin:/usr/bin:/bin',
      additionalReadWritePaths: [messageDir],
    });

    expect(units.service).toContain('User=backup-operator');
    expect(units.service).toContain('Environment="HOME=/home/backup-operator"');
    expect(units.service).toContain('Environment="PATH=/home/backup-operator/.nvm/bin:/usr/bin:/bin"');
    expect(units.service).toContain(`"${messageDir}"`);
    expect(units.service).toContain('NoNewPrivileges=true');
    expect(units.service).toContain('PrivateTmp=true');
    expect(units.service).toContain('ProtectSystem=strict');
    expect(units.service).toContain('ProtectHome=read-only');
  });

  test('system installation enables the timer and proves the real backup service can run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-system-install-'));
    const outputDir = path.join(root, 'units');
    const messageDir = path.join(root, 'comm-bridge');
    fs.mkdirSync(messageDir);
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'id' && args[0] === '-u') return { status: 0, stdout: `${process.getuid()}\n`, stderr: '' };
      if (command === 'id' && args[0] === '-g') return { status: 0, stdout: `${process.getgid()}\n`, stderr: '' };
      if (command === 'systemctl' && args[0] === 'is-enabled') return { status: 1, stdout: 'disabled\n', stderr: '' };
      if (command === 'systemctl' && args[0] === 'show') return { status: 0, stdout: 'success\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = await installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/usr/local/bin:/usr/bin:/bin',
      additionalReadWritePaths: [messageDir],
    }, { runCommand, systemUnitDir: outputDir });

    expect(result.selfTested).toBe(true);
    expect(calls).toContainEqual(['systemctl', 'daemon-reload']);
    expect(calls).toContainEqual(['systemctl', 'enable', '--now', 'yos-shelf-backup.timer']);
    expect(calls).toContainEqual(['systemctl', 'start', 'yos-shelf-backup.service']);
    expect(calls).toContainEqual([
      'systemctl', 'show', 'yos-shelf-backup.service', '--property=Result', '--value',
    ]);
    expect(calls).toContainEqual([
      'runuser', '-u', 'backup-operator', '--', 'test', '-w', messageDir,
    ]);
    expect(calls).toContainEqual([
      'runuser', '-u', 'backup-operator', '--', 'env',
      'HOME=/home/backup-operator',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'node', '--version',
    ]);
    expect(fs.statSync(path.join(root, 'state')).uid).toBe(process.getuid());
    expect(fs.statSync(path.join(root, 'state')).gid).toBe(process.getgid());
  });

  test('refuses an alert write path the selected operator cannot write before installing units', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-alert-path-'));
    const outputDir = path.join(root, 'units');
    const messageDir = path.join(root, 'comm-bridge');
    fs.mkdirSync(messageDir);
    const runCommand = (command, args) => {
      if (command === 'id' && args[0] === '-u') return { status: 0, stdout: `${process.getuid()}\n`, stderr: '' };
      if (command === 'id' && args[0] === '-g') return { status: 0, stdout: `${process.getgid()}\n`, stderr: '' };
      if (command === 'runuser' && args.includes('-w')) {
        return { status: 1, stdout: '', stderr: 'permission denied' };
      }
      if (command === 'systemctl') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/usr/bin:/bin',
      additionalReadWritePaths: [messageDir],
    }, { runCommand, systemUnitDir: outputDir })).rejects.toThrow(/cannot write required path/);

    expect(fs.existsSync(outputDir)).toBe(false);
  });

  test('refuses installation while a backup service is active', async () => {
    await expectBusyServiceRejected('active', 0);
  });

  test('refuses installation while a backup service is activating with exit 3', async () => {
    await expectBusyServiceRejected('activating', 3);
  });

  test('refuses installation while a backup service is reloading with exit 3', async () => {
    await expectBusyServiceRejected('reloading', 3);
  });

  test('refuses installation while a backup service is deactivating with exit 3', async () => {
    await expectBusyServiceRejected('deactivating', 3);
  });

  test('SIGINT restores the previous installation and timer state', async () => {
    await expectSignalRestoresInstallation('SIGINT');
  });

  test('SIGTERM restores the previous installation and timer state', async () => {
    await expectSignalRestoresInstallation('SIGTERM');
  });

  test('a failed real trigger removes a fresh system installation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-system-fail-'));
    const outputDir = path.join(root, 'units');
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'id' && args[0] === '-u') return { status: 0, stdout: `${process.getuid()}\n`, stderr: '' };
      if (command === 'id' && args[0] === '-g') return { status: 0, stdout: `${process.getgid()}\n`, stderr: '' };
      if (command === 'systemctl' && args[0] === 'is-enabled') return { status: 1, stdout: '', stderr: '' };
      if (command === 'systemctl' && args[0] === 'start') return { status: 1, stdout: '', stderr: 'failed' };
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/usr/bin:/bin',
    }, { runCommand, systemUnitDir: outputDir })).rejects.toThrow(/real backup self-test failed/);

    expect(fs.existsSync(path.join(outputDir, 'yos-shelf-backup.service'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'yos-shelf-backup.timer'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'restore'))).toBe(false);
    expect(calls).toContainEqual(['systemctl', 'disable', '--now', 'yos-shelf-backup.timer']);
    expect(calls.filter((call) => call.join(' ') === 'systemctl daemon-reload')).toHaveLength(2);
  });

  test('a failed replacement restores the previous units and their enabled state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-system-restore-'));
    const outputDir = path.join(root, 'units');
    const stateDir = path.join(root, 'state');
    const restoreDir = path.join(root, 'restore');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(stateDir, { mode: 0o750 });
    fs.mkdirSync(restoreDir, { mode: 0o750 });
    const servicePath = path.join(outputDir, 'yos-shelf-backup.service');
    const timerPath = path.join(outputDir, 'yos-shelf-backup.timer');
    fs.writeFileSync(servicePath, 'old service\n', { mode: 0o640 });
    fs.writeFileSync(timerPath, 'old timer\n', { mode: 0o640 });
    const calls = [];
    const runCommand = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'id' && args[0] === '-u') return { status: 0, stdout: `${process.getuid()}\n`, stderr: '' };
      if (command === 'id' && args[0] === '-g') return { status: 0, stdout: `${process.getgid()}\n`, stderr: '' };
      if (command === 'systemctl' && args[0] === 'is-enabled') return { status: 0, stdout: 'enabled\n', stderr: '' };
      if (command === 'systemctl' && args[0] === 'is-active' && args[1] === 'yos-shelf-backup.timer') {
        return { status: 0, stdout: 'active\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'is-active') {
        return { status: 1, stdout: 'inactive\n', stderr: '' };
      }
      if (command === 'systemctl' && args[0] === 'show') return { status: 0, stdout: 'failed\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir,
      systemMode: true,
      systemUser: 'backup-operator',
      homeDir: '/home/backup-operator',
      pathEnv: '/usr/bin:/bin',
    }, { runCommand, systemUnitDir: outputDir })).rejects.toThrow(/reported Result=failed/);

    expect(fs.readFileSync(servicePath, 'utf8')).toBe('old service\n');
    expect(fs.readFileSync(timerPath, 'utf8')).toBe('old timer\n');
    expect(fs.statSync(servicePath).mode & 0o777).toBe(0o640);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o750);
    expect(fs.statSync(restoreDir).mode & 0o777).toBe(0o750);
    expect(calls.filter((call) => call.join(' ') === 'systemctl enable --now yos-shelf-backup.timer')).toHaveLength(1);
    const stopIndex = calls.findIndex((call) => call.join(' ') === 'systemctl stop yos-shelf-backup.timer');
    const serviceProbeIndex = calls.findIndex((call) =>
      call.join(' ') === 'systemctl show yos-shelf-backup.service -p ActiveState --value');
    const reloadIndex = calls.findIndex((call) => call.join(' ') === 'systemctl daemon-reload');
    const testIndex = calls.findIndex((call) => call.join(' ') === 'systemctl start yos-shelf-backup.service');
    const enableIndex = calls.findIndex((call) => call.join(' ') === 'systemctl enable --now yos-shelf-backup.timer');
    expect(stopIndex).toBeGreaterThan(-1);
    expect(serviceProbeIndex).toBeGreaterThan(-1);
    expect(serviceProbeIndex).toBeLessThan(stopIndex);
    expect(stopIndex).toBeLessThan(reloadIndex);
    expect(testIndex).toBeLessThan(enableIndex);
  });

  test('the CLI refuses legacy user-mode generation instead of installing an unproven timer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-user-cli-'));
    await expect(runCli([
      '--config', config(root),
      '--repo', process.cwd(),
      '--node', process.execPath,
      '--output-dir', path.join(root, 'units'),
    ])).rejects.toThrow(/--system.*required/s);
    expect(fs.existsSync(path.join(root, 'units'))).toBe(false);
  });

  test('the system installer API also refuses user mode when called without the CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-user-api-'));
    await expect(installAndVerifySystemdUnits({
      configPath: config(root),
      repoDir: process.cwd(),
      nodePath: process.execPath,
      outputDir: path.join(root, 'units'),
    })).rejects.toThrow(/--system.*required/s);
    expect(fs.existsSync(path.join(root, 'units'))).toBe(false);
  });

  test('the CLI refuses a system unit directory that systemctl would not load', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-wrong-unit-dir-'));
    await expect(runCli([
      '--system',
      '--user', 'backup-operator',
      '--home', '/home/backup-operator',
      '--path', '/usr/bin:/bin',
      '--config', config(root),
      '--repo', process.cwd(),
      '--node', process.execPath,
      '--output-dir', path.join(root, 'units'),
    ])).rejects.toThrow(/\/etc\/systemd\/system/);
    expect(fs.existsSync(path.join(root, 'units'))).toBe(false);
  });

  test('the CLI requires root before touching the system unit directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-needs-root-'));
    await expect(runCli([
      '--system',
      '--user', 'backup-operator',
      '--home', '/home/backup-operator',
      '--path', '/usr/bin:/bin',
      '--config', config(root),
      '--repo', process.cwd(),
      '--node', process.execPath,
      '--output-dir', '/etc/systemd/system',
    ], { getuid: () => 1000 })).rejects.toThrow(/must run as root/);
  });

  test('writes units accepted by systemd-analyze', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-systemd-'));
    const outputDir = path.join(root, 'units');
    const repoDir = path.join(root, 'repo-plain');
    fs.mkdirSync(repoDir);
    const result = await installSystemdUnits({
      configPath: config(root),
      repoDir,
      nodePath: process.execPath,
      outputDir,
      onCalendar: 'daily',
      randomizedDelaySeconds: 900,
      systemMode: true,
      systemUser: os.userInfo().username,
      homeDir: os.homedir(),
      pathEnv: process.env.PATH || '/usr/bin:/bin',
      additionalReadWritePaths: [root],
    });
    const service = fs.readFileSync(result.servicePath, 'utf8');

    // Written verbatim: WorkingDirectory= is neither unquoted nor unescaped by
    // systemd, so the only value it can carry is one needing neither.
    expect(service).toContain(`WorkingDirectory=${repoDir}\n`);
    expect(service).not.toContain(`WorkingDirectory="${repoDir}"`);
    expect(service).not.toContain('\\x');

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

  // `systemd-analyze verify` passing is NOT evidence the service can run: a
  // WorkingDirectory= carrying \x20 or a quoted space verifies clean, loads,
  // and then dies at startup with status=200/CHDIR — ExecStart never executes,
  // so the timer looks healthy while no backup is ever written. There is no
  // encoding that survives that field, so installation must refuse the path
  // rather than emit a unit that only looks installed.
  test('refuses a repo path systemd WorkingDirectory= cannot express', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-reject-'));
    const outputDir = path.join(root, 'units');
    const repoDir = path.join(root, 'repo with spaces');
    fs.mkdirSync(repoDir);

    await expect(
      installSystemdUnits({
        configPath: config(root),
        repoDir,
        nodePath: process.execPath,
        outputDir,
        onCalendar: 'daily',
        randomizedDelaySeconds: 900,
      }),
    ).rejects.toThrow(/WorkingDirectory=.*unsupported character/s);

    // Refusing must leave nothing half-installed.
    expect(fs.existsSync(outputDir)).toBe(false);
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
