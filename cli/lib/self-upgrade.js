/**
 * Self-upgrade logic for yos-core itself.
 * Downloads new version via GitHub tarball, syncs Core Skills with
 * manifest-based preservation, and runs npm install -g from local path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { SKILLS_DIR, YOS_DIR, getYosConfig } from './config.js';
import { downloadArchive, downloadBranch } from './download.js';
import { generateManifest, saveMergeBaseline } from './manifest.js';
import { fetchRawFile, fetchLatestTag, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { getCommandHooks, hookScriptKey } from './hook-utils.js';
import { isCoreManaged } from './sync-settings-hooks.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { getAllowedTmpRoots } from './upgrade.js';
import {
  CURRENT_INSTRUCTION_FORMAT_VERSION,
  readInstructionFormatVersion,
  refreshSplitInstructions,
  writeInstructionFormatVersion,
} from './runtime/instruction-builder.js';
import { deployManifestTemplate } from './runtime/tmux-env.js';
import { writeCodexConfig } from './runtime-setup.js';
import { getCoreEcosystemPath, restartManagedProcess } from './pm2.js';
import { resolveReleaseRepo } from './release-source.js';

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Get current installed yos-core version from package.json.
 */
export function getCurrentVersion() {
  const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { success: true, version: pkg.version };
  } catch (err) {
    return { success: false, error: `Cannot read package.json: ${err.message}` };
  }
}

/**
 * Get latest yos-core version from GitHub.
 * Uses tag-based detection (unified with component upgrades).
 * Falls back to package.json on a branch when --branch is specified.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] - Branch to read from (reads package.json from branch)
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) tags
 */
function getLatestVersion({ branch, beta = false } = {}) {
  const releaseSource = resolveReleaseRepo();
  if (!releaseSource.success) return releaseSource;
  const repo = releaseSource.repo;

  // When --branch is specified, read package.json from that branch
  if (branch) {
    try {
      const content = fetchRawFile(repo, 'package.json', branch);
      const pkg = JSON.parse(content);
      return { success: true, version: pkg.version };
    } catch (err) {
      return { success: false, error: `Cannot fetch latest version: ${sanitizeError(err.message)}` };
    }
  }

  // Default: tag-based detection (unified with component upgrades)
  try {
    const tagVersion = fetchLatestTag(repo, { includePrerelease: beta });
    if (tagVersion) {
      return { success: true, version: tagVersion };
    }
    return { success: false, error: 'No release tags found' };
  } catch (err) {
    return { success: false, error: `Cannot fetch latest version: ${sanitizeError(err.message)}` };
  }
}

// ---------------------------------------------------------------------------
// Public: checkForCoreUpdates
// ---------------------------------------------------------------------------

/**
 * Check if yos-core has updates available.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] - Branch to compare against
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) versions
 * @returns {object} { success, hasUpdate, current, latest }
 */
export function checkForCoreUpdates({ branch, beta = false } = {}) {
  const current = getCurrentVersion();
  if (!current.success) {
    return { success: false, error: 'version_not_found', message: current.error };
  }

  const latest = getLatestVersion({ branch, beta });
  if (!latest.success) {
    // Release-source failures carry a machine token in `error` and the operator
    // facing text in `message`; every other failure keeps its text in `error`.
    // Surfacing `error` unconditionally printed tokens such as
    // `release_source_not_configured` to the user, telling them nothing about
    // what to set. Prefer `message` and fall back only when it is absent.
    return { success: false, error: 'remote_version_failed', message: latest.message ?? latest.error };
  }

  // Use semver comparison (not string inequality) to avoid suggesting downgrades.
  // compareSemverDesc(a, b) > 0 means b is higher than a.
  const hasUpdate = compareSemverDesc(current.version, latest.version) > 0;

  return {
    success: true,
    hasUpdate,
    current: current.version,
    latest: latest.version,
  };
}

// ---------------------------------------------------------------------------
// Public: downloadCoreToTemp
// ---------------------------------------------------------------------------

/**
 * Download a yos-core version to temp directory.
 *
 * @param {string} version
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
function getWritableTmpBase(prefix = 'yos-self-upgrade-probe-') {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, prefix));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    // System tmp unavailable — fallback to ~/tmp
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

export function downloadCoreToTemp(version, branch) {
  const releaseSource = resolveReleaseRepo();
  if (!releaseSource.success) {
    return { success: false, error: releaseSource.message };
  }
  const repo = releaseSource.repo;
  const base = getWritableTmpBase('yos-self-upgrade-probe-');
  const tempDir = fs.mkdtempSync(path.join(base, 'yos-self-upgrade-'));

  if (branch) {
    const branchResult = downloadBranch(repo, branch, tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: branchResult.error };
    }
    return { success: true, tempDir };
  }

  const result = downloadArchive(repo, version, tempDir);
  if (!result.success) {
    // Fallback: try downloading main branch (for pre-release versions without tags)
    const branchResult = downloadBranch(repo, 'main', tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: result.error };
    }
  }

  return { success: true, tempDir };
}

// ---------------------------------------------------------------------------
// Public: readChangelog
// ---------------------------------------------------------------------------

/**
 * Read CHANGELOG.md from a directory.
 */
export function readChangelog(dir) {
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  try {
    return fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core Skills sync
// ---------------------------------------------------------------------------

/**
 * Sync Core Skills from new version to SKILLS_DIR using smart merge.
 *
 * Strategy (per file):
 * - Local unmodified → overwrite with new version
 * - Local modified, new unchanged → keep local
 * - Both changed → try diff3 three-way merge; if conflict → overwrite + backup local
 * - New skill (not installed) → copy fresh
 *
 * No "preserve" — every file gets a definitive outcome.
 * Backup serves as safety net for conflict files.
 *
 * @param {string} newSkillsSrc - Path to skills/ in downloaded temp dir
 * @param {string} [backupBase] - Base directory for conflict backups
 * @param {object} [opts]
 * @param {string} [opts.mode] - 'merge' (default) or 'overwrite'
 * @returns {{ synced: string[], added: string[], merged: string[], deleted: string[], preserved: string[], conflicts: { skill: string, file: string, backupPath: string }[], errors: string[], pendingBaselines: { destDir: string, srcDir: string, manifest: object }[] }}
 */
export function syncCoreSkills(newSkillsSrc, backupBase, opts = {}) {
  const result = { synced: [], added: [], merged: [], deleted: [], preserved: [], conflicts: [], errors: [], pendingBaselines: [] };

  if (!fs.existsSync(newSkillsSrc)) {
    return result;
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const entries = fs.readdirSync(newSkillsSrc, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillName = entry.name;
    const srcDir = path.join(newSkillsSrc, skillName);
    const destDir = path.join(SKILLS_DIR, skillName);

    if (!fs.existsSync(destDir)) {
      // New skill — copy entirely and defer its baseline to the outer commit.
      // Manifest is generated from the SOURCE (authoritative package), never
      // from a destDir scan, so pre-existing local files are not absorbed
      // into the ownership record (issue #715).
      try {
        copyTree(srcDir, destDir);
        result.pendingBaselines.push({ destDir, srcDir, manifest: generateManifest(srcDir) });
        result.added.push(skillName);
      } catch (err) {
        result.errors.push(`${skillName}: ${err.message}`);
      }
      continue;
    }

    // Existing skill — smart merge
    try {
      const skillBackupDir = backupBase ? path.join(backupBase, skillName) : null;
      const mergeResult = smartSync(srcDir, destDir, {
        backupDir: skillBackupDir,
        mode: opts.mode,
      });

      // Aggregate results
      if (mergeResult.overwritten.length || mergeResult.added.length || mergeResult.deleted.length
          || mergeResult.preserved.length) {
        result.synced.push(skillName);
      }
      if (mergeResult.merged.length) {
        result.merged.push(...mergeResult.merged.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.deleted.length) {
        result.deleted.push(...mergeResult.deleted.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.preserved.length) {
        result.preserved.push(...mergeResult.preserved.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.conflicts.length) {
        for (const c of mergeResult.conflicts) {
          result.conflicts.push({ skill: skillName, file: c.file, backupPath: c.backupPath });
        }
      }
      if (mergeResult.errors.length) {
        result.errors.push(...mergeResult.errors.map(e => `${skillName}: ${e}`));
      } else {
        result.pendingBaselines.push({ destDir, srcDir, manifest: mergeResult.nextManifest });
      }

    } catch (err) {
      result.errors.push(`${skillName}: ${err.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * List all files in templates/ directory recursively.
 * Returns relative paths for Claude to compare with local structure.
 */
function listTemplateFiles(templatesDir) {
  const files = [];
  if (!templatesDir) return files;
  if (!fs.existsSync(templatesDir)) return files;

  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }

  walk(templatesDir);
  return files;
}

/**
 * Compare template settings.json hooks with installed settings.json.
 * Matches hooks by script path (not full command string) to detect:
 *  - missing_hook:  in template, not installed
 *  - modified_hook: same script path, different command or timeout
 *  - removed_hook:  in installed, not in template (core skills only)
 */
export function generateMigrationHints(templatesDir, deps = {}) {
  const hints = [];
  const yosDir = deps.yosDir ?? YOS_DIR;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;

  const templateSettingsPath = path.join(templatesDir, '.claude', 'settings.json');
  if (!existsSync(templateSettingsPath)) return hints;

  const installedSettingsPath = path.join(yosDir, '.claude', 'settings.json');

  let templateSettings, installedSettings;
  try {
    templateSettings = JSON.parse(readFileSync(templateSettingsPath, 'utf8'));
  } catch {
    return hints;
  }
  try {
    installedSettings = existsSync(installedSettingsPath)
      ? JSON.parse(readFileSync(installedSettingsPath, 'utf8'))
      : {};
  } catch {
    installedSettings = {};
  }

  const templateHooks = templateSettings.hooks || {};
  const installedHooks = installedSettings.hooks || {};

  // --- Forward pass: detect missing and modified hooks ---
  for (const [event, matchers] of Object.entries(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    const installedMatchers = Array.isArray(installedHooks[event]) ? installedHooks[event] : [];

    for (const matcher of matchers) {
      for (const templateCmd of getCommandHooks(matcher)) {
        const templateKey = hookScriptKey(templateCmd.command);

        // Find installed hook with the same script path
        let matched = null;
        for (const im of installedMatchers) {
          matched = getCommandHooks(im).find(
            h => hookScriptKey(h.command) === templateKey
          );
          if (matched) break;
        }

        if (!matched) {
          hints.push({
            type: 'missing_hook',
            event,
            hook: { ...templateCmd },
            matcher: matcher.matcher !== undefined ? matcher.matcher : null,
            // Keep flat fields for backward compatibility
            command: templateCmd.command,
            timeout: templateCmd.timeout,
          });
        } else if (matched.command !== templateCmd.command || matched.timeout !== templateCmd.timeout) {
          hints.push({
            type: 'modified_hook',
            event,
            hook: { ...templateCmd },
            command: templateCmd.command,
            timeout: templateCmd.timeout,
            oldCommand: matched.command,
            oldTimeout: matched.timeout,
          });
        }
      }
    }
  }

  // --- statusLine sync ---
  if (templateSettings.statusLine) {
    const tsl = JSON.stringify(templateSettings.statusLine);
    const isl = JSON.stringify(installedSettings.statusLine || null);
    if (tsl !== isl) {
      hints.push({
        type: 'statusLine',
        value: templateSettings.statusLine,
      });
    }
  } else if (installedSettings.statusLine) {
    // Template removed statusLine — generate removal hint
    hints.push({
      type: 'statusLine_remove',
    });
  }

  if (Object.hasOwn(templateSettings, 'model') && !Object.hasOwn(installedSettings, 'model')) {
    let model = templateSettings.model;
    const cfg = (deps.getConfig ?? getYosConfig)();
    if (model.includes('[1m]') && Object.hasOwn(cfg, 'new_session_threshold') && cfg.new_session_threshold > 30) {
      model = model.replace('[1m]', '');
    }
    hints.push({
      type: 'model_backfill',
      value: model,
    });
  }

  // Backfill boolean settings (autoMemoryEnabled, autoDreamEnabled)
  for (const key of ['autoMemoryEnabled', 'autoDreamEnabled']) {
    if (Object.hasOwn(templateSettings, key) && !Object.hasOwn(installedSettings, key)) {
      hints.push({
        type: 'setting_backfill',
        key,
        value: templateSettings[key],
      });
    }
  }

  // --- Reverse pass: detect removed hooks (core skills only) ---
  for (const [event, matchers] of Object.entries(installedHooks)) {
    if (!Array.isArray(matchers)) continue;
    const templateMatchers = Array.isArray(templateHooks[event]) ? templateHooks[event] : [];

    for (const matcher of matchers) {
      for (const installedCmd of getCommandHooks(matcher)) {
        if (!isCoreManaged(installedCmd)) continue;

        const installedKey = hookScriptKey(installedCmd.command);
        const foundInTemplate = templateMatchers.some(tm =>
          getCommandHooks(tm).some(
            h => hookScriptKey(h.command) === installedKey
          )
        );

        if (!foundInTemplate) {
          hints.push({
            type: 'removed_hook',
            event,
            command: installedCmd.command,
            timeout: installedCmd.timeout,
          });
        }
      }
    }
  }

  return hints;
}

// ---------------------------------------------------------------------------
// 13-step self-upgrade pipeline
// ---------------------------------------------------------------------------

const MIN_SELF_UPGRADE_FREE_BYTES = 512 * 1024 * 1024;

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function availableBytes(targetPath, fsApi = fs) {
  const stats = fsApi.statfsSync(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function assertSelfUpgradeDiskSpace(ctx, deps = {}) {
  const readAvailableBytes = deps.availableBytes ?? ((target) => availableBytes(target, deps.fs ?? fs));
  const freeBytes = readAvailableBytes(ctx.tempDir);
  if (!Number.isFinite(freeBytes) || freeBytes < MIN_SELF_UPGRADE_FREE_BYTES) {
    const freeMiB = Number.isFinite(freeBytes) ? Math.floor(freeBytes / 1024 / 1024) : 'unknown';
    throw new Error(`insufficient disk space for upgrade preparation (${freeMiB} MiB available; 512 MiB required)`);
  }
}

function assertSelfUpgradeNpmAvailable(deps = {}) {
  const execFile = deps.execFileSync ?? execFileSync;
  execFile(npmExecutable(), ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
}

function prepareSkillDependencies(ctx, deps = {}) {
  const fsApi = deps.fs ?? fs;
  const execFile = deps.execFileSync ?? execFileSync;
  const skillsSource = path.join(ctx.tempDir, 'skills');
  if (!fsApi.existsSync(skillsSource)) return;

  const preparationDir = ctx.preparationDir;
  const dependencyRoot = path.join(preparationDir, 'skill-dependencies');
  fsApi.mkdirSync(dependencyRoot, { recursive: true });

  for (const entry of fsApi.readdirSync(skillsSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDir = path.join(skillsSource, entry.name);
    const packagePath = path.join(sourceDir, 'package.json');
    if (!fsApi.existsSync(packagePath)) continue;

    const pkg = JSON.parse(fsApi.readFileSync(packagePath, 'utf8'));
    if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

    const targetDir = path.join(dependencyRoot, entry.name);
    fsApi.mkdirSync(targetDir, { recursive: true });
    fsApi.copyFileSync(packagePath, path.join(targetDir, 'package.json'));
    const lockPath = path.join(sourceDir, 'package-lock.json');
    if (fsApi.existsSync(lockPath)) {
      fsApi.copyFileSync(lockPath, path.join(targetDir, 'package-lock.json'));
    }
    execFile(npmExecutable(), ['install', '--omit=dev'], {
      cwd: targetDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  }
}

function packUpgradeCandidate(ctx, deps = {}) {
  const execFile = deps.execFileSync ?? execFileSync;
  const output = execFile(npmExecutable(), [
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    ctx.preparationDir,
  ], {
    cwd: ctx.tempDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
  const archiveName = path.basename(output.split('\n').at(-1));
  const archivePath = path.join(ctx.preparationDir, archiveName);
  if (!fs.existsSync(archivePath)) throw new Error('candidate package was not created');
  return archivePath;
}

function cleanupSelfUpgradePreparation(ctx, fsApi = fs) {
  if (!ctx.preparationDir) return;
  fsApi.rmSync(ctx.preparationDir, { recursive: true, force: true });
  ctx.preparationDir = null;
  ctx.preparedPackage = null;
}

export function prepareSelfUpgrade(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  try {
    if (!ctx.tempDir || !fsApi.existsSync(ctx.tempDir)) {
      throw new Error('Temp directory not available');
    }
    ctx.preparationDir = deps.preparationDir
      ?? fsApi.mkdtempSync(path.join(getWritableTmpBase('yos-core-preflight-probe-'), 'yos-core-preflight-'));
    (deps.assertDiskSpace ?? assertSelfUpgradeDiskSpace)(ctx, deps);
    (deps.assertNpmAvailable ?? assertSelfUpgradeNpmAvailable)(deps);
    (deps.prepareSkillDependencies ?? prepareSkillDependencies)(ctx, deps);
    ctx.preparedPackage = (deps.packCandidate ?? packUpgradeCandidate)(ctx, deps);
    return {
      step: 0,
      name: 'prepare_upgrade',
      status: 'done',
      message: 'candidate package and skill dependencies prepared',
      duration: Date.now() - startTime,
    };
  } catch (err) {
    cleanupSelfUpgradePreparation(ctx, fsApi);
    return {
      step: 0,
      name: 'prepare_upgrade',
      status: 'failed',
      error: err.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Create self-upgrade context.
 */
function createContext({ tempDir, newVersion, mode } = {}) {
  const coreDir = path.join(import.meta.dirname, '..', '..');

  return {
    coreDir,
    tempDir: tempDir || null,
    newVersion: newVersion || null,
    mode: mode || 'merge',
    // State tracking
    backupDir: null,
    previousCorePackage: null,
    preparationDir: null,
    preparedPackage: null,
    coreInstallAttempted: false,
    servicesStopped: [],
    servicesWereRunning: [],
    mergeConflicts: [],
    mergedFiles: [],
    // Results
    steps: [],
    from: null,
    to: null,
    success: false,
    error: null,
  };
}

/**
 * Step 1: backup Core Skills
 */
export function step1_backupCoreSkills(ctx, deps = {}) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = deps.backupDir
    ?? path.join(getWritableTmpBase('yos-core-backup-probe-'), `yos-core-backup-${timestamp}`);
  const yosDir = deps.yosDir ?? YOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const copyTreeFn = deps.copyTree ?? copyTree;
  const fsApi = deps.fs ?? fs;
  const packCurrentCoreFn = deps.packCurrentCore ?? packCurrentCore;

  try {
    fsApi.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    fsApi.chmodSync(backupDir, 0o700);
    // Record the transaction directory immediately so a partial backup remains
    // visible and recoverable if a later backup operation fails.
    ctx.backupDir = backupDir;

    // Backup the skills directory (include .yos manifests — needed for correct rollback)
    if (fsApi.existsSync(skillsDir)) {
      copyTreeFn(skillsDir, path.join(backupDir, 'skills'), { excludes: ['node_modules'] });
    }

    const ecosystemSrc = deps.ecosystemPath ?? path.join(yosDir, 'pm2', 'ecosystem.config.cjs');
    if (fsApi.existsSync(ecosystemSrc)) {
      const backupPm2Dir = path.join(backupDir, 'pm2');
      fsApi.mkdirSync(backupPm2Dir, { recursive: true });
      fsApi.copyFileSync(ecosystemSrc, path.join(backupPm2Dir, 'ecosystem.config.cjs'));
    }

    ctx.previousCorePackage = packCurrentCoreFn(ctx, backupDir, deps);

    return { step: 1, name: 'backup_core_skills', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 1, name: 'backup_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

function packCurrentCore(ctx, backupDir, deps = {}) {
  const fsApi = deps.fs ?? fs;
  const execFile = deps.execFileSync ?? execFileSync;
  const coreBackupDir = path.join(backupDir, 'core');
  fsApi.mkdirSync(coreBackupDir, { recursive: true });
  const output = execFile(npmExecutable(), [
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    coreBackupDir,
  ], {
    cwd: ctx.coreDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
  const archive = path.join(coreBackupDir, path.basename(output.split('\n').at(-1)));
  if (!fsApi.existsSync(archive)) throw new Error('previous core package backup was not created');
  return archive;
}

/**
 * Step 2: pre-upgrade hook (placeholder for future use)
 */
function step2_preUpgradeHook(ctx) {
  const startTime = Date.now();
  // No core pre-upgrade hook yet — reserved for future
  return { step: 2, name: 'pre_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
}

/**
 * Find PM2 services running from SKILLS_DIR by matching exec paths.
 * This catches ALL yos-managed services regardless of SKILL.md declarations.
 *
 * @returns {{ name: string, status: string }[]} PM2 processes whose scripts are under SKILLS_DIR
 */
function getSkillsServices(deps = {}) {
  const execSyncFn = deps.execSync ?? execSync;
  try {
    const output = execSyncFn('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const resolved = path.resolve(SKILLS_DIR);

    return processes
      .filter(proc => {
        const execPath = proc.pm2_env?.pm_exec_path || '';
        return execPath.startsWith(resolved + '/');
      })
      .map(proc => ({ name: proc.name, status: proc.pm2_env?.status }));
  } catch {
    return [];
  }
}

/**
 * Step 3: stop core services
 */
function step3_stopCoreServices(ctx, deps = {}) {
  const startTime = Date.now();
  const execSyncFn = deps.execSync ?? execSync;
  const getServices = deps.getSkillsServices ?? (() => getSkillsServices(deps));
  const stopService = deps.stopService ?? ((name) => {
    execSyncFn(`pm2 stop ${name} 2>/dev/null`, { stdio: 'pipe' });
  });

  // Find all PM2 services running from skills directory
  const services = getServices();
  const onlineServices = services.filter(s => s.status === 'online');

  if (services.length === 0) {
    return { step: 3, name: 'stop_core_services', status: 'skipped', message: 'no services found', duration: Date.now() - startTime };
  }

  if (onlineServices.length === 0) {
    return { step: 3, name: 'stop_core_services', status: 'done', message: 'none running', duration: Date.now() - startTime };
  }

  for (const svc of onlineServices) {
    ctx.servicesWereRunning.push(svc.name);
    try {
      stopService(svc.name);
      ctx.servicesStopped.push(svc.name);
    } catch {
      // Continue even if one service fails to stop
    }
  }

  const msg = ctx.servicesStopped.length > 0 ? ctx.servicesStopped.join(', ') : 'none running';
  return { step: 3, name: 'stop_core_services', status: 'done', message: msg, duration: Date.now() - startTime };
}

/**
 * Step 4: install the tarball prepared before services were stopped.
 */
function step4_npmInstallGlobal(ctx, deps = {}) {
  const startTime = Date.now();
  const execFile = deps.execFileSync ?? execFileSync;
  const fsApi = deps.fs ?? fs;

  if (!ctx.preparedPackage || !fsApi.existsSync(ctx.preparedPackage)) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: 'Prepared candidate package not available', duration: Date.now() - startTime };
  }

  try {
    ctx.coreInstallAttempted = true;
    persistRollbackState(ctx, deps);
    execFile(npmExecutable(), ['install', '-g', ctx.preparedPackage], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, YOS_SKIP_POSTINSTALL: '1' },  // Skip postinstall — we sync skills ourselves
      timeout: 120000,
    });
    return { step: 4, name: 'npm_install_global', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: err.stderr?.toString().trim() || err.message, duration: Date.now() - startTime };
  } finally {
    cleanupSelfUpgradePreparation(ctx, fsApi);
  }
}

function persistRollbackState(ctx, deps = {}) {
  if (!ctx.backupDir) throw new Error('transaction backup is unavailable');
  const fsApi = deps.fs ?? fs;
  const statePath = path.join(ctx.backupDir, 'rollback-state.json');
  const state = {
    schemaVersion: 1,
    backupDir: ctx.backupDir,
    previousCorePackage: ctx.previousCorePackage,
    coreInstallAttempted: ctx.coreInstallAttempted,
    servicesWereRunning: ctx.servicesWereRunning,
    from: ctx.from,
  };
  fsApi.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Step 5: sync Core Skills (smart merge — no preserve)
 */
export function step5_syncCoreSkills(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const yosDir = deps.yosDir ?? YOS_DIR;
  const syncCoreSkillsFn = deps.syncCoreSkills ?? syncCoreSkills;

  const newSkillsSrc = path.join(ctx.tempDir, 'skills');
  if (!fsApi.existsSync(newSkillsSrc)) {
    return { step: 5, name: 'sync_core_skills', status: 'skipped', message: 'no skills in new version', duration: Date.now() - startTime };
  }

  try {
    // Conflict backups are durable user-recovery artifacts. Keep them outside
    // the temporary transaction snapshot, which the non-JSON success path
    // removes after the upgrade commits.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictBackupDir = path.join(yosDir, '.backup', timestamp, 'conflicts');
    const syncResult = syncCoreSkillsFn(newSkillsSrc, conflictBackupDir, { mode: ctx.mode });

    const parts = [];
    if (syncResult.synced.length) parts.push(`${syncResult.synced.length} synced`);
    if (syncResult.added.length) parts.push(`${syncResult.added.length} added`);
    if (syncResult.merged.length) parts.push(`${syncResult.merged.length} merged`);
    if (syncResult.deleted.length) parts.push(`${syncResult.deleted.length} deleted`);
    if (syncResult.preserved.length) parts.push(`${syncResult.preserved.length} preserved`);
    if (syncResult.conflicts.length) parts.push(`${syncResult.conflicts.length} conflicts`);
    if (syncResult.errors.length) parts.push(`${syncResult.errors.length} errors`);
    const summary = parts.join(', ') || 'no changes';
    const conflictPaths = syncResult.conflicts.map(({ skill, file, backupPath }) =>
      `${skill}/${file} -> ${backupPath}`
    );
    const msg = conflictPaths.length > 0
      ? `${summary}; backups: ${conflictPaths.join('; ')}`
      : summary;

    // Store conflicts on ctx for the final result
    ctx.mergeConflicts = syncResult.conflicts;
    ctx.mergedFiles = syncResult.merged;
    ctx.pendingBaselines = syncResult.pendingBaselines;

    if (syncResult.errors.length > 0) {
      return { step: 5, name: 'sync_core_skills', status: 'failed', error: syncResult.errors.join('; '), duration: Date.now() - startTime };
    }

    return { step: 5, name: 'sync_core_skills', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 5, name: 'sync_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: install/update skill dependencies
 */
function step6_installSkillDeps(ctx) {
  const startTime = Date.now();
  const { installed, failed } = installSkillDependencies(SKILLS_DIR);

  const msg = `${installed} installed${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}`;
  if (failed.length > 0) {
    return { step: 6, name: 'install_skill_deps', status: 'failed', error: msg, duration: Date.now() - startTime };
  }
  return { step: 6, name: 'install_skill_deps', status: 'done', message: msg, duration: Date.now() - startTime };
}

function installSkillDependencies(skillsRoot, deps = {}) {
  const fsApi = deps.fs ?? fs;
  const execFile = deps.execFileSync ?? execFileSync;
  const entries = fsApi.readdirSync(skillsRoot, { withFileTypes: true });
  let installed = 0;
  const failed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fsApi.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fsApi.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

      execFile(npmExecutable(), ['install', '--omit=dev'], {
        cwd: skillDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      installed++;
    } catch {
      failed.push(entry.name);
    }
  }
  return { installed, failed };
}

function step7Result(startTime, { status = 'done', message, error }) {
  return {
    step: 7,
    name: 'sync_instructions',
    status,
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
    duration: Date.now() - startTime,
  };
}

/** Step 7: deploy runtime environment metadata and refresh current YOS instructions. */
export function step7_syncInstructions(ctx, deps = {}) {
  const startTime = Date.now();
  const yosDir = ctx.yosDir || YOS_DIR;
  const packageRoot = ctx.packageRoot || path.join(import.meta.dirname, '..', '..');

  const templateDir = path.join(ctx.tempDir, 'templates');
  if (!fs.existsSync(templateDir)) {
    return step7Result(startTime, { status: 'skipped', message: 'no templates in new version' });
  }

  // runtime-env.manifest — create from template if missing (upgrade path)
  // Try tempDir first, then fallback to installed package root
  let manifestSrc = path.join(templateDir, 'runtime-env.manifest.example');
  let manifestStatus = deployManifestTemplate(manifestSrc, yosDir);
  if (manifestStatus === 'template_missing') {
    manifestSrc = path.join(packageRoot, 'templates', 'runtime-env.manifest.example');
    manifestStatus = deployManifestTemplate(manifestSrc, yosDir);
  }
  const manifestNote = `; manifest: ${manifestStatus}`;

  const readVersion = deps.readInstructionFormatVersion ?? readInstructionFormatVersion;
  const versionState = readVersion({ yosDir });
  if (versionState.valid && versionState.version > CURRENT_INSTRUCTION_FORMAT_VERSION) {
    return step7Result(startTime, {
      message: `future instruction format version ${versionState.version}; current YOS release does not apply${manifestNote}`,
    });
  }

  let refreshResult;
  try {
    refreshResult = (deps.refreshSplitInstructions ?? refreshSplitInstructions)({
      yosDir,
      templatesDir: templateDir,
      assemblerSource: path.join(ctx.tempDir, 'cli', 'lib', 'runtime', 'assembler.mjs'),
    });
  } catch (err) {
    return step7Result(startTime, { status: 'failed', error: err.message + manifestNote });
  }

  if (!refreshResult.active) {
    return step7Result(startTime, {
      status: 'failed',
      error: `Unsupported instruction layout: current YOS split marker is missing${manifestNote}`,
    });
  }

  const notes = [];
  if (!versionState.valid) notes.push('invalid instruction format version replaced');
  if (versionState.version !== CURRENT_INSTRUCTION_FORMAT_VERSION) {
    try {
      (deps.writeInstructionFormatVersion ?? writeInstructionFormatVersion)({ yosDir });
      notes.push('instruction format version backfilled to 2');
    } catch (error) {
      (deps.warn ?? console.warn)(`Warning: could not backfill instruction format version: ${error.message}`);
      notes.push('instruction format version backfill pending');
    }
  }
  const suffix = notes.length ? `; ${notes.join('; ')}` : '';
  return step7Result(startTime, { message: `split instructions refreshed atomically${suffix}${manifestNote}` });
}

/**
 * Apply migration hints to installed settings.json.
 * Adds missing hooks, updates modified hooks, removes obsolete hooks.
 * Preserves user-added hooks (hooks not from core skills).
 *
 * @param {object[]} hints - Output from generateMigrationHints()
 * @returns {{ applied: number, errors: string[] }}
 */
export function applyMigrationHints(hints, deps = {}) {
  const result = { applied: 0, errors: [] };
  if (!hints || hints.length === 0) return result;

  const yosDir = deps.yosDir ?? YOS_DIR;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const settingsPath = path.join(yosDir, '.claude', 'settings.json');
  let settings;
  try {
    settings = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, 'utf8'))
      : {};
  } catch {
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};

  for (const hint of hints) {
    try {
      if (hint.type === 'missing_hook') {
        // Add the hook to the appropriate event
        if (!Array.isArray(settings.hooks[hint.event])) {
          settings.hooks[hint.event] = [];
        }

        // Use the full hook object from the hint (includes async, timeout, etc.)
        const hookObj = hint.hook
          ? { ...hint.hook }
          : { type: 'command', command: hint.command };
        if (!hint.hook && hint.timeout !== undefined) hookObj.timeout = hint.timeout;

        // Find or create a matcher group
        const matcherValue = hint.matcher !== undefined ? hint.matcher : null;
        let targetGroup = null;

        if (matcherValue !== null) {
          // Look for an existing group with this matcher
          targetGroup = settings.hooks[hint.event].find(
            g => g.matcher === matcherValue
          );
        }

        if (!targetGroup) {
          targetGroup = { hooks: [] };
          if (matcherValue !== null) targetGroup.matcher = matcherValue;
          settings.hooks[hint.event].push(targetGroup);
        }

        targetGroup.hooks.push(hookObj);
        result.applied++;

      } else if (hint.type === 'modified_hook') {
        // Find and update the hook by script path
        const matchers = settings.hooks[hint.event];
        if (!Array.isArray(matchers)) continue;

        const oldScriptKey = hookScriptKey(hint.oldCommand);
        let updated = false;

        for (const group of matchers) {
          if (!Array.isArray(group.hooks)) continue;
          for (let i = 0; i < group.hooks.length; i++) {
            const h = group.hooks[i];
            if (h.type === 'command' && hookScriptKey(h.command) === oldScriptKey) {
              // Update command and timeout
              group.hooks[i].command = hint.command;
              if (hint.timeout !== undefined) {
                group.hooks[i].timeout = hint.timeout;
              }
              updated = true;
              break;
            }
          }
          if (updated) break;
        }

        if (updated) result.applied++;

      } else if (hint.type === 'statusLine') {
        settings.statusLine = hint.value;
        result.applied++;

      } else if (hint.type === 'statusLine_remove') {
        if (settings.statusLine) {
          delete settings.statusLine;
          result.applied++;
        }

      } else if (hint.type === 'model_backfill') {
        if (!Object.hasOwn(settings, 'model')) {
          settings.model = hint.value;
          result.applied++;
        }

      } else if (hint.type === 'setting_backfill') {
        if (!Object.hasOwn(settings, hint.key)) {
          settings[hint.key] = hint.value;
          result.applied++;
        }

      } else if (hint.type === 'removed_hook') {
        // Remove the hook by script path
        const matchers = settings.hooks[hint.event];
        if (!Array.isArray(matchers)) continue;

        const scriptKey = hookScriptKey(hint.command);
        let removed = false;

        for (let gi = matchers.length - 1; gi >= 0; gi--) {
          const group = matchers[gi];
          if (!Array.isArray(group.hooks)) continue;

          group.hooks = group.hooks.filter(h => {
            if (h.type === 'command' && hookScriptKey(h.command) === scriptKey) {
              removed = true;
              return false;
            }
            return true;
          });

          // Remove empty groups
          if (group.hooks.length === 0) {
            matchers.splice(gi, 1);
          }
        }

        // Clean up empty event arrays
        if (matchers.length === 0) {
          delete settings.hooks[hint.event];
        }

        if (removed) result.applied++;
      }
    } catch (err) {
      result.errors.push(`${hint.type}/${hint.event}: ${err.message}`);
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  // Write back
  const dir = path.dirname(settingsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  return result;
}

/**
 * Step 8: migrate state.md for existing users.
 *
 * If state.md exists but has no Onboarding section, this is an existing user
 * upgrading. Add `onboarding: skipped` so the onboarding flow is not triggered.
 * New installs already have `Status: pending` from the template.
 */
function step8_migrateStateMd() {
  const startTime = Date.now();
  const statePath = path.join(YOS_DIR, 'memory', 'state.md');

  if (!fs.existsSync(statePath)) {
    return { step: 8, name: 'migrate_state_md', status: 'skipped', message: 'state.md not found', duration: Date.now() - startTime };
  }

  try {
    const content = fs.readFileSync(statePath, 'utf8');

    // Already has onboarding section — nothing to do
    if (/## Onboarding/i.test(content)) {
      return { step: 8, name: 'migrate_state_md', status: 'skipped', message: 'onboarding section exists', duration: Date.now() - startTime };
    }

    // Existing user without onboarding — add skipped status
    const section = '\n\n## Onboarding\n- Status: skipped\n';
    fs.writeFileSync(statePath, content.trimEnd() + section);

    return { step: 8, name: 'migrate_state_md', status: 'done', message: 'added onboarding: skipped', duration: Date.now() - startTime };
  } catch (err) {
    // Non-fatal
    return { step: 8, name: 'migrate_state_md', status: 'skipped', message: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 9: sync settings.json hooks from template and refresh upgrade-safe
 * config backfills via the newly installed package.
 *
 * Shells out to the NEWLY INSTALLED sync-settings-hooks.js instead of using
 * the in-memory generateMigrationHints(). This avoids bootstrap problems where
 * the old version's sync logic misses new config fields or backfills
 * (e.g. statusLine, Codex config refreshes).
 */
function step9_syncSettingsHooks(ctx) {
  const startTime = Date.now();

  // Resolve the newly installed package path (from step 4) to use the latest sync logic.
  const syncScript = resolveInstalledSyncScript();

  if (!syncScript) {
    // Fallback to in-memory hints if new script not found
    const templatesDir = path.join(ctx.tempDir, 'templates');
    const hints = generateMigrationHints(templatesDir);
    if (hints.length === 0) {
      return { step: 9, name: 'sync_settings_hooks', status: 'done', message: 'no changes needed', duration: Date.now() - startTime };
    }
    const result = applyMigrationHints(hints);
    if (result.errors.length > 0) {
      return { step: 9, name: 'sync_settings_hooks', status: 'failed', error: result.errors.join('; '), duration: Date.now() - startTime };
    }
    return { step: 9, name: 'sync_settings_hooks', status: 'done', message: `${result.applied} hooks updated`, duration: Date.now() - startTime };
  }

  try {
    const output = execSync(`node "${syncScript}"`, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }).trim();
    // Extract last line as the summary (script outputs per-hook details before summary)
    const lines = output.split('\n').filter(l => l.trim());
    const summary = lines.length > 0 ? lines[lines.length - 1].trim() : 'no changes';
    return { step: 9, name: 'sync_settings_hooks', status: 'done', message: summary, duration: Date.now() - startTime };
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
    return { step: 9, name: 'sync_settings_hooks', status: 'failed', error: errMsg, duration: Date.now() - startTime };
  }
}

/**
 * Resolve the path to sync-settings-hooks.js in the globally installed package.
 * Reads the package name from package.json to avoid hardcoding.
 * @returns {string|null} Absolute path to the script, or null if not found.
 */
function resolveInstalledSyncScript() {
  return resolveInstalledPackageScript('cli', 'lib', 'sync-settings-hooks.js');
}

/**
 * Resolve a script path in the globally installed package.
 * Reads the package name from package.json to avoid hardcoding.
 * @returns {string|null} Absolute path to the script, or null if not found.
 */
function resolveInstalledPackageScript(...parts) {
  try {
    // import.meta.dirname points to cli/lib/, go up two levels to package root
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pkgName = pkg.name || 'yos';
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
    const script = path.join(npmRoot, pkgName, ...parts);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Step 10: ensure Codex config is current for existing Codex-capable installs.
 *
 * Fresh install/init and `yos runtime codex` already call writeCodexConfig().
 * This upgrade-time step covers existing deployments so newly required config
 * keys (for example [features].multi_agent) are backfilled during self-upgrade.
 */
export function step10_ensureCodexConfig(deps = {}) {
  const startTime = Date.now();
  const cfg = deps.cfg ?? getYosConfig();
  const codexDir = deps.codexDir ?? path.join(os.homedir(), '.codex');
  const writeConfig = deps.writeConfig ?? writeCodexConfig;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const hasCodexState = existsSync(path.join(codexDir, 'config.toml'))
    || existsSync(path.join(codexDir, 'auth.json'));

  if (cfg.runtime !== 'codex' && !hasCodexState) {
    return { step: 10, name: 'ensure_codex_config', status: 'skipped', message: 'codex not in use', duration: Date.now() - startTime };
  }

  if (!writeConfig(YOS_DIR)) {
    if (cfg.runtime !== 'codex') {
      return {
        step: 10,
        name: 'ensure_codex_config',
        status: 'skipped',
        message: 'warning: failed to refresh codex config outside codex runtime',
        duration: Date.now() - startTime
      };
    }
    return { step: 10, name: 'ensure_codex_config', status: 'failed', error: 'failed to write codex config', duration: Date.now() - startTime };
  }

  return { step: 10, name: 'ensure_codex_config', status: 'done', message: 'updated codex config (project + global)', duration: Date.now() - startTime };
}

/**
 * Step 11: start core services
 */
export function step11_startCoreServices(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const restartFn = deps.restartManagedProcess ?? restartManagedProcess;
  const exec = deps.execSync ?? execSync;
  const yosDir = deps.yosDir ?? YOS_DIR;

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 11, name: 'start_core_services', status: 'skipped', message: 'no services to restart', duration: Date.now() - startTime };
  }

  // Deploy the new ecosystem.config.cjs from the upgraded package so PM2
  // re-evaluates env vars (e.g. YOS_PACKAGE_ROOT) when services restart.
  // `pm2 restart <name>` reuses PM2's cached config and never picks up new env.
  let ecosystemPath = null;
  const ecosystemTemplateSrc = ctx.tempDir
    ? path.join(ctx.tempDir, 'templates', 'pm2', 'ecosystem.config.cjs')
    : null;
  const pm2Dir = path.join(yosDir, 'pm2');
  const ecosystemDest = deps.ecosystemPath ?? getCoreEcosystemPath();
  if (ecosystemTemplateSrc && fsApi.existsSync(ecosystemTemplateSrc)) {
    try {
      fsApi.mkdirSync(pm2Dir, { recursive: true });
      fsApi.copyFileSync(ecosystemTemplateSrc, ecosystemDest);
      ecosystemPath = ecosystemDest;
    } catch {
      // Non-fatal — if copy fails, we can still use an already-deployed ecosystem file below.
    }
  } else if (fsApi.existsSync(ecosystemDest)) {
    // No new template available; use the existing ecosystem file
    ecosystemPath = ecosystemDest;
  }
  ecosystemPath = ecosystemPath ?? ecosystemDest;

  const started = [];
  const failed = [];

  for (const name of ctx.servicesWereRunning) {
    try {
      restartFn(name, {
        ecosystemPath,
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      });
      started.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    return { step: 11, name: 'start_core_services', status: 'failed', error: `Failed to restart: ${failed.join(', ')}`, duration: Date.now() - startTime };
  }

  if (started.includes('activity-monitor')) {
    const verifyActivityMonitorEnv = deps.verifyActivityMonitorEnv ?? (() => {
      const output = exec('pm2 jlist 2>/dev/null', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const processes = JSON.parse(String(output));
      const activityMonitor = processes.find(process => process.name === 'activity-monitor');
      return Boolean(activityMonitor?.pm2_env?.YOS_PACKAGE_ROOT);
    });

    try {
      if (!verifyActivityMonitorEnv()) {
        return { step: 11, name: 'start_core_services', status: 'failed', error: 'activity-monitor PM2 env missing YOS_PACKAGE_ROOT after restart', duration: Date.now() - startTime };
      }
    } catch (err) {
      const detail = err?.message ? `: ${err.message}` : '';
      return { step: 11, name: 'start_core_services', status: 'failed', error: `failed to verify activity-monitor PM2 env after restart${detail}`, duration: Date.now() - startTime };
    }
  }

  try {
    exec('pm2 save 2>/dev/null', { stdio: 'pipe' });
  } catch {
    return { step: 11, name: 'start_core_services', status: 'failed', error: 'failed to save PM2 process list after core restart', duration: Date.now() - startTime };
  }

  return { step: 11, name: 'start_core_services', status: 'done', message: started.join(', '), duration: Date.now() - startTime };
}

/**
 * Step 12: verify services
 *
 * Polls up to 30 seconds (every 2 s) for all services to come online.
 * Some services (e.g. component bots) take longer than 2 s to start after
 * PM2 restarts them — a one-shot check caused spurious rollbacks.
 */
function step12_verifyServices(ctx) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 12, name: 'verify_services', status: 'skipped', message: 'no services to verify', duration: Date.now() - startTime };
  }

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS = 30000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    try { execSync('sleep 2', { stdio: 'pipe' }); } catch { /* ignore */ }

    try {
      const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const processes = JSON.parse(output);

      const notOnline = ctx.servicesWereRunning.filter(name => {
        const proc = processes.find(p => p.name === name);
        return !proc || proc.pm2_env?.status !== 'online';
      });

      if (notOnline.length === 0) {
        return { step: 12, name: 'verify_services', status: 'done', duration: Date.now() - startTime };
      }

      // If we still have time, keep polling
      if (Date.now() - startTime + POLL_INTERVAL_MS >= TIMEOUT_MS) {
        return { step: 12, name: 'verify_services', status: 'failed', error: `Not online after ${TIMEOUT_MS / 1000}s: ${notOnline.join(', ')}`, duration: Date.now() - startTime };
      }
    } catch (err) {
      return { step: 12, name: 'verify_services', status: 'failed', error: err.message, duration: Date.now() - startTime };
    }
  }

  // Timed out
  return { step: 12, name: 'verify_services', status: 'failed', error: `Timed out after ${TIMEOUT_MS / 1000}s`, duration: Date.now() - startTime };
}

/** Commit every Core Skill baseline after the complete self-upgrade succeeds. */
function step13_commitSkillBaselines(ctx) {
  const startTime = Date.now();
  try {
    for (const baseline of ctx.pendingBaselines || []) {
      saveMergeBaseline(baseline.destDir, baseline.srcDir, baseline.manifest);
    }
    return {
      step: 13,
      name: 'commit_skill_baselines',
      status: 'done',
      message: `${(ctx.pendingBaselines || []).length} committed`,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return { step: 13, name: 'commit_skill_baselines', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

function snapshotRollbackTree(root, fsApi = fs) {
  const snapshot = {};

  function walk(directory, relativeDirectory = '') {
    const entries = fsApi.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.name !== 'node_modules')
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stat = fsApi.lstatSync(absolutePath);

      if (stat.isDirectory()) {
        snapshot[relativePath] = 'directory';
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const digest = crypto.createHash('sha256').update(fsApi.readFileSync(absolutePath)).digest('hex');
        snapshot[relativePath] = `file:${digest}`;
      } else if (stat.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${fsApi.readlinkSync(absolutePath)}`;
      } else {
        snapshot[relativePath] = 'unsupported';
      }
    }
  }

  walk(root);
  return snapshot;
}

function coreSkillTreesMatch(backupSkillsDir, skillsDir, deps = {}) {
  const snapshot = deps.snapshotRollbackTree ?? ((root) => snapshotRollbackTree(root, deps.fs ?? fs));
  return JSON.stringify(snapshot(backupSkillsDir)) === JSON.stringify(snapshot(skillsDir));
}

/**
 * Rollback from backup.
 */
export function rollbackSelf(ctx, deps = {}) {
  const results = [];
  const fsApi = deps.fs ?? fs;
  const syncTreeFn = deps.syncTree ?? syncTree;
  const restartFn = deps.restartManagedProcess ?? restartManagedProcess;
  const yosDir = deps.yosDir ?? YOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const ecosystemPath = deps.ecosystemPath ?? getCoreEcosystemPath();

  if (ctx.coreInstallAttempted || ctx.previousCorePackage) {
    if (!ctx.previousCorePackage) {
      results.push({ action: 'restore_previous_core', success: false, error: 'previous core package backup is missing' });
    } else {
      try {
        const installPreviousCoreFn = deps.installPreviousCore ?? installPreviousCore;
        installPreviousCoreFn(ctx.previousCorePackage, deps);
        results.push({ action: 'restore_previous_core', success: true });
      } catch (err) {
        results.push({ action: 'restore_previous_core', success: false, error: err.message });
      }
    }
  }

  // Restore Core Skills from backup (include .yos manifests to keep them in sync with files)
  if (ctx.backupDir && fsApi.existsSync(path.join(ctx.backupDir, 'skills'))) {
    try {
      const backupSkillsDir = path.join(ctx.backupDir, 'skills');
      syncTreeFn(backupSkillsDir, skillsDir, { excludes: ['node_modules'] });
      const verifyCoreSkillsFn = deps.verifyCoreSkills
        ?? ((source, target) => coreSkillTreesMatch(source, target, { ...deps, fs: fsApi }));
      if (!verifyCoreSkillsFn(backupSkillsDir, skillsDir)) {
        throw new Error('restored Core Skills do not match the transaction backup');
      }
      results.push({ action: 'restore_core_skills', success: true });
    } catch (err) {
      results.push({ action: 'restore_core_skills', success: false, error: err.message });
    }
  }

  try {
    const restoreSkillDependenciesFn = deps.restoreSkillDependencies ?? installSkillDependencies;
    const dependencyResult = restoreSkillDependenciesFn(skillsDir, deps);
    if (dependencyResult.failed?.length) {
      results.push({
        action: 'restore_skill_dependencies',
        success: false,
        error: `failed skills: ${dependencyResult.failed.join(', ')}`,
      });
    } else {
      results.push({ action: 'restore_skill_dependencies', success: true });
    }
  } catch (err) {
    results.push({ action: 'restore_skill_dependencies', success: false, error: err.message });
  }

  if (ctx.backupDir) {
    const backupEcosystem = path.join(ctx.backupDir, 'pm2', 'ecosystem.config.cjs');
    if (fsApi.existsSync(backupEcosystem)) {
      try {
        fsApi.mkdirSync(path.dirname(ecosystemPath), { recursive: true });
        fsApi.copyFileSync(backupEcosystem, ecosystemPath);
        results.push({ action: 'restore_pm2_ecosystem', success: true });
      } catch (err) {
        results.push({ action: 'restore_pm2_ecosystem', success: false, error: err.message });
      }
    }
  }

  // Restart services if they were running
  for (const name of ctx.servicesWereRunning) {
    try {
      restartFn(name, {
        ecosystemPath,
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      });
      results.push({ action: `restart_${name}`, success: true });
    } catch (err) {
      results.push({ action: `restart_${name}`, success: false, error: err.message });
    }
  }

  if (ctx.servicesWereRunning.length > 0) {
    try {
      const verifyServicesFn = deps.verifyServices ?? verifyServicesOnline;
      const verification = verifyServicesFn(ctx.servicesWereRunning, deps);
      if (!verification.success) {
        results.push({
          action: 'verify_restored_services',
          success: false,
          error: `services not online: ${(verification.offline || []).join(', ')}`,
        });
      } else {
        results.push({ action: 'verify_restored_services', success: true });
      }
    } catch (err) {
      results.push({ action: 'verify_restored_services', success: false, error: err.message });
    }
  }

  if (ctx.coreInstallAttempted || ctx.previousCorePackage) {
    const expectedVersion = ctx.from || null;
    const getInstalledCoreVersionFn = deps.getInstalledCoreVersion ?? getCurrentVersion;
    const installed = getInstalledCoreVersionFn();
    const actualVersion = installed?.success ? installed.version : null;

    if (expectedVersion && actualVersion === expectedVersion) {
      results.push({
        action: 'verify_restored_core_version',
        success: true,
        expectedVersion,
        actualVersion,
      });
    } else {
      const error = expectedVersion && actualVersion
        ? `installed core version ${actualVersion} does not match expected ${expectedVersion}`
        : 'installed core version could not be verified against the previous version';
      results.push({
        action: 'verify_restored_core_version',
        success: false,
        expectedVersion,
        actualVersion,
        error,
      });
    }
  }

  return results;
}

function installPreviousCore(archivePath, deps = {}) {
  const execFile = deps.execFileSync ?? execFileSync;
  execFile(npmExecutable(), ['install', '-g', archivePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, YOS_SKIP_POSTINSTALL: '1' },
    timeout: 120000,
  });
}

function verifyServicesOnline(serviceNames, deps = {}) {
  const exec = deps.execSync ?? execSync;
  const sleep = deps.sleep ?? (() => {
    try { exec('sleep 2', { stdio: 'pipe' }); } catch { /* polling continues */ }
  });
  const timeoutMs = deps.verifyTimeoutMs ?? 30000;
  const startedAt = Date.now();
  let offline = [...serviceNames];

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const processes = JSON.parse(exec('pm2 jlist 2>/dev/null', { encoding: 'utf8', stdio: 'pipe' }));
      offline = serviceNames.filter(name => {
        const process = processes.find(candidate => candidate.name === name);
        return !process || process.pm2_env?.status !== 'online';
      });
      if (offline.length === 0) return { success: true, offline: [] };
    } catch {
      offline = [...serviceNames];
    }
    sleep();
  }
  return { success: false, offline };
}

export function recoverSelfUpgrade(backupDir, deps = {}) {
  const fsApi = deps.fs ?? fs;
  try {
    if (!backupDir || !fsApi.existsSync(backupDir)) {
      return { action: 'self_upgrade_recovery', success: false, error: 'invalid_recovery_backup' };
    }
    const resolved = fsApi.realpathSync(backupDir);
    const allowedRoots = (deps.allowedTmpRoots ?? getAllowedTmpRoots()).map(root => {
      try { return fsApi.realpathSync(root); } catch { return path.resolve(root); }
    });
    const underAllowedRoot = allowedRoots.some(root => resolved.startsWith(`${root}${path.sep}`));
    if (!underAllowedRoot || !path.basename(resolved).startsWith('yos-core-backup-')) {
      return { action: 'self_upgrade_recovery', success: false, error: 'invalid_recovery_backup' };
    }

    const statePath = path.join(resolved, 'rollback-state.json');
    if (!fsApi.existsSync(statePath)) {
      return { action: 'self_upgrade_recovery', success: false, error: 'recovery_state_missing' };
    }
    const state = JSON.parse(fsApi.readFileSync(statePath, 'utf8'));
    let stateBackupDir = '';
    try { stateBackupDir = fsApi.realpathSync(state.backupDir || ''); } catch { /* invalid below */ }
    // Compare lexical paths under the already-canonicalized state backup. The
    // archive may be missing (which rollback must report), so realpath cannot
    // be required for the archive itself. This also handles /var -> /private/var
    // aliases on macOS without weakening the traversal boundary.
    const declaredBackup = path.resolve(state.backupDir);
    const coreRoot = path.join(declaredBackup, 'core');
    const previousCore = state.previousCorePackage ? path.resolve(state.previousCorePackage) : null;
    const previousCoreRelative = previousCore ? path.relative(coreRoot, previousCore) : null;
    const previousCoreInsideBackup = !previousCore
      || (previousCoreRelative !== ''
        && previousCore.endsWith('.tgz')
        && !previousCoreRelative.startsWith(`..${path.sep}`)
        && previousCoreRelative !== '..'
        && !path.isAbsolute(previousCoreRelative));
    const servicesValid = Array.isArray(state.servicesWereRunning)
      && state.servicesWereRunning.every(name => typeof name === 'string' && /^[A-Za-z0-9._:-]+$/.test(name));
    if (state.schemaVersion !== 1
      || stateBackupDir !== resolved
      || !previousCoreInsideBackup
      || !servicesValid) {
      return { action: 'self_upgrade_recovery', success: false, error: 'invalid_recovery_state' };
    }

    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const steps = rollbackFn(state, deps.rollback);
    return {
      action: 'self_upgrade_recovery',
      success: steps.length > 0 && steps.every(step => step.success),
      backupDir: resolved,
      steps,
    };
  } catch {
    return { action: 'self_upgrade_recovery', success: false, error: 'recovery_failed' };
  }
}

// ---------------------------------------------------------------------------
// Public: runSelfUpgrade
// ---------------------------------------------------------------------------

const POST_INSTALL_STEPS = [
  step5_syncCoreSkills,
  step6_installSkillDeps,
  step7_syncInstructions,
  step8_migrateStateMd,
  step9_syncSettingsHooks,
  step10_ensureCodexConfig,
  step11_startCoreServices,
  step12_verifyServices,
  step13_commitSkillBaselines,
];

const FINALIZE_STATE_SCHEMA_VERSION = 2;

function classifyFinalizeState(state) {
  if (state.schemaVersion === FINALIZE_STATE_SCHEMA_VERSION) return 'current';
  // The released v1 launcher did not carry a recoverable core package. An
  // unversioned handoff is older still and has the same rollback boundary.
  if (state.schemaVersion === undefined || state.schemaVersion === 1) return 'legacy';
  return 'unsupported';
}

function buildManualRecovery(ctx, rollbackResults) {
  const versionCheck = rollbackResults.find(result => result.action === 'verify_restored_core_version');
  const skillRestore = rollbackResults.find(result => result.action === 'restore_core_skills');
  const expectedCoreVersion = versionCheck?.expectedVersion || ctx.from || null;
  const actualCoreVersion = versionCheck?.actualVersion || ctx.to || null;
  const coreSkillsRestored = skillRestore?.success === true;
  const rollbackPerformed = rollbackResults.length > 0 && rollbackResults.every(result => result.success);
  const recoveryCommand = `yos upgrade --self --recover ${JSON.stringify(ctx.backupDir)}`;
  const failedServices = new Set();
  for (const result of rollbackResults.filter(item => !item.success)) {
    if (result.action?.startsWith('restart_')) failedServices.add(result.action.slice('restart_'.length));
    const offline = /services not online:\s*(.+)/i.exec(result.error || '');
    if (offline) {
      for (const name of offline[1].split(',').map(item => item.trim()).filter(Boolean)) failedServices.add(name);
    }
  }
  const coreSkillsVersion = coreSkillsRestored ? expectedCoreVersion : null;
  const mixedInstall = !rollbackPerformed && (
    !coreSkillsRestored
    || (actualCoreVersion && coreSkillsVersion && actualCoreVersion !== coreSkillsVersion)
  );
  const coreState = expectedCoreVersion && actualCoreVersion && expectedCoreVersion !== actualCoreVersion
    ? `Core remains at ${actualCoreVersion}; it was not rolled back to ${expectedCoreVersion}.`
    : `Core rollback to ${expectedCoreVersion || 'the previous version'} could not be fully verified.`;
  const skillsState = coreSkillsRestored
    ? 'Core Skills were restored from the transaction backup.'
    : 'Core Skills restoration could not be verified.';
  const summary = [
    `Rollback was attempted but ${rollbackPerformed ? 'completed' : 'incomplete'}.`,
    coreState,
    skillsState,
    `Core version: ${actualCoreVersion || 'unknown'}.`,
    `Core Skills version: ${coreSkillsVersion || 'unknown'}.`,
    `Mixed installation: ${mixedInstall ? 'yes' : 'no'}.`,
    `Backup: ${ctx.backupDir}.`,
    `Recovery command: ${recoveryCommand}.`,
  ];
  if (failedServices.size > 0) summary.push(`Services not online: ${[...failedServices].join(', ')}.`);

  return {
    backupDir: ctx.backupDir,
    command: recoveryCommand,
    expectedCoreVersion,
    actualCoreVersion,
    coreSkillsRestored,
    failedServices: [...failedServices],
    message: summary.join(' '),
  };
}

function buildSelfUpgradeResult(ctx, failedStep, rollbackResults = null, rollbackPerformed = Boolean(rollbackResults)) {
  if (failedStep) {
    const rollbackComplete = rollbackPerformed
      && (rollbackResults || []).every(result => result.success);
    const machineUnchanged = !rollbackPerformed
      && !ctx.coreInstallAttempted
      && ctx.servicesStopped.length === 0;
    const machineState = rollbackComplete
      ? 'restored'
      : machineUnchanged
        ? 'unchanged'
        : 'recovery_required';
    const manualRecovery = machineState === 'recovery_required' && ctx.backupDir
      ? buildManualRecovery(ctx, rollbackResults || [])
      : null;
    const resultError = manualRecovery
      ? `${failedStep.error}\nRECOVERY: ${manualRecovery.message}`
      : failedStep.error;
    return {
      action: 'self_upgrade',
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: resultError,
      steps: ctx.steps,
      rollback: {
        attempted: rollbackPerformed,
        performed: rollbackComplete,
        steps: rollbackResults || [],
      },
      backupDir: ctx.backupDir,
      machineState,
      ...(manualRecovery ? { manualRecovery } : {}),
    };
  }

  // List template files for Claude to compare with local structure
  const templatesDir = ctx.tempDir ? path.join(ctx.tempDir, 'templates') : null;
  const templates = listTemplateFiles(templatesDir);

  // Migration hints: step 8 already applied settings sync via the newly installed script.
  const migrationHints = [];

  // Check if instruction files were rebuilt (CLAUDE.md / AGENTS.md) — used by
  // component.js to auto-enqueue a Claude restart after the reply is sent, so
  // Claude does not prompt the user about restarting.
  const step7 = ctx.steps.find(s => s.step === 7);
  const instructionFilesRebuilt = step7?.status === 'done' && Boolean(step7?.message?.includes('rebuilt'));

  // Check if settings.json was modified (hooks, statusLine, model) — requires
  // Claude restart to load the new configuration.
  const step9 = ctx.steps.find(s => s.step === 9);
  const settingsChanged = step9?.status === 'done' &&
    !/all up to date|no changes/.test(step9?.message || '');

  return {
    action: 'self_upgrade',
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    templates,
    migrationHints,
    instructionFilesRebuilt,
    settingsChanged,
    warnings: ctx.warnings?.length ? ctx.warnings : null,
    retainBackup: Boolean(ctx.retainBackup),
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
  };
}

export function createFinalizeState(ctx) {
  return {
    schemaVersion: FINALIZE_STATE_SCHEMA_VERSION,
    tempDir: ctx.tempDir,
    backupDir: ctx.backupDir,
    previousCorePackage: ctx.previousCorePackage,
    coreInstallAttempted: ctx.coreInstallAttempted,
    servicesWereRunning: ctx.servicesWereRunning,
    from: ctx.from,
    to: ctx.to,
    newVersion: ctx.newVersion,
    mode: ctx.mode,
  };
}

function writeFinalizeState(ctx) {
  const statePath = path.join(ctx.tempDir, 'self-upgrade-finalize-state.json');
  fs.writeFileSync(statePath, `${JSON.stringify(createFinalizeState(ctx), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return statePath;
}

function runInstalledFinalizer(ctx) {
  const finalizeScript = resolveInstalledPackageScript('cli', 'lib', 'self-upgrade-finalize.js');
  if (!finalizeScript) {
    throw new Error('newly installed self-upgrade finalizer not found');
  }

  const statePath = writeFinalizeState(ctx);
  const result = spawnSync(process.execPath, [finalizeScript, statePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  });

  if (result.error) {
    throw result.error;
  }

  const output = String(result.stdout || '').trim();
  if (!output) {
    const err = String(result.stderr || '').trim() || `finalizer exited ${result.status}`;
    throw new Error(err);
  }

  const parsed = JSON.parse(output);
  if (result.status !== 0 && parsed?.success !== false) {
    const err = String(result.stderr || '').trim() || `finalizer exited ${result.status}`;
    throw new Error(err);
  }

  return parsed;
}

export function runSelfUpgradeFinalize(state = {}, deps = {}) {
  const handoffState = classifyFinalizeState(state);
  if (handoffState === 'unsupported') {
    return {
      action: 'self_upgrade',
      success: false,
      from: state.from || null,
      to: null,
      failedStep: 5,
      error: `unsupported finalize state schemaVersion: ${state.schemaVersion}`,
      steps: [],
      rollback: { performed: false, steps: [] },
    };
  }

  const ctx = createContext({
    tempDir: state.tempDir,
    newVersion: state.newVersion || state.to,
    mode: state.mode,
  });
  ctx.backupDir = state.backupDir || null;
  ctx.handoffState = handoffState;
  ctx.previousCorePackage = handoffState === 'current' ? state.previousCorePackage || null : null;
  // The finalizer only runs after the candidate core was installed. Legacy
  // launchers did not record this fact, so absence must not mean "unchanged".
  ctx.coreInstallAttempted = handoffState === 'legacy' || Boolean(state.coreInstallAttempted);
  ctx.servicesWereRunning = Array.isArray(state.servicesWereRunning) ? [...state.servicesWereRunning] : [];
  ctx.from = state.from || null;
  ctx.to = state.to || state.newVersion || null;

  const steps = deps.steps || POST_INSTALL_STEPS;
  const total = deps.total || 13;
  let failedStep = null;

  for (const stepFn of steps) {
    const result = stepFn(ctx);
    result.total = total;
    ctx.steps.push(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  if (failedStep) {
    if (failedStep.step === 13) {
      ctx.warnings = [{
        step: failedStep.step,
        name: failedStep.name,
        message: failedStep.error,
      }];
      ctx.retainBackup = true;
      return buildSelfUpgradeResult(ctx, null);
    }
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx, deps.rollback);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults, true);
  }

  const result = buildSelfUpgradeResult(ctx, null);
  if (ctx.backupDir) {
    (deps.cleanupBackup ?? cleanupBackup)(ctx.backupDir);
  }
  return result;
}

/**
 * Run the 13-step self-upgrade pipeline.
 * Template migration and Claude restart are handled by Claude after this completes.
 * Lock must be acquired by caller.
 *
 * @param {{ tempDir: string, newVersion: string, onStep?: function }} opts
 * @param {object} [deps] - Isolated self-upgrade seam for npm, PM2, version, rollback, and finalizer boundaries
 * @returns {object} Upgrade result
 */
export function runSelfUpgrade({ tempDir, newVersion, mode, onStep } = {}, deps = {}) {
  const ctx = createContext({ tempDir, newVersion, mode });

  const getCurrentVersionFn = deps.getCurrentVersion ?? getCurrentVersion;
  const current = getCurrentVersionFn();
  if (current.success) {
    ctx.from = current.version;
  }
  ctx.to = newVersion || null;

  const prepareFn = deps.prepareSelfUpgrade ?? prepareSelfUpgrade;
  let preflight;
  try {
    preflight = prepareFn(ctx, deps.preflight);
  } catch (err) {
    preflight = {
      step: 0,
      name: 'prepare_upgrade',
      status: 'failed',
      error: err.message,
      duration: 0,
    };
  }
  preflight.total = 13;
  ctx.steps.push(preflight);
  if (onStep) onStep(preflight);
  if (preflight.status === 'failed') {
    ctx.error = preflight.error;
    return buildSelfUpgradeResult(ctx, preflight, null, false);
  }

  const preInstallSteps = deps.preInstallSteps ?? [
    (stepCtx) => step1_backupCoreSkills(stepCtx, deps.step1),
    step2_preUpgradeHook,
    (stepCtx) => step3_stopCoreServices(stepCtx, deps.step3),
    (stepCtx) => step4_npmInstallGlobal(stepCtx, deps.step4),
  ];

  const total = 13;
  let failedStep = null;

  for (const stepFn of preInstallSteps) {
    const result = stepFn(ctx);
    result.total = total;
    ctx.steps.push(result);
    if (onStep) onStep(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  if (failedStep) {
    cleanupSelfUpgradePreparation(ctx, deps.fs ?? fs);
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx, deps.rollback);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults);
  }

  try {
    const finalizerFn = deps.runInstalledFinalizer ?? runInstalledFinalizer;
    const finalizeResult = finalizerFn(ctx);
    const finalizeSteps = Array.isArray(finalizeResult.steps) ? finalizeResult.steps : [];
    for (const step of finalizeSteps) {
      ctx.steps.push(step);
      if (onStep) onStep(step);
    }
    return {
      ...finalizeResult,
      from: ctx.from,
      steps: ctx.steps,
      backupDir: finalizeResult.backupDir || ctx.backupDir,
    };
  } catch (err) {
    const error = err.stderr?.toString().trim() || err.message;
    failedStep = {
      step: 5,
      name: 'run_new_upgrade_finalizer',
      status: 'failed',
      error,
      total,
      duration: 0,
    };
    ctx.steps.push(failedStep);
    if (onStep) onStep(failedStep);
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx, deps.rollback);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults, true);
  }
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

export function cleanupTemp(tempDir) {
  if (!tempDir || !fs.existsSync(tempDir)) return;

  let resolved;
  try { resolved = fs.realpathSync(tempDir); } catch { resolved = path.resolve(tempDir); }

  // Safety: only delete directories under allowed temp roots
  const allowedRoots = getAllowedTmpRoots();
  if (!allowedRoots.some(root => resolved.startsWith(root + '/'))) {
    console.error(`SAFETY: refusing to delete ${resolved} (not under any allowed temp root)`);
    return;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Also clean up backup dirs after successful upgrade
export function cleanupBackup(backupDir) {
  if (backupDir && fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}
