import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  createFinalizeState,
  prepareSelfUpgrade,
  recoverSelfUpgrade,
  runSelfUpgrade,
  runSelfUpgradeFinalize,
  step1_backupCoreSkills,
  step7_syncInstructions,
  rollbackSelf,
  step10_ensureCodexConfig,
} = await import('../self-upgrade.js');
const { generateMigrationHints, applyMigrationHints } = await import('../self-upgrade.js');
const { deployManifestTemplate } = await import('../runtime/tmux-env.js');
const { activateFreshSplitInstructions } = await import('../runtime/instruction-builder.js');

function fixtureYOSDir() {
  return path.resolve(process.env.YOS_DIR || path.join(os.homedir(), 'yos'));
}

function yosHookPath(relativePath) {
  return path.join(fixtureYOSDir(), '.claude', relativePath).replaceAll('\\', '/');
}

function writeSplitPackage(pkgRoot) {
  const templatesDir = path.join(pkgRoot, 'templates');
  const runtimeDir = path.join(pkgRoot, 'cli', 'lib', 'runtime');
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, 'claude-system.md'), '# Claude system\n');
  fs.writeFileSync(path.join(templatesDir, 'codex-system.md'), '# Codex system\n');
  fs.writeFileSync(path.join(templatesDir, 'onboarding.md'), '# Onboarding\n');
  fs.writeFileSync(path.join(templatesDir, 'YOS.md'), '# YOS user instructions\n');
  fs.copyFileSync(path.resolve('cli/lib/runtime/assembler.mjs'), path.join(runtimeDir, 'assembler.mjs'));
}

describe('self-upgrade finalizer handoff', () => {
  it('serializes the state needed by the newly installed finalizer', () => {
    assert.deepEqual(createFinalizeState({
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      previousCorePackage: '/tmp/backup/core/yos-old.tgz',
      coreInstallAttempted: true,
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
    }), {
      schemaVersion: 2,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      previousCorePackage: '/tmp/backup/core/yos-old.tgz',
      coreInstallAttempted: true,
      servicesWereRunning: ['activity-monitor', 'c4-dispatcher'],
      from: '0.4.12',
      to: '0.4.13',
      newVersion: '0.4.13',
      mode: 'merge',
    });
  });

  it('rejects a future finalizer state schema before running post-install steps', () => {
    let stepCalled = false;
    const result = runSelfUpgradeFinalize({
      schemaVersion: 3,
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [() => {
        stepCalled = true;
        return { step: 5, name: 'sync_core_skills', status: 'done' };
      }],
    });

    assert.equal(stepCalled, false);
    assert.equal(result.success, false);
    assert.equal(result.error, 'unsupported finalize state schemaVersion: 3');
    assert.equal(result.rollback.performed, false);
  });

  it('treats a legacy finalizer state as unable to restore the previous core', () => {
    const rollbackCalls = [];
    const result = runSelfUpgradeFinalize({
      schemaVersion: 1,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [
        () => ({ step: 6, name: 'install_skill_dependencies', status: 'failed', error: 'dependency failed' }),
      ],
      rollbackSelf: (ctx) => {
        rollbackCalls.push({
          coreInstallAttempted: ctx.coreInstallAttempted,
          previousCorePackage: ctx.previousCorePackage,
          handoffState: ctx.handoffState,
        });
        return [
          { action: 'restore_previous_core', success: false, error: 'previous core package backup is missing' },
          { action: 'restore_core_skills', success: true },
          {
            action: 'verify_restored_core_version',
            success: false,
            expectedVersion: '0.4.12',
            actualVersion: '0.4.13',
            error: 'installed core version 0.4.13 does not match expected 0.4.12',
          },
        ];
      },
    });

    assert.deepEqual(rollbackCalls, [{
      coreInstallAttempted: true,
      previousCorePackage: null,
      handoffState: 'legacy',
    }]);
    assert.equal(result.success, false);
    assert.equal(result.rollback.attempted, true);
    assert.equal(result.rollback.performed, false);
    assert.equal(result.machineState, 'recovery_required');
    assert.equal(result.manualRecovery.expectedCoreVersion, '0.4.12');
    assert.equal(result.manualRecovery.actualCoreVersion, '0.4.13');
    assert.equal(result.manualRecovery.coreSkillsRestored, true);
    assert.match(result.manualRecovery.message, /Core remains at 0\.4\.13/);
    assert.match(result.manualRecovery.message, /not rolled back to 0\.4\.12/);
    assert.match(result.manualRecovery.message, /Core Skills were restored/);
  });

  it('treats an unversioned finalizer state as legacy', () => {
    let handoffState;
    const result = runSelfUpgradeFinalize({
      backupDir: '/tmp/backup',
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [
        () => ({ step: 6, name: 'install_skill_dependencies', status: 'failed', error: 'dependency failed' }),
      ],
      rollbackSelf: (ctx) => {
        handoffState = ctx.handoffState;
        return [{ action: 'restore_core_skills', success: true }];
      },
    });

    assert.equal(handoffState, 'legacy');
    assert.equal(result.success, false);
  });

  it('runs post-install steps with restored state and returns upgrade metadata', () => {
    const calls = [];
    const result = runSelfUpgradeFinalize({
      schemaVersion: 2,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesStopped: ['activity-monitor'],
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
      mode: 'merge',
    }, {
      steps: [
        (ctx) => {
          calls.push({
            tempDir: ctx.tempDir,
            backupDir: ctx.backupDir,
            servicesWereRunning: ctx.servicesWereRunning,
            mode: ctx.mode,
          });
          return { step: 5, name: 'sync_core_skills', status: 'done', message: 'ok' };
        },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.from, '0.4.12');
    assert.equal(result.to, '0.4.13');
    assert.equal(result.backupDir, '/tmp/backup');
    assert.equal(result.steps.length, 1);
    assert.deepEqual(calls, [{
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      mode: 'merge',
    }]);
  });

  it('rolls back when a post-install step before baseline commit fails', () => {
    const rollbackCalls = [];
    const result = runSelfUpgradeFinalize({
      schemaVersion: 2,
      tempDir: '/tmp/new-core',
      backupDir: '/tmp/backup',
      previousCorePackage: '/tmp/backup/core/yos-old.tgz',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [
        () => ({ step: 5, name: 'sync_core_skills', status: 'failed', error: 'sync failed' }),
      ],
      rollbackSelf: (ctx) => {
        rollbackCalls.push(ctx.previousCorePackage);
        return [{ action: 'restore_previous_core', success: true }];
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 5);
    assert.equal(result.error, 'sync failed');
    assert.deepEqual(rollbackCalls, ['/tmp/backup/core/yos-old.tgz']);
    assert.deepEqual(result.rollback, {
      attempted: true,
      performed: true,
      steps: [{ action: 'restore_previous_core', success: true }],
    });
  });

  it('rolls back when service verification fails at step 12', () => {
    const result = runSelfUpgradeFinalize({
      schemaVersion: 2,
      backupDir: '/tmp/backup',
      previousCorePackage: '/tmp/backup/core/yos-old.tgz',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [
        () => ({ step: 12, name: 'verify_services', status: 'failed', error: 'offline' }),
      ],
      rollbackSelf: () => [{ action: 'restart_activity-monitor', success: true }],
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 12);
    assert.equal(result.rollback.performed, true);
  });

  it('keeps a healthy upgrade with an explicit retained-backup warning when step 13 fails', () => {
    let rollbackCalled = false;
    let cleanupCalled = false;
    const result = runSelfUpgradeFinalize({
      schemaVersion: 2,
      backupDir: '/tmp/backup',
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
      to: '0.4.13',
    }, {
      steps: [
        () => ({ step: 13, name: 'commit_skill_baselines', status: 'failed', error: 'commit failed' }),
      ],
      rollbackSelf: () => {
        rollbackCalled = true;
        return [];
      },
      cleanupBackup: () => {
        cleanupCalled = true;
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.retainBackup, true);
    assert.deepEqual(result.warnings, [{
      step: 13,
      name: 'commit_skill_baselines',
      message: 'commit failed',
    }]);
    assert.equal(rollbackCalled, false);
    assert.equal(cleanupCalled, false);
  });
});

describe('self-upgrade preflight', () => {
  it('prepares the candidate package and dependencies before any backup or service stop', () => {
    const calls = [];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-preflight-test-'));
    const ctx = { tempDir };
    const result = prepareSelfUpgrade(ctx, {
      preparationDir: path.join(tempDir, 'prepared'),
      assertDiskSpace: () => calls.push('disk'),
      assertNpmAvailable: () => calls.push('npm'),
      prepareSkillDependencies: () => calls.push('dependencies'),
      packCandidate: () => {
        calls.push('pack');
        return '/tmp/prepared/yos-new.tgz';
      },
    });

    assert.equal(result.status, 'done');
    assert.deepEqual(calls, ['disk', 'npm', 'dependencies', 'pack']);
    assert.equal(ctx.preparedPackage, '/tmp/prepared/yos-new.tgz');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects a failed preflight without creating a backup or stopping services', () => {
    let preInstallCalled = false;
    const result = runSelfUpgrade({
      tempDir: '/tmp/new-core',
      newVersion: '0.4.13',
    }, {
      getCurrentVersion: () => ({ success: true, version: '0.4.12' }),
      prepareSelfUpgrade: () => ({
        step: 0,
        name: 'preflight',
        status: 'failed',
        error: 'dependency preparation failed',
      }),
      preInstallSteps: [() => {
        preInstallCalled = true;
        return { step: 1, name: 'backup', status: 'done' };
      }],
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 0);
    assert.equal(result.backupDir, null);
    assert.equal(result.rollback.performed, false);
    assert.equal(result.machineState, 'unchanged');
    assert.equal(result.manualRecovery, undefined);
    assert.equal(preInstallCalled, false);
  });

  it('turns a thrown preparation error into an unchanged-machine failure result', () => {
    const result = runSelfUpgrade({ tempDir: '/tmp/new-core', newVersion: '0.4.13' }, {
      getCurrentVersion: () => ({ success: true, version: '0.4.12' }),
      prepareSelfUpgrade: () => {
        throw new Error('preparation exploded');
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 0);
    assert.equal(result.error, 'preparation exploded');
    assert.equal(result.machineState, 'unchanged');
    assert.equal(result.rollback.performed, false);
  });

  it('always runs preparation before backup and service-stop steps', () => {
    const calls = [];
    const result = runSelfUpgrade({ tempDir: '/tmp/new-core', newVersion: '0.4.13' }, {
      getCurrentVersion: () => ({ success: true, version: '0.4.12' }),
      prepareSelfUpgrade: () => {
        calls.push('prepare');
        return { step: 0, name: 'prepare_upgrade', status: 'done' };
      },
      preInstallSteps: [
        () => {
          calls.push('backup');
          return { step: 1, name: 'backup', status: 'done' };
        },
        () => {
          calls.push('stop');
          return { step: 3, name: 'stop', status: 'done' };
        },
      ],
      runInstalledFinalizer: () => ({ action: 'self_upgrade', success: true, steps: [] }),
    });

    assert.equal(result.success, true);
    assert.deepEqual(calls, ['prepare', 'backup', 'stop']);
  });
});

describe('step10_ensureCodexConfig', () => {
  it('skips codex config write when non-codex runtime has no codex state', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'claude' },
      codexDir: '/tmp/fake-codex-none',
      existsSync: () => false,
      writeConfig: () => {
        throw new Error('should not be called');
      }
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.message, 'codex not in use');
  });

  it('treats codex config write failure as best-effort outside codex runtime', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'claude' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.message, /warning: failed to refresh codex config outside codex runtime/);
  });

  it('still fails when codex runtime cannot write codex config', () => {
    const result = step10_ensureCodexConfig({
      cfg: { runtime: 'codex' },
      codexDir: '/tmp/fake-codex',
      existsSync: () => true,
      writeConfig: () => false
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'failed to write codex config');
  });
});

describe('self-upgrade backup and rollback', () => {
  it('backs up the deployed core ecosystem file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-self-upgrade-backup-'));
    const yosDir = path.join(tmpDir, 'yos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.join(yosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(yosDir, 'pm2', 'ecosystem.config.cjs'), 'module.exports = { apps: ["old"] };\n', 'utf8');

    const ctx = {};
    const result = step1_backupCoreSkills(ctx, {
      yosDir,
      skillsDir,
      backupDir,
      packCurrentCore: () => {
        const coreDir = path.join(backupDir, 'core');
        fs.mkdirSync(coreDir, { recursive: true });
        const archive = path.join(coreDir, 'yos-old.tgz');
        fs.writeFileSync(archive, 'old core');
        return archive;
      },
    });

    assert.equal(result.status, 'done');
    assert.equal(
      fs.readFileSync(path.join(backupDir, 'pm2', 'ecosystem.config.cjs'), 'utf8'),
      'module.exports = { apps: ["old"] };\n'
    );
    assert.equal(ctx.previousCorePackage, path.join(backupDir, 'core', 'yos-old.tgz'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backs up real skill contents when the skills root is a symlink', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-self-upgrade-symlink-backup-'));
    const yosDir = path.join(tmpDir, 'yos');
    const realSkillsDir = path.join(tmpDir, 'real-skills');
    const skillsDir = path.join(yosDir, '.claude', 'skills');
    const backupDir = path.join(tmpDir, 'backup');

    fs.mkdirSync(path.dirname(skillsDir), { recursive: true });
    fs.mkdirSync(path.join(realSkillsDir, 'activity-monitor'), { recursive: true });
    fs.mkdirSync(path.join(realSkillsDir, 'lark'), { recursive: true });
    fs.writeFileSync(path.join(realSkillsDir, 'activity-monitor', 'SKILL.md'), '# Activity Monitor\n', 'utf8');
    fs.writeFileSync(path.join(realSkillsDir, 'lark', 'SKILL.md'), '# Lark\n', 'utf8');
    fs.symlinkSync(realSkillsDir, skillsDir);

    const ctx = {};
    const result = step1_backupCoreSkills(ctx, {
      yosDir,
      skillsDir,
      backupDir,
      packCurrentCore: () => path.join(backupDir, 'core', 'yos-old.tgz'),
    });

    assert.equal(result.status, 'done');
    assert.equal(fs.lstatSync(path.join(backupDir, 'skills')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(backupDir, 'skills')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(backupDir, 'skills', 'activity-monitor', 'SKILL.md'), 'utf8'), '# Activity Monitor\n');
    assert.equal(fs.readFileSync(path.join(backupDir, 'skills', 'lark', 'SKILL.md'), 'utf8'), '# Lark\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores the backed-up ecosystem before restarting services', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-self-upgrade-rollback-'));
    const yosDir = path.join(tmpDir, 'yos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const ecosystemPath = path.join(yosDir, 'pm2', 'ecosystem.config.cjs');

    fs.mkdirSync(path.join(backupDir, 'pm2'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'pm2', 'ecosystem.config.cjs'), 'module.exports = { apps: ["restored"] };\n', 'utf8');
    fs.writeFileSync(ecosystemPath, 'module.exports = { apps: ["broken-new"] };\n', 'utf8');

    const restartCalls = [];
    const actions = [];
    const results = rollbackSelf({
      backupDir,
      previousCorePackage: path.join(backupDir, 'core', 'yos-old.tgz'),
      from: '0.4.12',
      servicesWereRunning: ['activity-monitor'],
    }, {
      yosDir,
      skillsDir,
      ecosystemPath,
      installPreviousCore: (archive) => actions.push(`install:${archive}`),
      restartManagedProcess: (name, opts) => {
        actions.push(`restart:${name}`);
        restartCalls.push({
          name,
          opts,
          ecosystemContent: fs.readFileSync(opts.ecosystemPath, 'utf8'),
        });
      },
      verifyServices: () => ({ success: true, offline: [] }),
    });

    assert.equal(
      fs.readFileSync(ecosystemPath, 'utf8'),
      'module.exports = { apps: ["restored"] };\n'
    );
    assert.deepStrictEqual(restartCalls, [{
      name: 'activity-monitor',
      opts: { ecosystemPath, stdio: 'pipe', fallbackToPlainRestartOnError: true },
      ecosystemContent: 'module.exports = { apps: ["restored"] };\n',
    }]);
    assert.equal(results.some((item) => item.action === 'restore_pm2_ecosystem' && item.success), true);
    assert.deepEqual(actions, [
      `install:${path.join(backupDir, 'core', 'yos-old.tgz')}`,
      'restart:activity-monitor',
    ]);
    assert.equal(results.some((item) => item.action === 'restore_previous_core' && item.success), true);
    assert.equal(results.some((item) => item.action === 'verify_restored_services' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  it('falls back to plain restart when the backup has no ecosystem file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-self-upgrade-rollback-fallback-'));
    const yosDir = path.join(tmpDir, 'yos');
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const ecosystemPath = path.join(yosDir, 'pm2', 'ecosystem.config.cjs');

    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(path.join(yosDir, 'pm2'), { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    const restartCalls = [];
    const results = rollbackSelf({
      backupDir,
      previousCorePackage: path.join(backupDir, 'core', 'yos-old.tgz'),
      servicesWereRunning: ['activity-monitor'],
    }, {
      yosDir,
      skillsDir,
      ecosystemPath,
      installPreviousCore: () => {},
      restartManagedProcess: (name, opts) => {
        restartCalls.push({ name, opts });
      },
      verifyServices: () => ({ success: true, offline: [] }),
    });

    assert.deepStrictEqual(restartCalls, [{
      name: 'activity-monitor',
      opts: { ecosystemPath, stdio: 'pipe', fallbackToPlainRestartOnError: true },
    }]);
    assert.equal(results.some((item) => item.action === 'restart_activity-monitor' && item.success), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recovers a retained transaction backup through the supported recovery entrypoint', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-self-upgrade-recover-'));
    const backupDir = path.join(tmpDir, 'yos-core-backup-test');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'rollback-state.json'), JSON.stringify({
      schemaVersion: 1,
      backupDir,
      previousCorePackage: path.join(backupDir, 'core', 'yos-old.tgz'),
      coreInstallAttempted: true,
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
    }));

    const calls = [];
    const result = recoverSelfUpgrade(backupDir, {
      allowedTmpRoots: [tmpDir],
      rollbackSelf: (state) => {
        calls.push(state.from);
        return [
          { action: 'restore_previous_core', success: true },
          { action: 'verify_restored_services', success: true },
        ];
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(calls, ['0.4.12']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a recovery directory outside the allowed temporary roots', () => {
    const result = recoverSelfUpgrade('/private/not-a-yos-backup', {
      allowedTmpRoots: ['/tmp'],
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'invalid_recovery_backup');
  });

  it('rejects a recovery state that points at a core package outside its backup', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-self-upgrade-recover-'));
    const backupDir = path.join(tmpDir, 'yos-core-backup-test');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'rollback-state.json'), JSON.stringify({
      schemaVersion: 1,
      backupDir,
      previousCorePackage: path.join(tmpDir, 'untrusted.tgz'),
      coreInstallAttempted: true,
      servicesWereRunning: ['activity-monitor'],
      from: '0.4.12',
    }));

    let rollbackCalled = false;
    const result = recoverSelfUpgrade(backupDir, {
      allowedTmpRoots: [tmpDir],
      rollbackSelf: () => {
        rollbackCalled = true;
        return [];
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'invalid_recovery_state');
    assert.equal(rollbackCalled, false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Claude model migration hints', () => {
  it('adds a model backfill hint when the installed settings omit model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-model-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const yosDir = path.join(tmpDir, 'yos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }), 'utf8');
    fs.writeFileSync(path.join(yosDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { yosDir });
    assert.deepEqual(
      hints.filter((hint) => hint.type === 'model_backfill'),
      [{ type: 'model_backfill', value: 'claude-opus-4-6' }]
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downgrades 1m model in hint when threshold is above 30', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-model-guard-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const yosDir = path.join(tmpDir, 'yos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus[1m]' }), 'utf8');
    fs.writeFileSync(path.join(yosDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, {
      yosDir,
      getConfig: () => ({ new_session_threshold: 70 }),
    });
    assert.deepEqual(
      hints.filter((hint) => hint.type === 'model_backfill'),
      [{ type: 'model_backfill', value: 'opus' }]
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not add a model backfill hint when the user already configured model', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-model-nohint-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const yosDir = path.join(tmpDir, 'yos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }), 'utf8');
    fs.writeFileSync(path.join(yosDir, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet' }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { yosDir });
    assert.equal(hints.some((hint) => hint.type === 'model_backfill'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills model during applyMigrationHints only when the field is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-model-apply-'));
    const yosDir = path.join(tmpDir, 'yos');
    const settingsPath = path.join(yosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }) + '\n', 'utf8');

    const result = applyMigrationHints([{ type: 'model_backfill', value: 'claude-opus-4-6' }], { yosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(result.applied, 1);
    assert.equal(updated.model, 'claude-opus-4-6');

    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet' }) + '\n', 'utf8');
    const preserved = applyMigrationHints([{ type: 'model_backfill', value: 'claude-opus-4-6' }], { yosDir });
    const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(preserved.applied, 0);
    assert.equal(preservedSettings.model, 'sonnet');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('Boolean setting migration hints (autoMemoryEnabled, autoDreamEnabled)', () => {
  it('adds setting_backfill hints when installed settings omit them', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-setting-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const yosDir = path.join(tmpDir, 'yos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false, autoDreamEnabled: false }), 'utf8');
    fs.writeFileSync(path.join(yosDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: {} }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { yosDir });
    const settingHints = hints.filter((h) => h.type === 'setting_backfill');
    assert.equal(settingHints.length, 2);
    assert.deepEqual(settingHints[0], { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false });
    assert.deepEqual(settingHints[1], { type: 'setting_backfill', key: 'autoDreamEnabled', value: false });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not add hints when user already configured the settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-setting-nohint-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const yosDir = path.join(tmpDir, 'yos');

    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: false, autoDreamEnabled: false }), 'utf8');
    fs.writeFileSync(path.join(yosDir, '.claude', 'settings.json'),
      JSON.stringify({ autoMemoryEnabled: true, autoDreamEnabled: true }), 'utf8');

    const hints = generateMigrationHints(templatesDir, { yosDir });
    assert.equal(hints.some((h) => h.type === 'setting_backfill'), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills settings during applyMigrationHints only when absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-setting-apply-'));
    const yosDir = path.join(tmpDir, 'yos');
    const settingsPath = path.join(yosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }) + '\n', 'utf8');

    const result = applyMigrationHints([
      { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false },
      { type: 'setting_backfill', key: 'autoDreamEnabled', value: false },
    ], { yosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(result.applied, 2);
    assert.equal(updated.autoMemoryEnabled, false);
    assert.equal(updated.autoDreamEnabled, false);

    // User-configured values should be preserved
    fs.writeFileSync(settingsPath, JSON.stringify({ autoMemoryEnabled: true, autoDreamEnabled: true }) + '\n', 'utf8');
    const preserved = applyMigrationHints([
      { type: 'setting_backfill', key: 'autoMemoryEnabled', value: false },
      { type: 'setting_backfill', key: 'autoDreamEnabled', value: false },
    ], { yosDir });
    const preservedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(preserved.applied, 0);
    assert.equal(preservedSettings.autoMemoryEnabled, true);
    assert.equal(preservedSettings.autoDreamEnabled, true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('self-upgrade hook migration hints', () => {
  function writeSettingsPair({ templateSettings, installedSettings }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-hook-hints-'));
    const templatesDir = path.join(tmpDir, 'templates');
    const yosDir = path.join(tmpDir, 'yos');
    fs.mkdirSync(path.join(templatesDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, '.claude', 'settings.json'),
      JSON.stringify(templateSettings),
      'utf8'
    );
    fs.writeFileSync(
      path.join(yosDir, '.claude', 'settings.json'),
      JSON.stringify(installedSettings),
      'utf8'
    );
    return { tmpDir, templatesDir, yosDir };
  }

  it('generates removed_hook for retired core SessionStart hooks absent from the template', () => {
    const { tmpDir, templatesDir, yosDir } = writeSettingsPair({
      templateSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: 'node ~/yos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js',
              timeout: 20000,
            }],
          }],
        },
      },
      installedSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: `node ${yosHookPath('skills/yos-memory/scripts/session-start-inject.js')}`,
              timeout: 10000,
            }],
          }],
        },
      },
    });

    const hints = generateMigrationHints(templatesDir, { yosDir });

    assert.ok(hints.some(hint =>
      hint.type === 'removed_hook' &&
      hint.command.includes('session-start-inject.js')
    ));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not generate removed_hook for custom or non-command hooks', () => {
    const { tmpDir, templatesDir, yosDir } = writeSettingsPair({
      templateSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: 'node ~/yos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js',
              timeout: 20000,
            }],
          }],
        },
      },
      installedSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [
              { type: 'command', command: 'node /custom/session-start.js', timeout: 5000 },
              { type: 'prompt', prompt: 'keep me' },
            ],
          }],
        },
      },
    });

    const hints = generateMigrationHints(templatesDir, { yosDir });

    assert.equal(hints.some(hint => hint.type === 'removed_hook'), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches modified hooks by canonical script key during hint generation and apply', () => {
    const { tmpDir, templatesDir, yosDir } = writeSettingsPair({
      templateSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: 'node ~/yos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js',
              timeout: 20000,
            }],
          }],
        },
      },
      installedSettings: {
        hooks: {
          SessionStart: [{
            matcher: 'startup',
            hooks: [{
              type: 'command',
              command: `node ${yosHookPath('skills/activity-monitor/scripts/session-start-orchestrator.js')}`,
              timeout: 10000,
            }],
          }],
        },
      },
    });

    const hints = generateMigrationHints(templatesDir, { yosDir });
    const modified = hints.find(hint => hint.type === 'modified_hook');

    assert.ok(modified);
    assert.equal(modified.timeout, 20000);

    const result = applyMigrationHints(hints, { yosDir });
    const updated = JSON.parse(fs.readFileSync(path.join(yosDir, '.claude', 'settings.json'), 'utf8'));

    assert.equal(result.errors.length, 0);
    assert.equal(updated.hooks.SessionStart[0].hooks[0].command, 'node ~/yos/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js');
    assert.equal(updated.hooks.SessionStart[0].hooks[0].timeout, 20000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes hooks by canonical script key during applyMigrationHints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-hook-apply-'));
    const yosDir = path.join(tmpDir, 'yos');
    const settingsPath = path.join(yosDir, '.claude', 'settings.json');

    fs.mkdirSync(path.join(yosDir, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: 'startup',
          hooks: [{
            type: 'command',
            command: `node ${yosHookPath('skills/yos-memory/scripts/session-start-inject.js')}`,
            timeout: 10000,
          }],
        }],
      },
    }) + '\n', 'utf8');

    const result = applyMigrationHints([{
      type: 'removed_hook',
      event: 'SessionStart',
      command: 'node ~/yos/.claude/skills/yos-memory/scripts/session-start-inject.js',
      timeout: 10000,
    }], { yosDir });
    const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    assert.equal(result.applied, 1);
    assert.equal(updated.hooks, undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('step7 manifest deploy (real step7_syncInstructions)', () => {
  it('fails closed when the current YOS split marker is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-unsupported-'));
    const yosDir = path.join(tmpDir, 'yos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(yosDir, { recursive: true });
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), 'unsupported layout\n');

    const result = step7_syncInstructions({ tempDir: pkgRoot, yosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions: () => ({ active: false }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.error, /unsupported instruction layout/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the split-era step name when the new package has no templates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-no-templates-'));
    const result = step7_syncInstructions({ tempDir: tmpDir, yosDir: path.join(tmpDir, 'yos') });
    assert.equal(result.status, 'skipped');
    assert.equal(result.name, 'sync_instructions');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes both generated files when split mode is already active', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-active-'));
    const yosDir = path.join(tmpDir, 'yos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'YOS.md'), 'user seed\n');
    activateFreshSplitInstructions({
      yosDir,
      templatesDir: path.join(pkgRoot, 'templates'),
      assemblerSource: path.join(pkgRoot, 'cli', 'lib', 'runtime', 'assembler.mjs'),
    });
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'claude-system.md'), '# Claude system v2\n');
    fs.writeFileSync(path.join(pkgRoot, 'templates', 'codex-system.md'), '# Codex system v2\n');

    const result = step7_syncInstructions({ tempDir: pkgRoot, yosDir, packageRoot: pkgRoot });
    assert.equal(result.status, 'done');
    assert.match(result.message, /refreshed atomically/);
    assert.match(fs.readFileSync(path.join(yosDir, 'CLAUDE.md'), 'utf8'), /Claude system v2/);
    assert.match(fs.readFileSync(path.join(yosDir, 'AGENTS.md'), 'utf8'), /Codex system v2/);
    assert.ok(fs.existsSync(path.join(yosDir, '.yos', 'instructions', 'meta.json')));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns before all v2 instruction work for a future format version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-future-'));
    const yosDir = path.join(tmpDir, 'yos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(yosDir, '.yos', 'instructions'), { recursive: true });
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), 'future user bytes\n');
    fs.writeFileSync(path.join(yosDir, 'CLAUDE.md'), 'future claude bytes\n');
    fs.writeFileSync(path.join(yosDir, 'AGENTS.md'), 'future codex bytes\n');
    fs.writeFileSync(path.join(yosDir, '.yos', 'instructions', 'meta.json'), '{"version":99}\n');
    fs.writeFileSync(path.join(yosDir, '.yos', 'instructions', 'future.asset'), 'future asset bytes\n');
    fs.writeFileSync(path.join(yosDir, '.yos', 'instruction-format-version'), '3\n');
    const instructionFiles = [
      'YOS.md',
      'CLAUDE.md',
      'AGENTS.md',
      '.yos/instructions/meta.json',
      '.yos/instructions/future.asset',
      '.yos/instruction-format-version',
    ];
    const before = new Map(instructionFiles.map(file => [file, fs.readFileSync(path.join(yosDir, file))]));
    let refreshed = false;

    const result = step7_syncInstructions({ tempDir: pkgRoot, yosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions() { refreshed = true; throw new Error('must not run'); },
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /future instruction format version 3/);
    assert.equal(refreshed, false);
    for (const [file, bytes] of before) {
      assert.deepEqual(fs.readFileSync(path.join(yosDir, file)), bytes, file);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns before instruction refresh when a future format omits YOS.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-future-no-yos-'));
    const yosDir = path.join(tmpDir, 'yos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    fs.writeFileSync(path.join(yosDir, 'CLAUDE.md'), 'future-owned instruction bytes\n');
    fs.writeFileSync(path.join(yosDir, '.yos', 'instruction-format-version'), '3\n');
    const before = fs.readFileSync(path.join(yosDir, 'CLAUDE.md'));

    const result = step7_syncInstructions({ tempDir: pkgRoot, yosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions() { throw new Error('must not run'); },
    });

    assert.equal(result.status, 'done');
    assert.match(result.message, /future instruction format version 3/);
    assert.equal(fs.existsSync(path.join(yosDir, 'YOS.md')), false);
    assert.deepEqual(fs.readFileSync(path.join(yosDir, 'CLAUDE.md')), before);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills the format version for active split instructions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-backfill-'));
    const yosDir = path.join(tmpDir, 'yos');
    const pkgRoot = path.join(tmpDir, 'pkg');
    writeSplitPackage(pkgRoot);
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), 'legacy\n');
    let versionWrites = 0;

    const result = step7_syncInstructions({ tempDir: pkgRoot, yosDir, packageRoot: pkgRoot }, {
      refreshSplitInstructions: () => ({ active: true }),
      writeInstructionFormatVersion: () => { versionWrites++; },
    });

    assert.equal(result.status, 'done');
    assert.equal(versionWrites, 1);
    assert.match(result.message, /backfilled to 2/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates manifest from tempDir template when missing, message includes manifest: created', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-'));
    const yosDir = path.join(tmpDir, 'yos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(templatesDir, 'runtime-env.manifest.example'), 'env TZ\n');
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), '# Core\n');

    const manifestDest = path.join(yosDir, '.yos', 'runtime-env.manifest');
    assert.ok(!fs.existsSync(manifestDest));

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      yosDir,
      packageRoot: path.join(tmpDir, 'no-fallback'),
    }, { refreshSplitInstructions: () => ({ active: true }) });

    assert.equal(result.step, 7);
    assert.equal(result.name, 'sync_instructions');
    assert.equal(result.status, 'done');
    assert.ok(result.message.includes('manifest: created'));
    assert.ok(fs.existsSync(manifestDest));
    assert.equal(fs.readFileSync(manifestDest, 'utf8'), 'env TZ\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not overwrite existing manifest, message includes manifest: exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-'));
    const yosDir = path.join(tmpDir, 'yos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(templatesDir, 'runtime-env.manifest.example'), 'env NEW\n');
    fs.writeFileSync(path.join(yosDir, '.yos', 'runtime-env.manifest'), 'env CUSTOM\n');
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), '# Core\n');

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      yosDir,
      packageRoot: path.join(tmpDir, 'no-fallback'),
    }, { refreshSplitInstructions: () => ({ active: true }) });

    assert.ok(result.message.includes('manifest: exists'));
    assert.equal(
      fs.readFileSync(path.join(yosDir, '.yos', 'runtime-env.manifest'), 'utf8'),
      'env CUSTOM\n',
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to packageRoot template when tempDir template is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-'));
    const yosDir = path.join(tmpDir, 'yos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    const pkgRoot = path.join(tmpDir, 'installed-pkg');
    const pkgTemplates = path.join(pkgRoot, 'templates');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.mkdirSync(pkgTemplates, { recursive: true });
    fs.writeFileSync(path.join(pkgTemplates, 'runtime-env.manifest.example'), 'env FALLBACK\n');
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), '# Core\n');

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      yosDir,
      packageRoot: pkgRoot,
    }, { refreshSplitInstructions: () => ({ active: true }) });

    assert.ok(result.message.includes('manifest: created'));
    const manifestDest = path.join(yosDir, '.yos', 'runtime-env.manifest');
    assert.ok(fs.existsSync(manifestDest));
    assert.equal(fs.readFileSync(manifestDest, 'utf8'), 'env FALLBACK\n');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports template_missing when both tempDir and packageRoot templates are absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-'));
    const yosDir = path.join(tmpDir, 'yos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(yosDir, 'YOS.md'), '# Core\n');

    const result = step7_syncInstructions({
      tempDir: path.join(tmpDir, 'pkg'),
      yosDir,
      packageRoot: path.join(tmpDir, 'no-such-pkg'),
    }, { refreshSplitInstructions: () => ({ active: true }) });

    assert.ok(result.message.includes('manifest: template_missing'));
    assert.ok(!fs.existsSync(path.join(yosDir, '.yos', 'runtime-env.manifest')));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('works end-to-end through runSelfUpgradeFinalize with real POST_INSTALL_STEPS', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-step7-'));
    const yosDir = path.join(tmpDir, 'yos');
    const templatesDir = path.join(tmpDir, 'pkg', 'templates');
    writeSplitPackage(path.join(tmpDir, 'pkg'));
    fs.writeFileSync(path.join(templatesDir, 'runtime-env.manifest.example'), 'env TZ\n');
    activateFreshSplitInstructions({
      yosDir,
      templatesDir,
      assemblerSource: path.join(tmpDir, 'pkg', 'cli', 'lib', 'runtime', 'assembler.mjs'),
    });

    const wrappedStep7 = (ctx) => step7_syncInstructions({ ...ctx, yosDir, packageRoot: path.join(tmpDir, 'no-fallback') });

    const result = runSelfUpgradeFinalize({
      schemaVersion: 2,
      tempDir: path.join(tmpDir, 'pkg'),
      from: '0.4.12',
      to: '0.4.13',
    }, { steps: [wrappedStep7] });

    assert.equal(result.success, true);
    const step7Result = result.steps.find(s => s.step === 7);
    assert.ok(step7Result);
    assert.ok(step7Result.message.includes('manifest: created'));
    assert.ok(step7Result.message.includes('refreshed atomically'));
    assert.ok(fs.existsSync(path.join(yosDir, '.yos', 'runtime-env.manifest')));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
