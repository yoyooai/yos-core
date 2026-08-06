/**
 * PM2 and the Codex CLI are installed from npm, and PM2 runs *before* the
 * runtime. A single unreachable registry there ended `yos init` outright — the
 * runtime's own fallback never got a turn, so fixing the runtime alone left the
 * install dying one step earlier. These tests pin the shared registry chain.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, mock } from 'node:test';

const calls = { npm: [] };
const behavior = {
  npmOk: new Map(),     // registry key ('default' | url) → boolean
  binaryPresent: false,
};

mock.module('node:child_process', {
  namedExports: {
    execSync() {
      return Buffer.from('');
    },
    execFileSync(file, args, opts) {
      calls.npm.push({ file, args, opts });
      const registryArg = (args || []).find(a => String(a).startsWith('--registry='));
      const key = registryArg ? registryArg.slice('--registry='.length) : 'default';
      if (!behavior.npmOk.get(key)) throw new Error('npm failed');
      return Buffer.from('');
    },
    spawnSync() {
      return { stdout: '', stderr: '', status: 0 };
    },
  },
});

mock.module('../shell-utils.js', {
  namedExports: {
    commandExists() {
      return behavior.binaryPresent;
    },
  },
});

const {
  npmInstallSources,
  installGlobalPackageWithFallback,
  describeNpmInstallFailure,
  installCodex,
  planClaudeInstall,
  DEFAULT_NPM_MIRROR,
} = await import('../runtime-setup.js');

function reset() {
  calls.npm.length = 0;
  behavior.npmOk = new Map();
  behavior.binaryPresent = false;
}

describe('npmInstallSources', () => {
  it('offers the configured registry first and a mirror second', () => {
    const sources = npmInstallSources({});
    assert.equal(sources.length, 2);
    assert.equal(sources[0].registry, null);
    assert.equal(sources[1].registry, DEFAULT_NPM_MIRROR);
  });

  it('drops the mirror when YOS_NPM_REGISTRY is explicitly empty', () => {
    assert.deepEqual(npmInstallSources({ YOS_NPM_REGISTRY: '' }).map(s => s.registry), [null]);
  });

  it('uses a custom mirror when one is configured', () => {
    const sources = npmInstallSources({ YOS_NPM_REGISTRY: 'https://npm.internal.example.com' });
    assert.equal(sources[1].registry, 'https://npm.internal.example.com');
    assert.match(sources[1].label, /npm\.internal\.example\.com/);
  });

  it('is the single definition the runtime chain also uses', () => {
    // One registry list for every global install: a mirror added for PM2 is
    // automatically a mirror for the runtime.
    const env = { YOS_NPM_REGISTRY: 'https://npm.internal.example.com' };
    const fromSources = npmInstallSources(env).map(s => s.registry);
    const fromClaudePlan = planClaudeInstall(env).filter(s => s.kind === 'npm').map(s => s.registry);
    assert.deepEqual(fromClaudePlan, fromSources);
  });
});

describe('installGlobalPackageWithFallback', () => {
  it('does not reach for the mirror when the configured registry works', () => {
    reset();
    behavior.npmOk.set('default', true);
    behavior.binaryPresent = true;

    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, true);
    assert.equal(result.fellBack, false);
    assert.equal(calls.npm.length, 1);
  });

  it('falls back to the mirror when the configured registry cannot be reached', () => {
    reset();
    behavior.npmOk.set(DEFAULT_NPM_MIRROR, true);
    behavior.binaryPresent = true;

    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, true);
    assert.equal(result.fellBack, true);
    assert.ok(calls.npm[1].args.includes(`--registry=${DEFAULT_NPM_MIRROR}`));
  });

  it('keeps trying when a registry reports success but the command is still missing', () => {
    reset();
    behavior.npmOk.set('default', true);
    behavior.npmOk.set(DEFAULT_NPM_MIRROR, true);
    behavior.binaryPresent = false;

    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].installed, true);
    assert.equal(result.attempts[0].found, false);
  });

  it('reports failure naming every registry it tried', () => {
    reset();
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    assert.equal(result.ok, false);
    assert.equal(result.attempts.length, 2);
  });

  it('installs Codex through the same chain', () => {
    reset();
    behavior.npmOk.set(DEFAULT_NPM_MIRROR, true);
    behavior.binaryPresent = true;

    const result = installCodex();
    assert.equal(result.ok, true);
    assert.equal(result.fellBack, true);
    assert.ok(calls.npm[0].args.includes('@openai/codex'));
  });
});

describe('describeNpmInstallFailure', () => {
  it('offers a mirror route when nothing answered', () => {
    reset();
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    const lines = describeNpmInstallFailure('pm2', result).join('\n');
    assert.ok(lines.includes('npm install -g pm2'));
    assert.ok(lines.includes(DEFAULT_NPM_MIRROR));
  });

  it('separates a PATH problem from an unreachable registry', () => {
    reset();
    behavior.npmOk.set('default', true);
    behavior.npmOk.set(DEFAULT_NPM_MIRROR, true);
    const result = installGlobalPackageWithFallback('pm2', { binary: 'pm2' });
    const lines = describeNpmInstallFailure('pm2', result).join('\n');
    assert.match(lines, /still missing/);
  });
});

describe('global installs stay on the shared chain', () => {
  const cliRoot = path.join(import.meta.dirname, '..', '..');

  function commandFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) commandFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('no command file installs a global package on a single registry', () => {
    const bare = /\binstallGlobalPackage\s*\(/;
    const offenders = commandFiles(path.join(cliRoot, 'commands'))
      .filter(file => bare.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(cliRoot, file));
    assert.deepEqual(offenders, [], 'use installGlobalPackageWithFallback so the mirror applies');
  });

  it('yos init installs PM2 through the fallback helper', () => {
    const init = fs.readFileSync(path.join(cliRoot, 'commands', 'init.js'), 'utf8');
    assert.match(init, /installGlobalPackageWithFallback\('pm2'/);
  });
});
