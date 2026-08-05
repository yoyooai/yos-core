/**
 * The distribution base is written in three places that cannot import each
 * other: cli/lib/dist-origin.js (the CLI), scripts/install.sh (runs before any
 * of the CLI exists) and skills/activity-monitor/scripts/upgrade-check.js (runs
 * from ~/yos/.claude/skills, detached from the installed package).
 *
 * These tests are the reason that duplication is safe: change one and the build
 * goes red. They also pin the properties of the installer that make a
 * GitHub-free install possible, so a later edit cannot quietly restore the old
 * behavior while everything still looks green.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DIST_BASE, DEFAULT_DIST_OWNERS, normalizeDistBase } from '../dist-origin.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const installSh = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
const upgradeCheck = fs.readFileSync(
  path.join(ROOT, 'skills', 'activity-monitor', 'scripts', 'upgrade-check.js'), 'utf8',
);

// Quote characters inside these patterns are written as \x22 / \x27 on purpose:
// scripts/test-policy.js counts test cases after a naive comment/string strip,
// and a literal quote inside a regex makes it lose track of the rest of the file.

/** Lines that actually run — comments describe history, they do not fetch. */
function executableLines(source) {
  return source
    .split('\n')
    .filter(line => !/^\s*(#|\/\/|\*|\/\*)/.test(line));
}

describe('distribution base parity', () => {
  it('agrees between the CLI, the installer and the upgrade check', () => {
    const fromInstaller = installSh.match(/YOS_DIST_BASE=\x22\$\{YOS_DIST_BASE-([^}\x22]+)\}\x22/);
    assert.ok(fromInstaller, 'scripts/install.sh must define a default YOS_DIST_BASE');
    assert.equal(fromInstaller[1], DEFAULT_DIST_BASE);

    const fromUpgradeCheck = upgradeCheck.match(/const DEFAULT_DIST_BASE = \x27([^\x27]+)\x27/);
    assert.ok(fromUpgradeCheck, 'upgrade-check.js must define DEFAULT_DIST_BASE');
    assert.equal(fromUpgradeCheck[1], DEFAULT_DIST_BASE);

    const owners = upgradeCheck.match(/const DEFAULT_DIST_OWNERS = \x27([^\x27]+)\x27/);
    assert.ok(owners, 'upgrade-check.js must define DEFAULT_DIST_OWNERS');
    assert.equal(owners[1], DEFAULT_DIST_OWNERS);
  });

  it('keeps an explicitly empty base meaningful in the installer', () => {
    // "${VAR-default}" (one dash) lets YOS_DIST_BASE="" disable the mirror;
    // "${VAR:-default}" would silently restore it and make the switch a lie.
    assert.match(installSh, /YOS_DIST_BASE=\x22\$\{YOS_DIST_BASE-/);
    assert.doesNotMatch(installSh, /YOS_DIST_BASE=\x22\$\{YOS_DIST_BASE:-/);
  });
});

describe('installer does not require GitHub', () => {
  it('resolves the release from the mirror before GitHub', () => {
    assert.match(installSh, /releases\/latest\.json/);
    const mirrorIndex = installSh.indexOf('releases/latest.json');
    const githubIndex = installSh.indexOf('api.github.com/repos/' + '${YOS_RELEASE_REPO}' + '/releases/latest');
    assert.ok(mirrorIndex > 0 && githubIndex > 0, 'both origins must be present');
    assert.ok(mirrorIndex < githubIndex, 'the mirror must be tried first');
  });

  it('reports an unresolvable release instead of dying silently', () => {
    // The previous installer assigned the tag inside a command substitution
    // under `set -e`: an unreachable GitHub killed it with no output and exit 7.
    assert.match(installSh, /resolve_latest_tag/);
    assert.doesNotMatch(installSh, /LATEST_TAG=\x22\$\(curl/);
    assert.match(installSh, /Could not resolve the latest YOS release/);
  });

  it('installs the packaged release from the mirror rather than cloning', () => {
    assert.match(installSh, /\/package\/yos-\$\{package_version\}\.tgz/);
    assert.match(installSh, /needs GitHub/);
  });

  it('bootstraps Node.js from a mirror with SHA-256 verification, not via nvm', () => {
    // nvm's installer lives on raw.githubusercontent and then clones from
    // GitHub, so it can never bootstrap a machine without GitHub access.
    const runnable = executableLines(installSh).join('\n');
    assert.doesNotMatch(runnable, /raw\.githubusercontent/);
    assert.doesNotMatch(runnable, /nvm/i);
    assert.match(installSh, /SHASUMS256\.txt/);
    assert.match(installSh, /SHA-256 verification failed/);
    assert.match(installSh, /NODE_MIRROR=\x22\$\{YOS_NODE_MIRROR:-https:\/\/[^\x22]+}\x22/);
  });

  it('validates the mirror URL it is handed', () => {
    assert.match(installSh, /validate_dist_base/);
    assert.match(installSh, /credential-free HTTPS URL/);
  });

  it('accepts the same loopback exception as the CLI', () => {
    // An acceptance run serves a copy of the mirror over http on loopback. The
    // installer used to reject that while the CLI accepted it, so a from-zero
    // acceptance install could not be performed at all.
    assert.equal(normalizeDistBase('http://127.0.0.1:8080/dist'), 'http://127.0.0.1:8080/dist');
    const validator = installSh.match(/validate_dist_base\(\) \{[^}]*\}/s);
    assert.ok(validator, 'scripts/install.sh must define validate_dist_base');
    assert.match(validator[0], /127\\\.0\\\.0\\\.1\|localhost/);
  });
});

describe('upgrade check does not require GitHub', () => {
  it('reads tags from the mirror before falling back to git', () => {
    // Compared over executable lines only: a comment mentioning ls-remote must
    // not decide whether the ordering is right.
    const runnable = executableLines(upgradeCheck).join('\n');
    const mirrorIndex = runnable.indexOf('/tags.json');
    const gitIndex = runnable.indexOf('ls-remote');
    assert.ok(mirrorIndex > 0 && gitIndex > 0);
    assert.ok(mirrorIndex < gitIndex, 'the mirror must be tried first');
    assert.match(runnable, /mirror miss for/);
  });
});

describe('a machine records where it was installed from', () => {
  it('records it even when init is skipped', () => {
    // --no-init is a documented option, so the recording cannot live only in
    // `yos init`: a machine installed that way would never learn where it came
    // from, and `yos upgrade --self` would stay dead on it forever.
    assert.match(installSh, /record_release_source\(\) \{/);
    const noInitBranch = installSh.slice(installSh.indexOf('Skipping yos init'));
    assert.match(noInitBranch.slice(0, 200), /record_release_source/);
    // Append-only: an operator's existing choice must survive a re-install.
    const recorder = installSh.slice(installSh.indexOf('record_release_source() {'));
    assert.match(recorder.slice(0, 600), /grep -q .\^YOS_RELEASE_REPO=/);
  });

  it('hands the resolved release repository to yos init', () => {
    // Without this, `yos upgrade --self` on a fresh machine answers
    // "YOS_RELEASE_REPO is not configured": a customer can install YOS and then
    // has no way to update it.
    const initCall = installSh.indexOf('Running yos init');
    const exportLine = installSh.indexOf('export YOS_RELEASE_REPO');
    assert.ok(exportLine > 0, 'scripts/install.sh must export YOS_RELEASE_REPO');
    assert.ok(exportLine > initCall, 'the export must be in the init step');
  });

  it('persists it from init rather than defaulting to our repository', () => {
    const initSource = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'init.js'), 'utf8');
    assert.match(initSource, /function recordReleaseSource\(\)/);
    assert.match(initSource, /writeEnvEntries\(\{ YOS_RELEASE_REPO: repo \}/);
    // A fork's machine must keep upgrading from the fork, so the value is
    // recorded from the environment, never hard-coded here.
    const recorder = initSource.slice(
      initSource.indexOf('function recordReleaseSource()'),
      initSource.indexOf('function recordReleaseSource()') + 700,
    );
    assert.doesNotMatch(recorder, /yoyooai/);
    assert.match(recorder, /process\.env\.YOS_RELEASE_REPO/);
    // Both init paths have to record it, fresh install and re-init alike:
    // one definition plus one call from each path.
    assert.equal([...initSource.matchAll(/recordReleaseSource\(\)/g)].length, 3);
  });
});
