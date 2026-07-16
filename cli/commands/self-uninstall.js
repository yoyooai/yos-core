/**
 * yos uninstall --self — Remove yos entirely from the system.
 *
 * Phase 1: Stop services (tmux sessions + PM2 yos services)
 * Phase 2: Uninstall the yos npm package
 * Phase 3: Remove ~/yos/ directory and clean shell profile PATH entries
 * Phase 4: Optional cleanup (PM2, Claude CLI) — interactive, skipped with --force
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { YOS_DIR } from '../lib/config.js';
import { getActiveAdapter } from '../lib/runtime/index.js';
import { bold, dim, green, red, cyan, success, warn, heading } from '../lib/colors.js';
import { promptYesNo } from '../lib/prompts.js';
import { commandExists } from '../lib/shell-utils.js';

// Kill both known runtime sessions on uninstall regardless of which is active
const TMUX_SESSIONS = ['claude-main', 'codex-main'];

export async function selfUninstall(args) {
  const force = args.includes('--force') || args.includes('-f');

  console.log();
  console.log(heading('YOS Uninstall'));
  console.log();

  // ── Summary ──────────────────────────────────────────
  console.log(bold('This will:'));
  console.log(`  1. Stop all YOS services (tmux + PM2)`);
  console.log(`  2. Uninstall the ${cyan('YOS')} npm package`);
  console.log(`  3. Clean shell PATH entries`);
  if (!force) {
    console.log(`  4. Optionally remove PM2, Claude CLI, and/or Codex CLI`);
    console.log(`  5. Optionally remove ${cyan('~/yos/')} data directory`);
  }
  console.log();
  console.log(dim('This will NOT remove Node.js or nvm.'));
  console.log();

  // ── Confirmation ─────────────────────────────────────
  if (!force) {
    const confirmed = await promptYesNo(
      red(bold('Are you sure you want to uninstall yos? [y/N] '))
    );
    if (!confirmed) {
      console.log('\nCancelled.');
      return;
    }
    console.log();
  }

  // ── Phase 1: Stop Services ───────────────────────────
  console.log(heading('Phase 1: Stopping services'));

  killTmuxSession();
  stopYOSPm2Services();

  console.log(success('Services stopped'));
  console.log();

  // ── Phase 4: Optional cleanup (ask BEFORE removing ~/yos/) ──
  let removePm2 = false;
  let removeClaude = false;
  let removeCodex = false;

  if (!force) {
    console.log(heading('Optional cleanup'));
    console.log(dim('These tools were installed for YOS but may be used by other software.'));
    console.log();

    if (commandExists('pm2')) {
      removePm2 = await promptYesNo(
        `  Remove PM2? ${dim('(npm uninstall -g pm2 + remove ~/.pm2)')} [y/N] `
      );
    }

    if (commandExists('claude')) {
      removeClaude = await promptYesNo(
        `  Remove Claude CLI? ${dim('(npm uninstall -g + remove ~/.claude/)')} [y/N] `
      );
    }

    if (commandExists('codex')) {
      removeCodex = await promptYesNo(
        `  Remove Codex CLI? ${dim('(npm uninstall -g @openai/codex + remove ~/.codex/)')} [y/N] `
      );
    }
    console.log();
  }

  // ── Phase 2: Uninstall npm package ───────────────────
  console.log(heading('Phase 2: Uninstalling YOS package'));

  const npmOk = npmUninstallGlobal('yos');
  if (npmOk) {
    console.log(success('YOS package uninstalled'));
  } else {
    console.log(warn('Could not uninstall YOS package (may already be removed)'));
  }
  console.log();

  // ── Phase 3: Clean shell config ──────────────────────
  console.log(heading('Phase 3: Cleaning shell config'));

  const profilesCleaned = cleanShellProfiles();
  if (profilesCleaned.length > 0) {
    console.log(success(`Shell profiles cleaned: ${profilesCleaned.join(', ')}`));
  } else {
    console.log(dim('  No shell profile changes needed'));
  }
  console.log();

  // ── Execute phase 4 choices ──────────────────────────
  if (removePm2) {
    console.log(dim('Removing PM2...'));
    uninstallPm2();
    console.log(success('PM2 removed'));
  }

  if (removeClaude) {
    console.log(dim('Removing Claude CLI...'));
    uninstallClaudeCli();
    console.log(success('Claude CLI removed'));
  }

  if (removeCodex) {
    console.log(dim('Removing Codex CLI...'));
    uninstallCodexCli();
    console.log(success('Codex CLI removed'));
  }

  // ── Phase 5: Data directory removal (explicit opt-in) ──
  let removeData = force;
  if (!force) {
    console.log();
    console.log(heading('Data directory'));
    console.log(red(bold('  ⚠  WARNING: ~/yos/ contains your memory, skills, and configuration.')));
    console.log(red(bold('     This data cannot be recovered once deleted.')));
    console.log();
    removeData = await promptYesNo(
      red(bold('  Delete ~/yos/ permanently? [y/N] '))
    );
  }

  if (removeData) {
    removeDirectory(YOS_DIR);
    console.log(success('YOS data directory removed'));
  } else {
    console.log(dim(`  Data directory preserved at ${cyan('~/yos/')}`));
    console.log(dim('  You can remove it later with: rm -rf ~/yos'));
  }

  // ── Done ─────────────────────────────────────────────
  console.log();
  console.log(green(bold('YOS has been uninstalled.')));

  const shell = (process.env.SHELL || '').split('/').pop() || 'bash';
  const rcFile = shell === 'zsh' ? '~/.zshrc' : '~/.bashrc';
  if (profilesCleaned.length > 0) {
    console.log(dim(`Restart your shell or run: source ${rcFile}`));
  }
}

// ── Phase 1 helpers ──────────────────────────────────────

/**
 * Kill all known runtime tmux sessions (claude-main, codex-main).
 */
function killTmuxSession() {
  for (const session of TMUX_SESSIONS) {
    try {
      execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' });
      console.log(`  Killed tmux session ${dim(session)}`);
    } catch {
      // Session not found — normal
    }
  }
}

/**
 * Identify and remove all yos-managed PM2 services.
 * Detection: a PM2 process is yos-managed if its exec_path or cwd
 * falls under ~/yos/.
 * @returns {boolean} true if PM2 was available and services were cleaned
 */
function stopYOSPm2Services() {
  if (!commandExists('pm2')) {
    console.log(`  ${dim('PM2 not found, skipping')}`);
    return false;
  }

  let processes;
  try {
    const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8', stdio: 'pipe' });
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    processes = parsed;
  } catch {
    console.log(`  ${dim('Could not read PM2 process list')}`);
    return false;
  }

  const yosProcesses = processes.filter((p) => {
    const exec = p.pm2_env?.pm_exec_path || '';
    const cwd = p.pm2_env?.pm_cwd || '';
    return isUnderYOS(exec) || isUnderYOS(cwd);
  });

  if (yosProcesses.length === 0) {
    console.log(`  ${dim('No YOS PM2 services found')}`);
    return true;
  }

  for (const p of yosProcesses) {
    try {
      execFileSync('pm2', ['delete', p.name], { stdio: 'pipe' });
      console.log(`  Removed PM2 service ${dim(p.name)}`);
    } catch {
      console.log(`  ${dim(`Could not remove ${p.name}`)}`);
    }
  }

  // Save so pm2 resurrect won't restore them.
  // --force is needed because pm2 refuses to save an empty process list by default.
  try {
    execFileSync('pm2', ['save', '--force'], { stdio: 'pipe' });
  } catch {
    // non-fatal
  }

  return true;
}

/**
 * Check if a path is under the yos directory.
 */
function isUnderYOS(filePath) {
  if (!filePath) return false;
  return filePath === YOS_DIR || filePath.startsWith(YOS_DIR + '/');
}

// ── Phase 2 helpers ──────────────────────────────────────

/**
 * Run npm uninstall -g for a package.
 * @returns {boolean} true if successful
 */
function npmUninstallGlobal(pkg) {
  try {
    execFileSync('npm', ['uninstall', '-g', pkg], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── Phase 3 helpers ──────────────────────────────────────

/**
 * Remove yos-related PATH entries from shell profile files.
 * Removes lines containing "yos" that modify PATH or were added by yos.
 * @returns {string[]} list of profile files that were modified
 */
function cleanShellProfiles() {
  const homedir = os.homedir();
  const profiles = ['.bashrc', '.zshrc', '.profile', '.bash_profile'];
  const modified = [];

  for (const name of profiles) {
    const filePath = path.join(homedir, name);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue; // file doesn't exist
    }

    // Remove lines added by yos (the comment + the export line)
    const original = content;
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      // Remove "# Added by yos" comment lines
      if (/^#\s*added by yos/i.test(line)) return false;
      // Remove PATH exports that reference yos directories
      if (/export\s+PATH=.*yos/i.test(line)) return false;
      return true;
    });

    if (filtered.length === lines.length) continue; // nothing removed

    // Clean up consecutive blank lines left behind by removal
    content = filtered.join('\n').replace(/\n{3,}/g, '\n\n');

    if (content !== original) {
      fs.writeFileSync(filePath, content);
      modified.push(`~/${name}`);
    }
  }

  return modified;
}

/**
 * Remove the yos directory.
 */
function removeDirectory(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.log(warn(`Could not fully remove ${dirPath}: ${err.message}`));
  }
}

// ── Phase 4 helpers ──────────────────────────────────────

/**
 * Fully remove PM2: unstartup, uninstall, remove data dir.
 */
function uninstallPm2() {
  // Remove startup hook
  try {
    // pm2 unstartup outputs a sudo command that needs to be run
    const result = spawnSync('pm2', ['unstartup'], { encoding: 'utf8', stdio: 'pipe' });
    const sudoCmd = (result.stdout + result.stderr).match(/sudo .+/)?.[0];
    if (sudoCmd) {
      spawnSync('bash', ['-c', sudoCmd], { stdio: 'pipe' });
    }
  } catch {
    // non-fatal
  }

  // Kill PM2 daemon
  try {
    execFileSync('pm2', ['kill'], { stdio: 'pipe' });
  } catch {
    // non-fatal
  }

  npmUninstallGlobal('pm2');

  // Remove PM2 data directory
  const pm2Dir = path.join(os.homedir(), '.pm2');
  removeDirectory(pm2Dir);
}

/**
 * Remove Claude CLI and its data directory.
 */
function uninstallClaudeCli() {
  npmUninstallGlobal('@anthropic-ai/claude-code');

  const claudeDir = path.join(os.homedir(), '.claude');
  removeDirectory(claudeDir);
}

/**
 * Remove Codex CLI and its config directory.
 */
function uninstallCodexCli() {
  npmUninstallGlobal('@openai/codex');

  const codexDir = path.join(os.homedir(), '.codex');
  removeDirectory(codexDir);
}
