import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIRRORED_NATIVE_PACKAGES, npmInstallEnv, resolvePrebuildBase } from '../npm-env.js';

describe('npm install environment for native dependencies', () => {
  it('points prebuild-install at our mirror by default', () => {
    // Without this, better-sqlite3 asks GitHub for its prebuilt binary; when
    // GitHub is unreachable it falls through to node-gyp, which needs Python
    // and therefore fails outright on a stock server. Measured 2026-08-05.
    const env = npmInstallEnv({});
    assert.equal(
      env.npm_config_better_sqlite3_binary_host,
      'https://yoyooai.com/dist/vendor/better-sqlite3',
    );
    assert.ok(!/github/i.test(env.npm_config_better_sqlite3_binary_host));
  });

  it('covers every package we mirror prebuilt binaries for', () => {
    assert.ok(MIRRORED_NATIVE_PACKAGES.length >= 1);
    const env = npmInstallEnv({});
    for (const { package: name, envVar } of MIRRORED_NATIVE_PACKAGES) {
      // prebuild-install derives the variable name from the package name; a
      // mismatch here silently does nothing at all.
      assert.equal(envVar, `npm_config_${name.replace(/[^a-zA-Z0-9]/g, '_')}_binary_host`);
      assert.equal(env[envVar], `https://yoyooai.com/dist/vendor/${name}`);
    }
  });

  it('never overrides a host the operator already chose', () => {
    const env = npmInstallEnv({ npm_config_better_sqlite3_binary_host: 'https://mine.example/bs3' });
    assert.equal(env.npm_config_better_sqlite3_binary_host, 'https://mine.example/bs3');
  });

  it('follows the distribution base and can be turned off', () => {
    assert.equal(
      npmInstallEnv({ YOS_DIST_BASE: 'https://mirror.example/d' }).npm_config_better_sqlite3_binary_host,
      'https://mirror.example/d/vendor/better-sqlite3',
    );
    assert.equal(resolvePrebuildBase({ YOS_PREBUILD_BASE: '' }), null);
    assert.equal(
      npmInstallEnv({ YOS_PREBUILD_BASE: '' }).npm_config_better_sqlite3_binary_host,
      undefined,
    );
    assert.equal(
      npmInstallEnv({ YOS_DIST_BASE: '' }).npm_config_better_sqlite3_binary_host,
      undefined,
    );
    assert.equal(
      npmInstallEnv({ YOS_PREBUILD_BASE: 'https://vendor.example/v/' }).npm_config_better_sqlite3_binary_host,
      'https://vendor.example/v/better-sqlite3',
    );
  });

  it('passes the surrounding environment through untouched', () => {
    const env = npmInstallEnv({ PATH: '/usr/bin', HOME: '/home/someone' });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/someone');
  });
});
