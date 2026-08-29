import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { prepareSelfUpgrade } from '../self-upgrade.js';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

/**
 * A machine upgrading itself installs native dependencies twice: once in the
 * preflight copy, once into the live skills tree. Measured 2026-08-06 with
 * GitHub blackholed: the preflight ran `npm install` without the mirror host,
 * prebuild-install was refused at 127.0.0.1:443, node-gyp took over and died
 * for want of `make`, and the machine stayed on the old version. The install
 * path had this env; the upgrade path did not, so a customer could install
 * without GitHub but could never upgrade without it.
 */

const SOURCE = fs.readFileSync(new URL('../self-upgrade.js', import.meta.url), 'utf8');

describe('self-upgrade installs native dependencies from our mirror', () => {
  it('carries the prebuilt-binary host into the preflight npm install', () => {
    const tempDir = makeTempDir('yos-selfupg-env-');
    const skillDir = path.join(tempDir, 'skills', 'comm-bridge');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'package.json'),
      JSON.stringify({ name: 'comm-bridge', dependencies: { 'better-sqlite3': '^12.6.2' } }),
    );
    const preparationDir = makeTempDir('yos-selfupg-prep-');

    const calls = [];
    const result = prepareSelfUpgrade(
      { tempDir, preparationDir },
      {
        preparationDir,
        assertDiskSpace: () => {},
        assertNpmAvailable: () => {},
        packCandidate: () => path.join(preparationDir, 'candidate.tgz'),
        execFileSync: (_bin, args, options) => {
          calls.push({ args, env: options?.env });
          return '';
        },
      },
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(preparationDir, { recursive: true, force: true });

    assert.equal(result.status, 'done', result.error);
    const install = calls.find((c) => c.args.includes('install'));
    assert.ok(install, 'the preflight never ran npm install for the skill dependencies');
    assert.equal(
      install.env?.npm_config_better_sqlite3_binary_host,
      'https://dist.yoyooai.com/vendor/better-sqlite3',
      'the preflight npm install would go to GitHub for the prebuilt binary',
    );
  });

  it('leaves no npm install in this file running on a bare environment', () => {
    // The behavioural test above can only reach the preflight. This one covers
    // the other three call sites -- live skill deps, the global core install,
    // and the rollback reinstall -- so moving or adding one cannot quietly
    // reintroduce a GitHub-dependent install.
    const installCalls = [...SOURCE.matchAll(/execFile\(npmExecutable\(\),\s*\[[^\]]*'install'[^\]]*\][^;]*?\}\);/gs)];
    assert.ok(installCalls.length >= 4, `expected at least 4 npm install call sites, found ${installCalls.length}`);
    for (const [call] of installCalls) {
      assert.match(
        call,
        /env:\s*(npmInstallEnv\(\)|\{\s*\.\.\.npmInstallEnv\(\))/,
        `an npm install in self-upgrade.js does not pass npmInstallEnv():\n${call}`,
      );
    }
  });

  it('never leaves process.env alone as the env of an npm install', () => {
    assert.doesNotMatch(
      SOURCE,
      /execFile\(npmExecutable\(\),\s*\['install'[^;]*?env:\s*\{\s*\.\.\.process\.env/s,
      'an npm install passes process.env directly, which has no mirror host on a customer machine',
    );
  });
});
