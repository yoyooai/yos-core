/**
 * Isolated #717 self-upgrade seam.
 *
 * This drives the real old-launcher runSelfUpgrade() orchestration, the real
 * finalizer state serialization/restore APIs, real step 5 smart merge, and
 * the old launcher's printStep callback. The installed-finalizer boundary is
 * injected, as are npm and PM2 effects, so the host installation is never
 * touched.
 *
 * argv: <package-temp-dir> <success|json|later-failure|no-conflict>
 * stdout: one JSON object containing the result and captured launcher output
 */
import fs from 'node:fs';
import path from 'node:path';

const [tempDir, scenario] = process.argv.slice(2);
const yosDir = process.env.YOS_DIR;
if (!tempDir || !scenario || !yosDir) {
  throw new Error('Usage: run-self-upgrade-driver.mjs <tempDir> <scenario> with YOS_DIR');
}

const {
  createFinalizeState,
  rollbackSelf,
  runSelfUpgrade,
  runSelfUpgradeFinalize,
  step5_syncCoreSkills,
} = await import('../../cli/lib/self-upgrade.js');
const { printStep } = await import('../../cli/commands/component.js');

const transactionBackupDir = path.join(yosDir, 'transaction-backup');
const npmCommands = [];
const stoppedServices = [];
const launcherOutput = [];
const originalLog = console.log;
console.log = (...args) => launcherOutput.push(args.join(' '));

let result;
try {
  result = runSelfUpgrade({
    tempDir,
    newVersion: '0.5.4-test',
    mode: 'merge',
    onStep: scenario === 'json' ? undefined : printStep,
  }, {
    getCurrentVersion: () => ({ success: true, version: '0.5.3' }),
    prepareSelfUpgrade: (ctx) => {
      const preparedPackage = path.join(yosDir, 'prepared-yos.tgz');
      fs.writeFileSync(preparedPackage, 'prepared');
      ctx.preparedPackage = preparedPackage;
      npmCommands.push('npm pack --ignore-scripts --pack-destination <preflight>');
      return { step: 0, name: 'prepare_upgrade', status: 'done', message: 'prepared' };
    },
    step1: {
      yosDir,
      skillsDir: path.join(yosDir, '.claude', 'skills'),
      backupDir: transactionBackupDir,
      packCurrentCore: (_ctx, backupDir) => {
        const coreDir = path.join(backupDir, 'core');
        fs.mkdirSync(coreDir, { recursive: true });
        const archive = path.join(coreDir, 'yos-old.tgz');
        fs.writeFileSync(archive, 'old core');
        return archive;
      },
    },
    step3: {
      getSkillsServices: () => [{ name: 'fixture-service', status: 'online' }],
      stopService: (name) => stoppedServices.push(name),
    },
    step4: {
      execFileSync: (command, args) => {
        npmCommands.push([command, ...args].join(' '));
        return '';
      },
    },
    runInstalledFinalizer: (ctx) => {
      const steps = [
        (finalizerCtx) => step5_syncCoreSkills(finalizerCtx, { yosDir }),
      ];
      if (scenario === 'later-failure') {
        steps.push(() => ({
          step: 6,
          name: 'install_skill_dependencies',
          status: 'failed',
          error: 'injected later failure',
        }));
      }
      return runSelfUpgradeFinalize(createFinalizeState(ctx), {
        steps,
        rollbackSelf: (rollbackCtx) => rollbackSelf(rollbackCtx, {
          yosDir,
          skillsDir: path.join(yosDir, '.claude', 'skills'),
          ecosystemPath: path.join(yosDir, 'pm2', 'ecosystem.config.cjs'),
          installPreviousCore: () => {},
          getInstalledCoreVersion: () => ({ success: true, version: '0.5.3' }),
          restartManagedProcess: () => {},
          verifyServices: () => ({ success: true, offline: [] }),
        }),
      });
    },
  });
} finally {
  console.log = originalLog;
}

originalLog(JSON.stringify({
  result,
  launcherOutput,
  npmCommands,
  stoppedServices,
  transactionBackupDir,
}));
