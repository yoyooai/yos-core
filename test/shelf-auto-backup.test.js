import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';

import {
  createDefaultOperations,
  loadBackupConfig,
  runAutomaticBackup,
} from '../scripts/shelf-auto-backup.mjs';

const SECRET = {
  secretId: 'temporary-id-value',
  secretKey: 'temporary-key-value',
  token: 'temporary-token-value',
  expiration: '2099-08-12T10:00:00Z',
};

function fixtureConfig(root, overrides = {}) {
  return {
    schemaVersion: 1,
    localRepo: process.cwd(),
    stateDir: path.join(root, 'state'),
    restoreRoot: path.join(root, 'restore'),
    shelf: {
      sshTarget: 'backup-test.example',
      nodePath: '/usr/local/bin/node',
      repoDir: '/srv/yos-core',
      root: '/srv/yos-dist',
    },
    cos: {
      bucket: 'backup-test-1234567890',
      region: 'ap-test',
      basePrefix: 'scheduled/',
    },
    credentialCommand: ['/usr/local/bin/mint-yos-backup-token'],
    alertCommand: ['/usr/local/bin/yos-backup-alert'],
    keepSuccessful: 2,
    restoreEvery: 2,
    lockStaleSeconds: 3600,
    commandTimeoutSeconds: 7200,
    ...overrides,
  };
}

function successfulOperations(overrides = {}) {
  return {
    mintCredentials: jest.fn(async () => SECRET),
    remoteAudit: jest.fn(async () => ({
      pass: true,
      buildId: 'b'.repeat(64),
      indexSha256: 'a'.repeat(64),
      matchedFiles: 923,
      registeredFiles: 923,
    })),
    uploadShelf: jest.fn(async () => ({ pass: true, filesWalked: 924, uploadedVerified: 924 })),
    verifyShelf: jest.fn(async () => ({ pass: true, filesWalked: 924, objectsFound: 924, matched: 924 })),
    restoreShelf: jest.fn(async ({ dest }) => {
      await fsp.mkdir(dest, { recursive: true });
      return { pass: true, objectsFound: 924, restoredVerified: 924 };
    }),
    auditRestore: jest.fn(async () => ({
      pass: true,
      buildId: 'b'.repeat(64),
      indexSha256: 'a'.repeat(64),
      matchedFiles: 923,
      registeredFiles: 923,
    })),
    uploadMetadata: jest.fn(async () => ({ pass: true, filesWalked: 1, uploadedVerified: 1 })),
    verifyMetadata: jest.fn(async () => ({ pass: true, filesWalked: 1, objectsFound: 1, matched: 1 })),
    alert: jest.fn(async () => ({ pass: true })),
    ...overrides,
  };
}

function runtime(times = ['2026-08-12T02:03:04.000Z']) {
  let index = 0;
  return {
    now: () => new Date(times[Math.min(index++, times.length - 1)]),
    randomId: () => `run${index}`,
  };
}

describe('automatic shelf backup configuration', () => {
  test('loads a non-secret config and normalizes the base prefix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-config-'));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify(fixtureConfig(root, {
      cos: { bucket: 'backup-test-1234567890', region: 'ap-test', basePrefix: 'scheduled' },
    })));

    const config = await loadBackupConfig(file);

    expect(config.cos.basePrefix).toBe('scheduled/');
    expect(config.configPath).toBe(file);
  });

  async function expectSecretConfigRejected(extra) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-secret-'));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify(fixtureConfig(root, extra)));

    await expect(loadBackupConfig(file)).rejects.toThrow(/credential material/i);
  }

  test('rejects a secret field before a unit can persist it', async () => {
    await expectSecretConfigRejected({ COS_SECRET_KEY: 'do-not-store-this' });
  });

  test('rejects a generic token field before a unit can persist it', async () => {
    await expectSecretConfigRejected({ token: 'do-not-store-this' });
  });

  test('rejects unknown configuration fields instead of trusting their names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-unknown-config-'));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify(fixtureConfig(root, { harmlessLookingValue: 'secret material' })));

    await expect(loadBackupConfig(file)).rejects.toThrow(/unknown field.*harmlessLookingValue/i);
  });

  test('rejects a secret assignment embedded in a command', async () => {
    await expectSecretConfigRejected({
      credentialCommand: ['/bin/sh', '-c', 'COS_SECRET_ID=AKID1234567890123456'],
    });
  });

  test('rejects a credential embedded in a URL', async () => {
    await expectSecretConfigRejected({ alertCommand: ['https://user:password@example.test/hook'] });
  });

  test('rejects a webhook credential embedded in a URL query', async () => {
    await expectSecretConfigRejected({
      alertCommand: ['/secure/alert', 'https://example.test/hook?token=do-not-store-this'],
    });
  });

  test('rejects a group-writable config file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-mode-'));
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify(fixtureConfig(root)));
    fs.chmodSync(file, 0o620);

    await expect(loadBackupConfig(file)).rejects.toThrow(/must not be group- or world-writable/);
  });

  test('requires an alert command instead of silently logging failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-alert-'));
    const file = path.join(root, 'config.json');
    const config = fixtureConfig(root);
    delete config.alertCommand;
    fs.writeFileSync(file, JSON.stringify(config));

    await expect(loadBackupConfig(file)).rejects.toThrow(/alertCommand/);
  });
});

describe('automatic shelf backup run', () => {
  test('uploads, reverse-verifies, restores the first run, and commits redacted state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-success-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations();

    const report = await runAutomaticBackup(config, operations, runtime());

    expect(report.pass).toBe(true);
    expect(report.restored).toBe(true);
    expect(operations.uploadShelf).toHaveBeenCalledTimes(1);
    expect(operations.verifyShelf).toHaveBeenCalledTimes(1);
    expect(operations.remoteAudit).toHaveBeenCalledTimes(2);
    expect(operations.uploadMetadata).toHaveBeenCalledTimes(1);
    expect(operations.verifyMetadata).toHaveBeenCalledTimes(1);
    expect(operations.restoreShelf).toHaveBeenCalledTimes(1);
    const stateText = fs.readFileSync(path.join(config.stateDir, 'state.json'), 'utf8');
    expect(stateText).not.toContain(SECRET.secretId);
    expect(stateText).not.toContain(SECRET.secretKey);
    expect(stateText).not.toContain(SECRET.token);
    expect(JSON.parse(stateText).history).toHaveLength(1);
  });

  test('restores on the first run and then only at the configured interval', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-interval-'));
    const config = fixtureConfig(root, { restoreEvery: 2 });
    const operations = successfulOperations();

    const first = await runAutomaticBackup(config, operations, runtime(['2026-08-12T01:00:00Z']));
    const second = await runAutomaticBackup(config, operations, runtime(['2026-08-13T01:00:00Z']));
    const third = await runAutomaticBackup(config, operations, runtime(['2026-08-14T01:00:00Z']));

    expect([first.restored, second.restored, third.restored]).toEqual([true, false, true]);
    expect(operations.restoreShelf).toHaveBeenCalledTimes(2);
  });

  test('a reverse-verification failure records failure, alerts, and never uploads success metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-fail-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      verifyShelf: jest.fn(async () => ({ pass: false, problems: [{ error: 'missing object' }] })),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/verify shelf/i);

    expect(operations.alert).toHaveBeenCalledTimes(1);
    expect(operations.uploadMetadata).not.toHaveBeenCalled();
    const stateText = fs.readFileSync(path.join(config.stateDir, 'state.json'), 'utf8');
    expect(JSON.parse(stateText).lastFailure.stage).toBe('verify_shelf');
    expect(stateText).not.toContain(SECRET.secretKey);
  });

  test('an unhealthy shelf stops before temporary credentials are minted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-source-red-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      remoteAudit: jest.fn(async () => ({ pass: false, problems: [{ error: 'shelf mismatch' }] })),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/audit shelf.*shelf mismatch/i);

    expect(operations.mintCredentials).not.toHaveBeenCalled();
    expect(operations.uploadShelf).not.toHaveBeenCalled();
  });

  test('a shelf identity change during upload rejects the run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-race-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      remoteAudit: jest.fn()
        .mockResolvedValueOnce({
          pass: true, buildId: 'b'.repeat(64), indexSha256: 'a'.repeat(64),
          matchedFiles: 923, registeredFiles: 923,
        })
        .mockResolvedValueOnce({
          pass: true, buildId: 'c'.repeat(64), indexSha256: 'd'.repeat(64),
          matchedFiles: 923, registeredFiles: 923,
        }),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/changed during backup/i);

    expect(operations.uploadMetadata).not.toHaveBeenCalled();
    expect(operations.alert).toHaveBeenCalledTimes(1);
  });

  test('failure evidence and alerts redact temporary credentials', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-redact-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      uploadShelf: jest.fn(async () => {
        throw new Error(`request failed with ${SECRET.secretId} ${SECRET.secretKey} ${SECRET.token}`);
      }),
    });

    let thrown;
    try {
      await runAutomaticBackup(config, operations, runtime());
    } catch (error) {
      thrown = error;
    }

    expect(thrown.message).not.toContain(SECRET.secretKey);
    const alertEvent = operations.alert.mock.calls[0][0];
    expect(JSON.stringify(alertEvent)).not.toContain(SECRET.secretId);
    expect(JSON.stringify(alertEvent)).not.toContain(SECRET.secretKey);
    expect(JSON.stringify(alertEvent)).not.toContain(SECRET.token);
    expect(fs.readFileSync(path.join(config.stateDir, 'state.json'), 'utf8')).not.toContain(SECRET.secretKey);
  });

  test('an alert failure cannot turn the original backup failure into success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-alert-fail-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      uploadShelf: jest.fn(async () => { throw new Error('upload unavailable'); }),
      alert: jest.fn(async () => { throw new Error('alert unavailable'); }),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/upload unavailable.*alert unavailable/i);
  });

  test('a failure-evidence write error still sends the original alert', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-state-write-'));
    const config = fixtureConfig(root);
    const statePath = path.join(config.stateDir, 'state.json');
    const operations = successfulOperations({
      uploadShelf: jest.fn(async () => {
        fs.mkdirSync(statePath, { recursive: true });
        throw new Error('upload unavailable');
      }),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(
      /upload unavailable.*failure evidence write failed/i,
    );
    expect(operations.alert).toHaveBeenCalledTimes(1);
    expect(operations.alert.mock.calls[0][0].error).toBe('upload unavailable');
  });

  test('failure events remove private roots and stack frames', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-private-path-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      uploadShelf: jest.fn(async () => {
        throw new Error(`cannot read ${config.shelf.root}/index.json\n    at deep (${config.localRepo}/private.mjs:1:1)`);
      }),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/\[PRIVATE_PATH\]/);
    const eventText = JSON.stringify(operations.alert.mock.calls[0][0]);
    expect(eventText).not.toContain(config.shelf.root);
    expect(eventText).not.toContain(config.localRepo);
    expect(eventText).not.toContain('at deep');
  });

  test('a live lock rejects a concurrent run before minting credentials', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-lock-'));
    const config = fixtureConfig(root);
    fs.mkdirSync(path.join(config.stateDir, 'run.lock'), { recursive: true });
    fs.writeFileSync(path.join(config.stateDir, 'run.lock', 'owner.json'), JSON.stringify({ pid: process.pid }));
    const operations = successfulOperations();

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/already running/i);
    expect(operations.mintCredentials).not.toHaveBeenCalled();
    expect(operations.alert).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(config.stateDir, 'run.lock'))).toBe(true);
  });

  test('a live process lock is never stolen just because its timestamp is old', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-live-old-'));
    const config = fixtureConfig(root, { lockStaleSeconds: 1 });
    const lock = path.join(config.stateDir, 'run.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(lock, old, old);
    const operations = successfulOperations();

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/already running/i);
    expect(operations.mintCredentials).not.toHaveBeenCalled();
    expect(fs.existsSync(lock)).toBe(true);
  });

  test('a stale lock is recovered and the recovery is retained in the run evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-stale-'));
    const config = fixtureConfig(root, { lockStaleSeconds: 1 });
    const lock = path.join(config.stateDir, 'run.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), '{}');
    const old = new Date('2026-08-11T00:00:00Z');
    fs.utimesSync(lock, old, old);

    const report = await runAutomaticBackup(config, successfulOperations(), runtime(['2026-08-12T00:00:00Z']));

    expect(report.staleLockRecovered).toBe(true);
  });

  test('a corrupt state file alerts and releases the lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-corrupt-state-'));
    const config = fixtureConfig(root);
    fs.mkdirSync(config.stateDir, { recursive: true });
    const statePath = path.join(config.stateDir, 'state.json');
    fs.writeFileSync(statePath, '{not-json');
    const operations = successfulOperations();

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/state/i);

    expect(operations.alert).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(config.stateDir, 'run.lock'))).toBe(false);
    expect(operations.mintCredentials).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf8')).toBe('{not-json');
    expect(fs.existsSync(path.join(config.stateDir, 'last-failure.json'))).toBe(true);
  });

  test('off-site metadata does not claim the whole job passed before its own verification', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-meta-honesty-'));
    const config = fixtureConfig(root);
    let uploadedEvidence;
    const operations = successfulOperations({
      uploadMetadata: jest.fn(async ({ root: metadataRoot }) => {
        uploadedEvidence = JSON.parse(fs.readFileSync(path.join(metadataRoot, 'run.json'), 'utf8'));
        return { pass: true, filesWalked: 1, uploadedVerified: 1 };
      }),
    });

    const result = await runAutomaticBackup(config, operations, runtime());

    expect(uploadedEvidence.pass).toBeUndefined();
    expect(uploadedEvidence.backupVerified).toBe(true);
    expect(result.pass).toBe(true);
  });

  test('a restored shelf with a different identity rejects the run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-restore-id-'));
    const config = fixtureConfig(root);
    const operations = successfulOperations({
      auditRestore: jest.fn(async () => ({
        pass: true,
        buildId: 'different',
        indexSha256: 'different',
        matchedFiles: 923,
        registeredFiles: 923,
      })),
    });

    await expect(runAutomaticBackup(config, operations, runtime())).rejects.toThrow(/restored shelf identity differs/i);
    expect(operations.uploadMetadata).not.toHaveBeenCalled();
  });

  test('retention produces candidates without issuing a delete operation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-retention-'));
    const config = fixtureConfig(root, { keepSuccessful: 2, restoreEvery: 99 });
    const operations = successfulOperations();

    await runAutomaticBackup(config, operations, runtime(['2026-08-10T00:00:00Z']));
    await runAutomaticBackup(config, operations, runtime(['2026-08-11T00:00:00Z']));
    const third = await runAutomaticBackup(config, operations, runtime(['2026-08-12T00:00:00Z']));

    expect(third.retentionCandidates).toHaveLength(1);
    expect(third.retentionCandidates[0]).toMatch(/^scheduled\/20260810/);
    expect(Object.keys(operations).some((name) => /delete|remove|prune/i.test(name))).toBe(false);
  });
});

describe('automatic shelf backup command wiring', () => {
  test('credentials travel in SSH stdin, never command arguments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-wiring-'));
    const config = fixtureConfig(root);
    const calls = [];
    const runProcess = jest.fn(async (request) => {
      calls.push(request);
      if (request.label === 'mint_credentials') return { stdout: JSON.stringify(SECRET), stderr: '' };
      return { stdout: JSON.stringify({ pass: true }), stderr: '' };
    });
    const operations = createDefaultOperations(config, { runProcess });

    const credentials = await operations.mintCredentials('scheduled/run/');
    await operations.uploadShelf({ prefix: 'scheduled/run/shelf/', credentials });
    await operations.alert({ type: 'test' });

    const upload = calls.find((call) => call.label === 'upload_shelf');
    expect(upload.args.join(' ')).not.toContain(SECRET.secretKey);
    expect(upload.args.join(' ')).not.toContain(SECRET.token);
    expect(upload.stdin).toContain(SECRET.secretKey);
    expect(upload.stdin).toContain(SECRET.token);
    expect(upload.stdin).toContain('timeout --signal=TERM --kill-after=10s 7200s');
    expect(upload.args).toEqual([
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=30',
      '--', 'backup-test.example', 'bash', '-s',
    ]);
    const alert = calls.find((call) => call.label === 'alert');
    expect(alert.stripEnv).toEqual(expect.arrayContaining([
      'TENCENTCLOUD_SECRET_ID',
      'TENCENTCLOUD_SECRET_KEY',
      'COS_SECRET_ID',
      'COS_SECRET_KEY',
      'COS_SESSION_TOKEN',
    ]));
  });

  test('the credential command cannot inherit ambient Tencent or COS secrets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-env-'));
    const config = fixtureConfig(root);
    let request;
    const operations = createDefaultOperations(config, {
      runProcess: async (value) => {
        request = value;
        return { stdout: JSON.stringify(SECRET), stderr: '' };
      },
    });

    await operations.mintCredentials('scheduled/run/');

    expect(request.stripEnv).toEqual(expect.arrayContaining([
      'TENCENTCLOUD_SECRET_ID',
      'TENCENTCLOUD_SECRET_KEY',
      'COS_SECRET_ID',
      'COS_SECRET_KEY',
      'COS_SESSION_TOKEN',
    ]));
  });

  test('refuses an expired credential before opening SSH', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-expired-'));
    const config = fixtureConfig(root);
    const runProcess = jest.fn(async (request) => {
      if (request.label === 'mint_credentials') {
        return { stdout: JSON.stringify({ ...SECRET, expiration: '2020-01-01T00:00:00Z' }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    });
    const operations = createDefaultOperations(config, { runProcess });

    await expect(operations.mintCredentials('scheduled/run/')).rejects.toThrow(/expired expiration/);
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  test('does not expose credential-command stderr when minting fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-mint-error-'));
    const script = path.join(root, 'fail.mjs');
    const leaked = 'AKIDTHISMUSTNOTAPPEAR123456789';
    fs.writeFileSync(script, `process.stderr.write(${JSON.stringify(leaked)}); process.exit(23);\n`);
    const config = fixtureConfig(root, { credentialCommand: [process.execPath, script] });
    const operations = createDefaultOperations(config);

    await expect(operations.mintCredentials('scheduled/run/')).rejects.toThrow(
      /^mint_credentials failed \(exit 23\)$/,
    );
    await expect(operations.mintCredentials('scheduled/run/')).rejects.not.toThrow(leaked);
  });

  test('a timed-out credential command cannot leave a child process running', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-auto-timeout-tree-'));
    const marker = path.join(root, 'late-write');
    const script = path.join(root, 'hang.mjs');
    fs.writeFileSync(script, [
      "import { spawn } from 'node:child_process';",
      `spawn(process.execPath, ['-e', ${JSON.stringify(
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1400)`,
      )}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const config = fixtureConfig(root, {
      credentialCommand: [process.execPath, script],
      commandTimeoutSeconds: 1,
    });
    const operations = createDefaultOperations(config);

    await expect(operations.mintCredentials('scheduled/run/')).rejects.toThrow(/SIGKILL/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fs.existsSync(marker)).toBe(false);
  });
});
