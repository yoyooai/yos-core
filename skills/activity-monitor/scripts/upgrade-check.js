#!/usr/bin/env node
/**
 * Standalone upgrade check — spawned by activity-monitor to avoid blocking
 * the main loop. Checks yos-core and installed components for newer
 * versions on GitHub, then enqueues a C4 control notification if upgrades
 * are available.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { formatLocalTimestamp } from './local-time.js';

const YOS_DIR = process.env.YOS_DIR || path.join(os.homedir(), 'yos');
const MONITOR_DIR = path.join(YOS_DIR, 'activity-monitor');
const LOG_FILE = path.join(MONITOR_DIR, 'activity.log');
const COMPONENTS_JSON = path.join(YOS_DIR, '.yos', 'components.json');
/**
 * The release repository, from the environment or from the machine's own .env.
 *
 * The installer records it in ~/yos/.env, and this script is spawned by the
 * activity monitor with whatever environment PM2 happens to pass, so reading
 * only process.env silently disabled every core update check on a machine that
 * was in fact configured.
 */
function resolveCoreReleaseRepo() {
  const fromEnv = process.env.YOS_RELEASE_REPO?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(YOS_DIR, '.env'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      if (trimmed.slice(0, separator).trim() !== 'YOS_RELEASE_REPO') continue;
      return trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '') || null;
    }
  } catch { /* no .env on this machine */ }
  return null;
}

const CORE_RELEASE_REPO = resolveCoreReleaseRepo();
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Distribution mirror. This script runs from ~/yos/.claude/skills, detached
// from the installed package, so the default is repeated here rather than
// imported; test/dist-origin-parity.test.js fails if the two ever disagree.
const DEFAULT_DIST_BASE = 'https://dist.yoyooai.com';
const DEFAULT_DIST_OWNERS = 'yoyooai';
const DIST_BASE = String(process.env.YOS_DIST_BASE ?? DEFAULT_DIST_BASE).trim().replace(/\/+$/, '');
const DIST_OWNERS = String(process.env.YOS_DIST_OWNERS ?? DEFAULT_DIST_OWNERS)
  .split(',').map(owner => owner.trim()).filter(Boolean);

function isMirroredRepo(repo) {
  if (!GITHUB_REPO_PATTERN.test(String(repo || ''))) return false;
  if (DIST_OWNERS.includes('*')) return true;
  const owner = String(repo).split('/')[0].toLowerCase();
  return DIST_OWNERS.some(candidate => candidate.toLowerCase() === owner);
}

function resolveCommBridgeScript(fileName) {
  const prodPath = path.join(YOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', fileName);
  if (fs.existsSync(prodPath)) return prodPath;
  const devPath = path.join(import.meta.dirname, '..', '..', 'comm-bridge', 'scripts', fileName);
  if (fs.existsSync(devPath)) return devPath;
  return prodPath;
}

const C4_CONTROL_PATH = resolveCommBridgeScript('c4-control.js');

function log(message) {
  const timestamp = formatLocalTimestamp();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* best effort */ }
}

function sanitizeVersion(v) {
  return String(v || '').replace(/[^a-zA-Z0-9._\-]/g, '').slice(0, 32);
}

function compareSemver(a, b) {
  const [aBase, aPre] = a.split(/-(.+)/);
  const [bBase, bPre] = b.split(/-(.+)/);
  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (bParts[i] || 0) - (aParts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (!aPre && bPre) return -1;
  if (aPre && !bPre) return 1;
  return 0;
}

/**
 * Tag names from our distribution mirror, or null when it does not apply.
 * The periodic check must not be the one thing on the machine that still needs
 * GitHub: on a host that cannot reach it, `git ls-remote` below spends its full
 * timeout every few hours and reports every component as un-checkable.
 */
function mirrorTagNames(repo) {
  if (!DIST_BASE || !isMirroredRepo(repo)) return null;
  const url = `${DIST_BASE}/${repo}/tags.json`;
  try {
    const output = execFileSync('curl', ['-fsSL', url], {
      encoding: 'utf8', stdio: 'pipe', timeout: 15000,
    });
    const tags = JSON.parse(output);
    if (!Array.isArray(tags)) return null;
    return tags.map(tag => String(tag?.name || '')).filter(Boolean);
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().split('\n')[0] : err.message;
    log(`Upgrade check: mirror miss for ${repo} tags (${detail}) — falling back to GitHub`);
    return null;
  }
}

function getLatestTag(repo) {
  const mirrored = mirrorTagNames(repo);
  if (mirrored) {
    if (mirrored.length === 0) return { version: null, error: 'no tags' };
    return pickLatest(mirrored);
  }

  let output;
  try {
    output = execFileSync('git', [
      'ls-remote', '--tags', `https://github.com/${repo}.git`
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 }).trim();
  } catch (err) {
    const msg = err.stderr ? String(err.stderr).trim() : err.message;
    return { version: null, error: msg };
  }
  if (!output) return { version: null, error: 'no tags' };
  return pickLatest(output.split('\n'));
}

function pickLatest(lines) {
  const versions = lines
    .map(line => line.replace(/.*refs\/tags\//, '').replace(/\^{}$/, ''))
    .filter(name => /^v?\d+\.\d+\.\d+/.test(name))
    .map(name => name.replace(/^v/, ''))
    .filter((v, i, arr) => arr.indexOf(v) === i)  // deduplicate (annotated tags have ^{})
    .sort(compareSemver);
  if (versions.length === 0) return { version: null, error: 'no semver tags' };
  return { version: versions[0], error: null };
}

function runC4Control(args) {
  try {
    const output = execFileSync('node', [C4_CONTROL_PATH, ...args], {
      encoding: 'utf8', stdio: 'pipe'
    }).trim();
    return { ok: true, output };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { ok: false, output: stdout || stderr || err.message };
  }
}

function main() {
  const upgrades = [];
  let failures = 0;

  // Core updates are opt-in until an official YOS release repository is configured.
  if (!CORE_RELEASE_REPO) {
    log('Upgrade check: core check disabled (YOS_RELEASE_REPO is not configured)');
  } else if (!GITHUB_REPO_PATTERN.test(CORE_RELEASE_REPO)) {
    log('Upgrade check: invalid YOS_RELEASE_REPO (expected owner/repository)');
    failures++;
  } else {
    try {
      const coreVersion = execFileSync('yos', ['--version'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 5000
      }).trim();
      const result = getLatestTag(CORE_RELEASE_REPO);
      if (result.error) {
        log(`Upgrade check: failed to fetch YOS core tag (${result.error})`);
        failures++;
      } else if (result.version && compareSemver(coreVersion.replace(/^v/, ''), result.version) > 0) {
        upgrades.push(`YOS core ${sanitizeVersion(coreVersion)} → ${sanitizeVersion(result.version)}`);
      }
    } catch (err) {
      log(`Upgrade check: failed to check core version (${err.message})`);
      failures++;
    }
  }

  // Check installed components
  try {
    if (fs.existsSync(COMPONENTS_JSON)) {
      const components = JSON.parse(fs.readFileSync(COMPONENTS_JSON, 'utf8'));
      for (const [name, info] of Object.entries(components)) {
        if (!info.repo || !info.version) continue;
        const result = getLatestTag(info.repo);
        if (result.error) {
          log(`Upgrade check: failed to fetch ${name} tag (${result.error})`);
          failures++;
          continue;
        }
        if (result.version && compareSemver(String(info.version).replace(/^v/, ''), result.version) > 0) {
          upgrades.push(`${sanitizeVersion(name)} ${sanitizeVersion(info.version)} → ${sanitizeVersion(result.version)}`);
        }
      }
    }
  } catch (err) {
    log(`Upgrade check: failed to read components (${err.message})`);
    failures++;
  }

  if (upgrades.length === 0) {
    log(`Upgrade check: all components up to date${failures > 0 ? ` (${failures} check(s) failed)` : ''}`);
    return;
  }

  const content = `Component upgrades available: ${upgrades.join(', ')}. When the user next sends a message, mention these available upgrades and ask if they would like to upgrade.`;
  const result = runC4Control([
    'enqueue', '--content', content, '--priority', '3', '--no-ack-suffix'
  ]);

  if (result.ok) {
    const match = result.output.match(/control\s+(\d+)/i);
    log(`Upgrade check: ${upgrades.length} upgrade(s) found, notified via control id=${match?.[1] ?? '?'} — ${upgrades.join(', ')}`);
  } else {
    log(`Upgrade check: notification enqueue failed: ${result.output}`);
  }
}

main();
