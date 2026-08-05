/**
 * The prebuilt-binary mirror only helps if it is actually wired into the
 * `npm install` runs that compile native code, and only if it carries the
 * version and ABI those installs ask for. Both are invisible at runtime until
 * a customer machine without GitHub fails, so they are pinned here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { MIRRORED_NATIVE_PACKAGES } from '../npm-env.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Every place that runs `npm install` for code that may build native modules. */
const INSTALL_SITES = [
  'cli/commands/init.js',
  'cli/commands/add.js',
  'cli/lib/upgrade.js',
  'scripts/install-skill-deps.js',
];

/** Node major version → V8 module ABI, as used in prebuilt binary file names. */
const NODE_ABI = { 20: 115, 22: 127, 24: 137 };

describe('native prebuild wiring', () => {
  it('passes the mirrored environment to every npm install that can compile', () => {
    // Actual invocations only — help text that tells a human to run npm is not
    // a code path. `npm install -g` of a runtime CLI is excluded by call site,
    // not by pattern: those packages ship no native code.
    const INVOCATION = /exec(?:File)?Sync\(\s*'npm(?:'\s*,\s*\['install'| install)/g;
    for (const site of INSTALL_SITES) {
      const source = read(site);
      const installs = [...source.matchAll(INVOCATION)];
      assert.ok(installs.length > 0, `${site} should run npm install`);
      // One env per install call: a new install site added without it would
      // silently go back to asking GitHub for prebuilt binaries.
      const envUses = [...source.matchAll(/env: npmInstallEnv\(\)/g)].length;
      assert.equal(envUses, installs.length,
        `${site} runs ${installs.length} npm install(s) but wires ${envUses}`);
    }
  });

  it('mirrors the exact better-sqlite3 version the skills lock to', () => {
    const vendor = JSON.parse(read('scripts/dist-vendor.json'));
    for (const { package: name } of MIRRORED_NATIVE_PACKAGES) {
      const spec = vendor.prebuilds.find(entry => entry.package === name);
      assert.ok(spec, `scripts/dist-vendor.json must cover ${name}`);

      const lockedVersions = new Set();
      for (const skill of fs.readdirSync(path.join(ROOT, 'skills'))) {
        const lockPath = path.join(ROOT, 'skills', skill, 'package-lock.json');
        if (!fs.existsSync(lockPath)) continue;
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const entry = lock.packages?.[`node_modules/${name}`];
        if (entry?.version) lockedVersions.add(entry.version);
      }
      assert.ok(lockedVersions.size > 0, `no skill locks ${name}`);
      for (const version of lockedVersions) {
        assert.equal(spec.version, version,
          `mirror carries ${name} ${spec.version} but a skill locks ${version}`);
      }
    }
  });

  it('mirrors an ABI for the Node.js version the installer pins', () => {
    const installSh = read('scripts/install.sh');
    const pinned = installSh.match(/NODE_VERSION="\$\{YOS_NODE_VERSION:-(\d+)\./);
    assert.ok(pinned, 'scripts/install.sh must pin a Node.js version');
    const abi = NODE_ABI[Number(pinned[1])];
    assert.ok(abi, `no known ABI for Node ${pinned[1]} — extend NODE_ABI`);

    const minimum = installSh.match(/MIN_NODE_MAJOR=(\d+)/);
    assert.ok(minimum, 'scripts/install.sh must state a minimum Node.js major');

    const vendor = JSON.parse(read('scripts/dist-vendor.json'));
    for (const spec of vendor.prebuilds) {
      assert.ok(spec.abis.includes(abi),
        `${spec.package} is not mirrored for Node ${pinned[1]} (ABI ${abi})`);
      // An existing Node as old as the minimum is accepted by the installer,
      // so its ABI has to be on the mirror as well.
      const minimumAbi = NODE_ABI[Number(minimum[1])];
      assert.ok(minimumAbi && spec.abis.includes(minimumAbi),
        `${spec.package} is not mirrored for the minimum Node ${minimum[1]}`);
      assert.ok(spec.targets.some(target => target.platform === 'linux' && target.arch === 'x64'));
    }
  });
});
