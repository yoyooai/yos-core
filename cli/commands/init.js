/**
 * yos init - Initialize YOS environment
 *
 * Sets up the directory structure, checks prerequisites,
 * syncs Core Skills, deploys templates, and starts services.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, execFileSync, spawnSync, spawn } from 'node:child_process';
import { YOS_DIR, SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, COMPONENTS_FILE, BIN_DIR, HTTP_DIR, CADDYFILE, CADDY_BIN, getYosConfig, updateYosConfig } from '../lib/config.js';
import { generateManifest, saveMergeBaseline } from '../lib/manifest.js';
import { prompt, promptYesNo, promptChoice, promptSecret } from '../lib/prompts.js';
import { bold, dim, green, red, yellow, cyan, bgGreen, success, error, warn, heading } from '../lib/colors.js';
import { commandExists } from '../lib/shell-utils.js';
import { getActiveAdapter } from '../lib/runtime/index.js';
import {
  buildProbeUrl,
  describeEndpoint,
  resolveClaudeBaseUrl,
  resolveCodexBaseUrl,
  OFFICIAL_CODEX_BASE_URL,
} from '../lib/api-endpoint.js';
import {
  activateFreshSplitInstructions,
  refreshSplitInstructions,
} from '../lib/runtime/instruction-builder.js';
import { deployManifestTemplate } from '../lib/runtime/tmux-env.js';
import { npmInstallEnv } from '../lib/npm-env.js';
import { readEnvFile, writeEnvEntries } from '../lib/env.js';
import { resolveWebConsolePort, readRecordedConsolePort, DEFAULT_WEB_CONSOLE_PORT } from '../lib/web-console-port.js';
import { looksIsolated, classifyUnitWrite, backupUnitPath } from '../lib/pm2-unit-guard.js';
import { parseJlist, classifyLeftovers, describeLeftovers } from '../lib/pm2-leftovers.js';
import { readServiceState, judgeSettle } from '../lib/service.js';
import { distVendorUrl, noteMirrorFallback } from '../lib/dist-origin.js';
import { installRebootCrontab } from '../lib/boot-autostart.js';
import {
  installGlobalPackageWithFallback,
  describeNpmInstallFailure,
  installCodex,
  installClaude,
  describeClaudeInstallFailure,
  isClaudeAuthenticated,
  isCodexAuthenticated,
  isValidBaseUrl,
  approveApiKey,
  saveApiKey,
  saveApiKeyToEnv,
  saveClaudeBaseUrl,
  saveClaudeBaseUrlToSettingsAndEnv,
  saveSetupToken,
  saveSetupTokenToEnv,
  saveCodexBaseUrl,
  saveCodexApiKey,
  saveCodexApiKeyToEnv,
  saveCodexBaseUrlToEnv,
  writeCodexConfig,
} from '../lib/runtime-setup.js';

// Source directories (shipped with yos package)
const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..');
const CORE_SKILLS_SRC = path.join(PACKAGE_ROOT, 'skills');
const TEMPLATES_SRC = path.join(PACKAGE_ROOT, 'templates');

// Minimum Node.js version
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 20;

/**
 * Read service names from the deployed ecosystem.config.cjs.
 * Single source of truth — no hardcoded list needed.
 */
function getCoreServiceNames() {
  const ecosystemPath = path.join(YOS_DIR, 'pm2', 'ecosystem.config.cjs');
  if (!fs.existsSync(ecosystemPath)) return [];
  try {
    const require = createRequire(import.meta.url);
    // Clear cache so re-reads pick up updates from deployTemplates()
    delete require.cache[ecosystemPath];
    const ecosystem = require(ecosystemPath);
    return ecosystem.apps.map((app) => app.name);
  } catch {
    return [];
  }
}

// ── Prerequisite checks ─────────────────────────────────────────

function checkNodeVersion() {
  const version = process.version;
  const parts = version.slice(1).split('.').map(Number);
  const ok = parts[0] > MIN_NODE_MAJOR ||
    (parts[0] === MIN_NODE_MAJOR && parts[1] >= MIN_NODE_MINOR);
  return { version, ok, required: `>=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0` };
}

function installSystemPackage(pkg) {
  const platform = process.platform;
  const sudo = process.getuid?.() === 0 ? '' : 'sudo ';

  if (platform === 'darwin') {
    try {
      execSync(`brew install ${pkg}`, { stdio: 'pipe', timeout: 120000 });
      return true;
    } catch {
      return false;
    }
  }

  // Linux: try apt-get first, then yum
  const cmds = [
    [`${sudo}apt-get update`, `${sudo}apt-get install -y ${pkg}`],
    [`${sudo}yum install -y ${pkg}`],
  ];

  for (const sequence of cmds) {
    try {
      for (const cmd of sequence) {
        execSync(cmd, { stdio: 'pipe', timeout: 120000 });
      }
      return true;
    } catch {
      // Try next
    }
  }
  return false;
}

/**
 * Ensure ~/.local/bin is in the user's shell profile.
 * Detects shell from $SHELL and writes to the appropriate rc file.
 * Returns the profile path if modified, null otherwise.
 */
function ensureLocalBinInProfile() {
  const homedir = os.homedir();
  const shell = (process.env.SHELL || '').split('/').pop();
  const pathLine = 'export PATH="$HOME/.local/bin:$PATH"';

  // Map shell to profile file
  const profileMap = {
    zsh: '.zshrc',
    bash: '.bashrc',
    fish: null, // fish uses different syntax
    sh: '.profile',
  };

  const profileName = profileMap[shell] || '.profile';
  if (!profileName) return null; // unsupported shell (fish)

  const profilePath = path.join(homedir, profileName);

  // Check if already present
  try {
    const content = fs.readFileSync(profilePath, 'utf8');
    if (content.includes('.local/bin')) return null; // already there
  } catch {
    // File doesn't exist — we'll create it
  }

  try {
    fs.appendFileSync(profilePath, `\n# Added by yos init\n${pathLine}\n`);
    return `~/${profileName}`;
  } catch {
    return null;
  }
}

/**
 * Save the current shell PATH to .env so PM2 services can use it.
 * Updates SYSTEM_PATH= line if exists, appends if not.
 */
function saveSystemPath(envPath) {
  const currentPath = process.env.PATH || '';
  // Deduplicate PATH entries before saving — prevents bloat when yos init
  // runs while PM2 is already live (process.env.PATH may already contain
  // the previous ENHANCED_PATH from ecosystem.config.cjs).
  const dedupedPath = [...new Set(currentPath.split(':').filter(Boolean))].join(':');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return; // .env doesn't exist yet
  }

  const line = `SYSTEM_PATH=${dedupedPath}`;
  if (content.includes('SYSTEM_PATH=')) {
    content = content.replace(/^SYSTEM_PATH=.*$/m, line);
  } else {
    content = content.trimEnd() + '\n\n# System PATH captured by yos init (used by PM2 services)\n' + line + '\n';
  }
  fs.writeFileSync(envPath, content);
}

// ── Timezone configuration ───────────────────────────────────

// Common timezones grouped for selection
const COMMON_TIMEZONES = [
  { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
  { label: 'Asia/Tokyo (UTC+9)', value: 'Asia/Tokyo' },
  { label: 'Asia/Singapore (UTC+8)', value: 'Asia/Singapore' },
  { label: 'Asia/Kolkata (UTC+5:30)', value: 'Asia/Kolkata' },
  { label: 'America/New_York (UTC-5)', value: 'America/New_York' },
  { label: 'America/Chicago (UTC-6)', value: 'America/Chicago' },
  { label: 'America/Los_Angeles (UTC-8)', value: 'America/Los_Angeles' },
  { label: 'Europe/London (UTC+0)', value: 'Europe/London' },
  { label: 'Europe/Berlin (UTC+1)', value: 'Europe/Berlin' },
  { label: 'Australia/Sydney (UTC+11)', value: 'Australia/Sydney' },
  { label: 'Pacific/Auckland (UTC+13)', value: 'Pacific/Auckland' },
  { label: 'UTC', value: 'UTC' },
];

/**
 * Detect the system timezone.
 * @returns {string} IANA timezone name
 */
function detectSystemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Validate an IANA timezone string.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current TZ value from .env.
 * @returns {string|null} TZ value or null if not set
 */
function readEnvTimezone() {
  const envPath = path.join(YOS_DIR, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^TZ=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Record where this machine was installed from, so upgrades come from the same
 * place. install.sh knows the answer (it resolved the release repository to
 * install), but the CLI had no way to learn it: `yos upgrade --self` failed with
 * "YOS_RELEASE_REPO is not configured" on every fresh machine, so a customer
 * could install YOS and then had no way to update it.
 *
 * Recorded rather than defaulted on purpose: a machine installed from a fork
 * must keep upgrading from that fork, not from ours.
 */
function recordReleaseSource() {
  const repo = (process.env.YOS_RELEASE_REPO || '').trim();
  if (!repo) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) return null;
  const { written } = writeEnvEntries({ YOS_RELEASE_REPO: repo }, 'YOS release source');
  return written.includes('YOS_RELEASE_REPO') ? repo : null;
}

/**
 * Write timezone to .env file. Updates existing TZ= line or adds one.
 * @param {string} tz - IANA timezone name
 */
function writeEnvTimezone(tz) {
  const envPath = path.join(YOS_DIR, '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }

  if (content.match(/^TZ=.*$/m)) {
    content = content.replace(/^TZ=.*$/m, `TZ=${tz}`);
  } else {
    content = content.trimEnd() + `\nTZ=${tz}\n`;
  }
  fs.writeFileSync(envPath, content);
}

/**
 * Interactive timezone configuration.
 * Auto-detects system timezone and asks user to confirm or select another.
 * On re-init, shows current value and skips prompt.
 *
 * @param {boolean} skipConfirm - Skip interactive prompts (non-interactive mode)
 * @param {boolean} isReinit - Whether this is a re-init of an existing installation
 * @param {string|null} resolvedTz - Timezone from CLI flag or env var (already validated)
 * @param {boolean} quiet - Suppress output (--quiet flag)
 */
async function configureTimezone(skipConfirm, isReinit, resolvedTz = null, quiet = false) {
  // CLI flag or env var provided — use directly
  if (resolvedTz) {
    writeEnvTimezone(resolvedTz);
    if (!quiet) console.log(`  ${success(`Timezone: ${bold(resolvedTz)}`)}`);
    return;
  }

  const currentTz = readEnvTimezone();

  // Re-init with valid non-default timezone: just display it
  if (isReinit && currentTz && isValidTimezone(currentTz)) {
    if (!quiet) console.log(`  ${success(`Timezone: ${bold(currentTz)}`)}`);
    return;
  }

  // Non-interactive mode: use detected timezone
  if (skipConfirm) {
    const detected = detectSystemTimezone();
    writeEnvTimezone(detected);
    if (!quiet) console.log(`  ${success(`Timezone: ${bold(detected)}`)}`);
    return;
  }

  const detected = detectSystemTimezone();
  const useDetected = await promptYesNo(`  Detected timezone: ${bold(detected)}. Is this correct? [Y/n]: `, true);

  if (useDetected) {
    writeEnvTimezone(detected);
    console.log(`  ${success(`Timezone: ${bold(detected)}`)}`);
    return;
  }

  // Show common timezone list
  console.log(`\n  ${heading('Select timezone:')}`);
  for (let i = 0; i < COMMON_TIMEZONES.length; i++) {
    console.log(`    ${i + 1}) ${COMMON_TIMEZONES[i].label}`);
  }
  console.log(`    ${COMMON_TIMEZONES.length + 1}) Other (enter manually)`);

  while (true) {
    const choice = await prompt(`\n  Enter number [1-${COMMON_TIMEZONES.length + 1}]: `);
    const num = parseInt(choice, 10);

    if (num >= 1 && num <= COMMON_TIMEZONES.length) {
      const tz = COMMON_TIMEZONES[num - 1].value;
      writeEnvTimezone(tz);
      console.log(`  ${success(`Timezone: ${bold(tz)}`)}`);
      return;
    }

    if (num === COMMON_TIMEZONES.length + 1) {
      while (true) {
        const manual = await prompt('  Enter IANA timezone (e.g., America/Denver): ');
        if (!manual) continue;
        if (isValidTimezone(manual)) {
          writeEnvTimezone(manual);
          console.log(`  ${success(`Timezone: ${bold(manual)}`)}`);
          return;
        }
        console.log(`  ${error(`Invalid timezone: "${manual}". Try again.`)}`);
      }
    }

    console.log(`  Please enter a number between 1 and ${COMMON_TIMEZONES.length + 1}.`);
  }
}

/**
 * Ensure ~/yos/bin is in the user's shell PATH.
 * Detects the user's shell and appends to the appropriate rc file.
 * Idempotent: uses a marker comment to avoid duplicates.
 *
 * @returns {boolean} true if PATH was updated, false if already configured
 */
function ensureBinInPath() {
  // Already in PATH — nothing to do
  if ((process.env.PATH || '').split(':').includes(BIN_DIR)) {
    return false;
  }

  // Update current process PATH immediately so child processes (hooks,
  // services) can find binaries without needing a new shell session
  process.env.PATH = `${BIN_DIR}:${process.env.PATH}`;

  const home = process.env.HOME;
  const marker = '# yos-managed: bin PATH';
  const snippet = `\n${marker}\nexport PATH="${BIN_DIR}:$PATH"\n`;

  // Write to ~/.profile (sourced by login shells AND non-interactive shells
  // via .profile → .bashrc chain). On Ubuntu, .bashrc has an early-exit guard
  // for non-interactive shells, so appending to .bashrc alone won't work for
  // tools like Claude Code that spawn non-interactive bash processes.
  const profileFile = path.join(home, '.profile');
  let profileUpdated = false;
  try {
    const content = fs.readFileSync(profileFile, 'utf8');
    if (!content.includes(marker)) {
      fs.appendFileSync(profileFile, snippet);
      profileUpdated = true;
    }
  } catch {
    fs.appendFileSync(profileFile, snippet);
    profileUpdated = true;
  }

  // Also write to shell rc file for interactive shells (zsh uses .zshrc,
  // bash interactive shells source .bashrc after the guard)
  const shell = process.env.SHELL || '/bin/bash';
  let rcFile;
  if (shell.endsWith('/zsh')) {
    rcFile = path.join(home, '.zshrc');
  } else if (shell.endsWith('/fish')) {
    return profileUpdated;
  } else {
    rcFile = path.join(home, '.bashrc');
  }

  try {
    const content = fs.readFileSync(rcFile, 'utf8');
    if (content.includes(marker)) return profileUpdated;
  } catch {
    // rc file doesn't exist — we'll create/append
  }

  fs.appendFileSync(rcFile, snippet);
  return true;
}

// ── Codex helpers ─────────────────────────────────────────────────────────

/**
// ── End Codex helpers ──────────────────────────────────────────────────────

/**
 * Save an Anthropic API key to ~/.claude/settings.json and process.env.
 * Does NOT write to ~/yos/.env here — that happens after template
 * deployment via saveApiKeyToEnv() to avoid creating a partial .env
 * that blocks template deployment on fresh installs.
 *
 * @param {string} apiKey - The API key (sk-ant-xxx)
 * @returns {boolean} true if saved successfully
 */
/**
 * Decide what to do with a credential given its probe result.
 *
 * The whole point of this function is that exactly two outcomes justify
 * throwing a customer's key away: the endpoint rejected it, or the configured
 * base URL is unusable so there is nothing to check against. Anything else —
 * unreachable, timeout, a status that proves nothing — leaves the key on disk,
 * because discarding a credential we never managed to check is what left
 * installs with no credential at all.
 *
 * Saving is not the same as passing: 'save-unverified' must never be reported
 * as authenticated.
 *
 * @param {{ok: boolean, reason: string}} result
 * @returns {'verified'|'save-unverified'|'refuse'}
 */
export function decideCredentialOutcome(result) {
  if (result.reason === 'rejected' || result.reason === 'bad-base-url') return 'refuse';
  return result.ok ? 'verified' : 'save-unverified';
}

/**
 * Print why a credential was refused, naming the host actually contacted.
 *
 * "Invalid key" and "could not reach the server" are different problems with
 * different fixes; collapsing them into one message sends customers to check a
 * key that was never the issue.
 *
 * @param {string} label - Human name of the credential, e.g. 'Anthropic API key'
 * @param {{reason: string, target: string}} result - Result from a verify* call
 * @param {boolean} customEndpoint - Whether the endpoint is a customer gateway
 * @param {string} vendorConsole - Where to check the key when it was genuinely rejected
 */
function reportCredentialFailure(label, result, customEndpoint, vendorConsole) {
  if (result.reason === 'bad-base-url') {
    console.error(`  ${error(`${label} not saved — the configured base URL could not be parsed.`)}`);
    console.error(`    ${dim(`Value: ${result.target}`)}`);
    console.error(`    ${dim('Expected something like: https://gateway.example.com')}`);
    return;
  }
  console.error(`  ${error(`${label} was rejected by ${result.target}.`)}`);
  console.error(`    ${dim(customEndpoint
    ? `The endpoint answered, and it refused this key. Check it with whoever issued ${result.target}.`
    : `The endpoint answered, and it refused this key. Check it at ${vendorConsole}.`)}`);
}

/**
 * Print why a credential was saved without being verified.
 *
 * The key is kept: discarding a credential we never managed to check is what
 * left installs with no credential at all on networks that cannot reach the
 * endpoint. But it is NOT reported as authenticated — see the install summary.
 *
 * @param {string} label - Human name of the credential
 * @param {{reason: string, target: string, status?: number}} result
 * @param {boolean} customEndpoint - Whether the endpoint is a customer gateway
 */
function reportCredentialUnverified(label, result, customEndpoint) {
  if (result.reason === 'inconclusive') {
    console.log(`  ${warn(`${label} saved, but ${result.target} answered ${result.status} — could not confirm the key.`)}`);
    console.log(`    ${dim('That status means the endpoint is up but the request did not land where expected; check the base URL path.')}`);
    return;
  }
  console.log(`  ${warn(`${label} saved, but ${result.target} could not be reached — the key was never checked.`)}`);
  console.log(`    ${dim(customEndpoint
    ? `Confirm ${result.target} is reachable from this machine.`
    : 'If you use your own gateway, pass --base-url <url> so the check goes there.')}`);
}

/**
 * Classify a credential probe's HTTP status.
 *
 * Only an explicit rejection from the endpoint may condemn a key. A 404 or 502
 * says something about the endpoint (wrong path, gateway down), not about the
 * credential — reporting those as "invalid key" is how a reachable-but-
 * misconfigured gateway gets a good key thrown away.
 *
 * @param {number} status
 * @param {number[]} acceptedStatuses - Statuses that prove the key was accepted.
 * @returns {'valid'|'rejected'|'inconclusive'}
 */
function classifyProbeStatus(status, acceptedStatuses) {
  if (status === 401 || status === 403) return 'rejected';
  if (acceptedStatuses.includes(status)) return 'valid';
  return 'inconclusive';
}

/**
 * Probe a credential against one endpoint.
 *
 * @param {string} baseUrl - Base URL to probe (already resolved)
 * @param {string} apiPath - API path beginning with `/v1/`
 * @param {object} requestInit - fetch() options (method, headers, body)
 * @param {number[]} acceptedStatuses - Statuses that prove the key was accepted
 * @returns {Promise<{ok: boolean, reason: 'valid'|'rejected'|'inconclusive'|'unreachable'|'bad-base-url', target: string, status?: number}>}
 */
async function probeCredential(baseUrl, apiPath, requestInit, acceptedStatuses) {
  const probe = buildProbeUrl(baseUrl, apiPath);
  if (!probe) return { ok: false, reason: 'bad-base-url', target: String(baseUrl) };

  try {
    const res = await fetch(probe.url, { ...requestInit, signal: AbortSignal.timeout(10000) });
    const reason = classifyProbeStatus(res.status, acceptedStatuses);
    return { ok: reason === 'valid', reason, target: probe.host, status: res.status };
  } catch {
    // Unreachable, TLS failure, or timeout — says nothing about the key.
    return { ok: false, reason: 'unreachable', target: probe.host };
  }
}

/**
 * Verify an Anthropic API key by making a lightweight API call.
 * Sends an intentionally empty request — an accepted key returns 400 (bad
 * request), a rejected key returns 401/403.
 *
 * The check goes to the endpoint this install is configured for, so a key that
 * is valid on the customer's own gateway is not rejected because the vendor's
 * host is unreachable from their network.
 *
 * @param {string} apiKey - The API key to verify
 * @param {string|null} [baseUrl] - Explicit base URL override, if any
 * @returns {Promise<{ok: boolean, reason: string, target: string, status?: number}>}
 */
export function verifyApiKey(apiKey, baseUrl = null) {
  return probeCredential(
    resolveClaudeBaseUrl(baseUrl),
    '/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        // Gateways commonly expect Bearer; the vendor host ignores it.
        'authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: '{}',
    },
    [200, 400],
  );
}

/**
 * Verify an OpenAI API key with a lightweight GET to the models endpoint.
 * Goes to the configured endpoint — see verifyApiKey().
 *
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @param {string|null} [baseUrl] - Explicit base URL override, if any
 * @returns {Promise<{ok: boolean, reason: string, target: string, status?: number}>}
 */
export function verifyCodexApiKey(apiKey, baseUrl = null) {
  return probeCredential(
    resolveCodexBaseUrl(baseUrl),
    '/v1/models',
    { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    [200],
  );
}

/**
 * Verify a setup token by running `claude -p "hi" --max-turns 1`.
 * The token must already be saved (via saveSetupToken) so claude picks it up.
 *
 * @returns {{ valid: boolean, authError?: boolean, message?: string }}
 */
function verifySetupToken() {
  try {
    const result = spawnSync('claude', ['-p', 'hi', '--max-turns', '1'], {
      timeout: 30000,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
      return { valid: true };
    }

    const output = ((result.stdout?.toString() || '') + (result.stderr?.toString() || '')).trim();
    const lower = output.toLowerCase();
    const isAuthError = lower.includes('401') || lower.includes('unauthorized') ||
      lower.includes('authentication') || lower.includes('invalid token') ||
      lower.includes('invalid key') || lower.includes('expired') ||
      lower.includes('does not have access') || lower.includes('login again') ||
      lower.includes('permission denied');

    return { valid: false, authError: isAuthError, message: output };
  } catch (err) {
    return { valid: false, authError: false, message: err.message };
  }
}

/**
 * Undo saveSetupToken(): remove CLAUDE_CODE_OAUTH_TOKEN from
 * ~/.claude/settings.json and the current process environment.
 */
function rollbackSetupToken() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    console.error(`  ${warn(`Could not rollback setup token from settings.json: ${err.message}`)}`);
  }

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/**
 * Check if Claude bypass permissions needs first-time acceptance.
 * Returns true if bypass is enabled and hasn't been accepted yet.
 */
function needsBypassAcceptance() {
  // Check if bypass is disabled in .env
  const envPath = path.join(YOS_DIR, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^CLAUDE_BYPASS_PERMISSIONS=(.+)$/m);
    if (match && match[1].trim() === 'false') return false;
  } catch {}

  // Check if already pre-accepted via settings.json
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.skipDangerousModePermissionPrompt) return false;
  } catch {}

  // Check if already accepted (claude-main session with Claude running).
  // 'claude-main' is intentional: this check is Claude-specific (bypass prompt is Claude-only).
  try {
    execSync('tmux has-session -t claude-main 2>/dev/null', { stdio: 'pipe' });
    const paneContent = execSync('tmux capture-pane -t claude-main -p 2>/dev/null', { encoding: 'utf8' });
    if (paneContent.includes('>') || paneContent.includes('Claude')) {
      return false;
    }
  } catch {}

  return true;
}

/**
 * Pre-accept Claude Code terms and bypass permissions prompt.
 * Writes acceptance state to config files so Claude starts without manual confirmation.
 */
function preAcceptClaudeTerms() {
  const homedir = os.homedir();
  let changed = false;

  // 1. Set hasCompletedOnboarding in ~/.claude.json
  const claudeJsonPath = path.join(homedir, '.claude.json');
  let claudeJson = {};
  try {
    claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch {}
  if (!claudeJson.hasCompletedOnboarding) {
    claudeJson.hasCompletedOnboarding = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
    changed = true;
  }

  // 2. Set skipDangerousModePermissionPrompt in ~/.claude/settings.json
  const claudeDir = path.join(homedir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {}
  if (!settings.skipDangerousModePermissionPrompt) {
    settings.skipDangerousModePermissionPrompt = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    changed = true;
  }

  return changed;
}

/**
 * Guide user through first-time Claude bypass permissions acceptance.
 */
async function guideBypassAcceptance() {
  // This function is Claude-specific: the bypass-permissions prompt only exists in Claude Code.
  // Hardcoded 'claude-main' is intentional — this always creates a Claude session for acceptance.
  const CLAUDE_SESSION = 'claude-main';

  console.log(`\n${heading('Setting up Claude Code...')}`);

  // Stop activity-monitor to prevent restart loop
  try { execSync('pm2 stop activity-monitor', { stdio: 'pipe' }); } catch {}

  // Kill existing session if stuck
  try { execSync(`tmux kill-session -t ${CLAUDE_SESSION} 2>/dev/null`, { stdio: 'pipe' }); } catch {}

  // Create new tmux session with Claude
  try {
    const tmuxArgs = ['new-session', '-d', '-s', CLAUDE_SESSION];
    if (process.env.IS_SANDBOX) tmuxArgs.push('-e', 'IS_SANDBOX=1');

    // Write API key to temp file to avoid exposing it in process command line
    let shellCmd;
    let tmpEnv = null;
    if (process.env.ANTHROPIC_API_KEY) {
      tmpEnv = path.join(os.tmpdir(), `.yos-env-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmpEnv, `ANTHROPIC_API_KEY='${process.env.ANTHROPIC_API_KEY}'\n`, { mode: 0o600 });
      shellCmd = `set -a; . "${tmpEnv}"; set +a; rm -f "${tmpEnv}"; cd "${YOS_DIR}" && claude --dangerously-skip-permissions`;
    } else {
      shellCmd = `cd "${YOS_DIR}" && claude --dangerously-skip-permissions`;
    }
    tmuxArgs.push('--', shellCmd);
    try {
      execFileSync('tmux', tmuxArgs, { stdio: 'pipe' });
    } catch (e) {
      if (tmpEnv) try { fs.unlinkSync(tmpEnv); } catch {}
      throw e;
    }
    // Configure status bar with detach hint
    try {
      execSync(`tmux set-option -t ${CLAUDE_SESSION} status-right " Ctrl+B d = detach " 2>/dev/null`, { stdio: 'pipe' });
      execSync(`tmux set-option -t ${CLAUDE_SESSION} status-right-style "fg=black,bg=yellow" 2>/dev/null`, { stdio: 'pipe' });
    } catch {}
  } catch (err) {
    console.log(`  ${warn(`Failed to create tmux session: ${err.message}`)}`);
    try { execSync('pm2 start activity-monitor', { stdio: 'pipe' }); } catch {}
    return;
  }

  console.log('  Claude Code requires a one-time confirmation for autonomous mode.');
  console.log('  Please run the following command in another terminal:\n');
  console.log(`    ${bold('yos attach')}\n`);
  console.log('  Then select "Yes, I accept" and press Ctrl+B d to detach.\n');

  await promptYesNo('Press Enter after you have accepted the prompt: ', true);

  // Restart activity-monitor
  try { execSync('pm2 start activity-monitor', { stdio: 'pipe' }); } catch {}
  console.log(`  ${success('Claude Code configured')}`);
}

// ── Installation state detection ────────────────────────────────

/**
 * Detect the current installation state.
 * @returns {'fresh'|'incomplete'|'complete'}
 */
function detectInstallState() {
  if (!fs.existsSync(YOS_DIR)) return 'fresh';

  const markers = [CONFIG_DIR, SKILLS_DIR, COMPONENTS_FILE];
  const existing = markers.filter((m) => fs.existsSync(m));

  if (existing.length === 0) return 'fresh';
  if (existing.length === markers.length) return 'complete';
  return 'incomplete';
}

// ── State reset ─────────────────────────────────────────────────

/**
 * Reset managed state for a fresh install.
 * Removes config, skills, and components while preserving user data
 * (memory/, logs/, .env, CLAUDE.md).
 */
function resetManagedState() {
  // Stop PM2 services managed by yos
  const serviceNames = getCoreServiceNames();
  for (const name of serviceNames) {
    try { execSync(`pm2 delete "${name}" 2>/dev/null`, { stdio: 'pipe' }); } catch { /* */ }
  }

  // Remove managed directories
  for (const dir of [SKILLS_DIR, CONFIG_DIR, COMPONENTS_DIR, LOCKS_DIR, path.join(YOS_DIR, 'pm2')]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── Directory structure ─────────────────────────────────────────

function createDirectoryStructure() {
  const dirs = [
    YOS_DIR,
    SKILLS_DIR,
    CONFIG_DIR,
    COMPONENTS_DIR,
    LOCKS_DIR,
    BIN_DIR,
    HTTP_DIR,
    path.join(HTTP_DIR, 'public'),
    path.join(YOS_DIR, 'memory'),
    path.join(YOS_DIR, 'workspace'),
    path.join(YOS_DIR, 'logs'),
    path.join(YOS_DIR, 'pm2'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(COMPONENTS_FILE)) {
    fs.writeFileSync(COMPONENTS_FILE, JSON.stringify({}, null, 2));
  }
}

// ── Templates ───────────────────────────────────────────────────

/**
 * Recursively copy source files into dest directory, but only when missing.
 * Preserves user-managed files while ensuring nested template dirs exist.
 */
function copyMissingTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyMissingTree(srcPath, destPath);
    } else if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Deploy template files to the yos directory.
 * - ecosystem.config.cjs: always updated (managed by yos-core)
 * - .env, CLAUDE.md, memory/*: only created if missing (user-managed)
 */
export function syncSettingsHooksAfterTemplateDeploy({
  yosDir = YOS_DIR,
  syncScript = path.join(PACKAGE_ROOT, 'cli', 'lib', 'sync-settings-hooks.js'),
} = {}) {
  execFileSync(process.execPath, [syncScript], {
    stdio: 'inherit',
    env: { ...process.env, YOS_DIR: yosDir },
  });
}

export function deployTemplates({ freshInstall = false } = {}) {
  if (!fs.existsSync(TEMPLATES_SRC)) return;

  // ecosystem.config.cjs — always update (source of truth for service definitions)
  const pm2Dir = path.join(YOS_DIR, 'pm2');
  fs.mkdirSync(pm2Dir, { recursive: true });
  const ecosystemSrc = path.join(TEMPLATES_SRC, 'pm2', 'ecosystem.config.cjs');
  if (fs.existsSync(ecosystemSrc)) {
    fs.copyFileSync(ecosystemSrc, path.join(pm2Dir, 'ecosystem.config.cjs'));
  }

  // .env — create from template if missing
  const envSrc = path.join(TEMPLATES_SRC, '.env.example');
  const envDest = path.join(YOS_DIR, '.env');
  if (fs.existsSync(envSrc) && !fs.existsSync(envDest)) {
    fs.copyFileSync(envSrc, envDest);
    console.log(`  ${success('Created .env from template')}`);
  }

  // Always save current shell PATH to .env (for PM2 services)
  saveSystemPath(envDest);

  freshInstall
    ? activateFreshSplitInstructions({ yosDir: YOS_DIR, templatesDir: TEMPLATES_SRC })
    : refreshSplitInstructions({ yosDir: YOS_DIR, templatesDir: TEMPLATES_SRC });
  console.log(`  ${success('Split instruction files ready')}`);

  // memory/ templates — only create missing files
  const memorySrc = path.join(TEMPLATES_SRC, 'memory');
  const memoryDest = path.join(YOS_DIR, 'memory');
  if (fs.existsSync(memorySrc)) {
    copyMissingTree(memorySrc, memoryDest);
  }

  // .claude/ project settings (hooks, etc.) — only create missing files
  const claudeSrc = path.join(TEMPLATES_SRC, '.claude');
  const claudeDest = path.join(YOS_DIR, '.claude');
  if (fs.existsSync(claudeSrc)) {
    copyMissingTree(claudeSrc, claudeDest);
  }

  // runtime-env.manifest — create from template if missing
  const manifestSrc = path.join(TEMPLATES_SRC, 'runtime-env.manifest.example');
  if (deployManifestTemplate(manifestSrc, YOS_DIR) === 'created') {
    console.log(`  ${success('Created runtime-env.manifest from template')}`);
  }

  // npm postinstall can only sync assembler hooks for an already-materialized
  // installation. Fresh init creates the assembler above, so converge hooks
  // here after both the instruction assets and settings template exist.
  syncSettingsHooksAfterTemplateDeploy();
}

// ── Core Skills sync ────────────────────────────────────────────

/**
 * Recursively copy source files into dest directory.
 * Overwrites existing files, adds new files, preserves extra files
 * in dest (e.g., node_modules, data directories not in source).
 */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Sync Core Skills from the yos package to SKILLS_DIR.
 * Always updates source files from package (core skills are managed
 * by yos-core, like ecosystem.config.cjs). Preserves node_modules
 * and any extra files not in the package source.
 */
function syncCoreSkills() {
  if (!fs.existsSync(CORE_SKILLS_SRC)) {
    return { installed: [], updated: [], error: 'Core Skills source not found' };
  }

  const installed = [];
  const updated = [];

  const entries = fs.readdirSync(CORE_SKILLS_SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(CORE_SKILLS_SRC, entry.name);
    const destDir = path.join(SKILLS_DIR, entry.name);
    const isNew = !fs.existsSync(destDir);

    try {
      copyTree(srcDir, destDir);
      // Manifest from the SOURCE (authoritative package), never a destDir scan:
      // re-running init over an existing skill dir must not absorb local files
      // into the ownership record (issue #715).
      const manifest = generateManifest(srcDir);
      saveMergeBaseline(destDir, srcDir, manifest);
      (isNew ? installed : updated).push(entry.name);
    } catch {
      console.log(`  ${warn(`Failed to sync ${bold(entry.name)}`)}`);
    }
  }

  return { installed, updated };
}

// ── Skill dependencies ──────────────────────────────────────────

/**
 * Install npm dependencies for all skills that need them.
 */
function installSkillDependencies() {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

      console.log(`  ${cyan(`Installing ${bold(entry.name)} dependencies...`)}`);
      execSync('npm install --production', {
        cwd: skillDir,
        stdio: 'inherit',
        timeout: 300000,
        env: npmInstallEnv(),
      });
    } catch {
      console.log(`  ${warn(`Failed to install ${bold(entry.name)} dependencies`)}`);
    }
  }
}

/**
 * Ensure a web-console password exists in .env.
 * Reads from YOS_WEB_PASSWORD (new name), falls back to WEB_CONSOLE_PASSWORD (legacy).
 * Generates a random 16-char password if not already set.
 * Idempotent — safe to run on repeated init.
 *
 * @param {string|null} explicitPassword - Password from --web-password flag or env var
 * @returns {string} The password (existing or newly generated)
 */
/**
 * Read the console port the user configured, if any.
 *
 * @returns {{ port: number, explicit: boolean }}
 */
function readConfiguredConsolePort() {
  const fromEnv = Number(process.env.WEB_CONSOLE_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return { port: fromEnv, explicit: true };
  try {
    const content = fs.readFileSync(path.join(YOS_DIR, '.env'), 'utf8');
    const match = content.match(/^\s*WEB_CONSOLE_PORT\s*=\s*(\d+)\s*$/m);
    if (match) return { port: Number(match[1]), explicit: true };
  } catch { /* no .env yet */ }
  return { port: DEFAULT_WEB_CONSOLE_PORT, explicit: false };
}

/** Record the port so the PM2 entry, the Caddy route and the printed URL agree. */
function writeConsolePort(port) {
  const envPath = path.join(YOS_DIR, '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { return false; }
  const line = `WEB_CONSOLE_PORT=${port}`;
  content = /^\s*WEB_CONSOLE_PORT\s*=.*$/m.test(content)
    ? content.replace(/^\s*WEB_CONSOLE_PORT\s*=.*$/m, line)
    : `${content.trimEnd()}\n# Web Console port\n${line}\n`;
  fs.writeFileSync(envPath, content);
  return true;
}

/**
 * Settle which port the console gets, before anything is started or printed.
 *
 * @returns {Promise<number>} the port to use; the preferred one when nothing is free
 */
async function settleWebConsolePort({ quiet = false } = {}) {
  const configured = readConfiguredConsolePort();
  const outcome = await resolveWebConsolePort({
    preferred: configured.port,
    explicit: configured.explicit,
  });

  if (outcome.port === null) {
    // Starting anyway would be dishonest in the other direction: the service
    // check after startup reports it as not running, which is the truth.
    if (!quiet) {
      console.log(`  ${warn(`Port ${outcome.preferred} is in use${configured.explicit ? '' : ', and so are the nine after it'}.`)}`);
      console.log(`  ${dim(`Free it, or set WEB_CONSOLE_PORT in ${YOS_DIR}/.env to a port that is free, then run: yos restart`)}`);
    }
    return outcome.preferred;
  }

  if (outcome.moved) {
    writeConsolePort(outcome.port);
    if (!quiet) {
      console.log(`  ${warn(`Port ${outcome.preferred} is in use — the web console will use ${outcome.port} instead.`)}`);
      console.log(`  ${dim(`Recorded as WEB_CONSOLE_PORT in ${YOS_DIR}/.env`)}`);
    }
  } else if (configured.explicit) {
    writeConsolePort(outcome.port);
  }

  return outcome.port;
}

function ensureWebConsolePassword(explicitPassword = null) {
  const envPath = path.join(YOS_DIR, '.env');
  const newKey = 'YOS_WEB_PASSWORD';
  const oldKey = 'WEB_CONSOLE_PASSWORD';

  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { return ''; }

  // Explicit password from flag/env: write it
  if (explicitPassword) {
    if (content.match(new RegExp(`^${newKey}=.*$`, 'm'))) {
      content = content.replace(new RegExp(`^${newKey}=.*$`, 'm'), `${newKey}=${explicitPassword}`);
    } else if (content.match(new RegExp(`^${oldKey}=.*$`, 'm'))) {
      content = content.replace(new RegExp(`^${oldKey}=.*$`, 'm'), `${newKey}=${explicitPassword}`);
    } else {
      content = content.trimEnd() + `\n# Web Console password\n${newKey}=${explicitPassword}\n`;
    }
    fs.writeFileSync(envPath, content);
    return explicitPassword;
  }

  // Check new name first, then legacy
  const matchNew = content.match(new RegExp(`^${newKey}=(.+)`, 'm'));
  if (matchNew) return matchNew[1].trim();

  const matchOld = content.match(new RegExp(`^${oldKey}=(.+)`, 'm'));
  if (matchOld) return matchOld[1].trim();

  // Generate new password
  const password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const entry = `\n# Web Console password\n${newKey}=${password}\n`;
  fs.writeFileSync(envPath, content.trimEnd() + entry);
  return password;
}

/**
 * Migrate WEB_CONSOLE_PASSWORD → YOS_WEB_PASSWORD in .env.
 * If old name found and new name not present, rename in-place.
 */

/**
 * Ensure new-session threshold defaults are explicitly set in config.json.
 * Idempotent — only writes keys that are missing.
 */
function ensureNewSessionThresholdDefaults() {
  const config = getYosConfig();
  const updates = {};
  if (config.new_session_threshold === undefined) updates.new_session_threshold = 70;
  if (config.codex_new_session_threshold === undefined) updates.codex_new_session_threshold = 75;
  if (Object.keys(updates).length > 0) updateYosConfig(updates);
}

export function seedFreshInstallNewSessionThresholdDefault({
  config = getYosConfig(),
  updateConfig = updateYosConfig,
} = {}) {
  if (config.new_session_threshold !== undefined) return false;
  updateConfig({ new_session_threshold: 30 });
  return true;
}

function migrateWebConsolePassword() {
  const envPath = path.join(YOS_DIR, '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { return; }

  const hasOld = /^WEB_CONSOLE_PASSWORD=(.+)$/m.test(content);
  const hasNew = /^YOS_WEB_PASSWORD=/m.test(content);

  if (hasOld && !hasNew) {
    content = content.replace(/^WEB_CONSOLE_PASSWORD=/m, 'YOS_WEB_PASSWORD=');
    // Update comment if present
    content = content.replace(/^# Web Console password \(auto-generated\)$/m, '# Web Console password');
    fs.writeFileSync(envPath, content);
  }
}

/**
 * Get the first non-loopback IPv4 address (for display purposes).
 * @returns {string} IP address or empty string if none found
 */
function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '';
}

/**
 * Print web console access info (URL + password).
 * Called at the end of init to show the user how to access.
 * Displayed prominently so the user doesn't miss the password.
 * Always shown even in quiet mode (essential output).
 */
/**
 * Print a yellow warning box, padding each line to the box width.
 * Long lines are truncated rather than allowed to break the border.
 *
 * @param {string[]} lines - Content lines (no borders, no padding)
 */
function printWarningBox(lines) {
  const WIDTH = 56;
  const bar = '─'.repeat(WIDTH);
  const row = (text) => {
    const clipped = text.slice(0, WIDTH - 4);
    return yellow(`  │  ${clipped}${' '.repeat(WIDTH - 2 - clipped.length)}│`);
  };
  console.log('');
  console.log(yellow(`  ┌${bar}┐`));
  console.log(yellow(`  │${' '.repeat(WIDTH)}│`));
  for (const line of lines) console.log(row(line));
  console.log(yellow(`  │${' '.repeat(WIDTH)}│`));
  console.log(yellow(`  └${bar}┘`));
  console.log('');
}

function printWebConsoleInfo() {
  const config = getYosConfig();

  const envPath = path.join(YOS_DIR, '.env');
  let password = '';
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    // Read new name first, fall back to legacy
    const matchNew = content.match(/^YOS_WEB_PASSWORD=(.+)/m);
    const matchOld = content.match(/^WEB_CONSOLE_PASSWORD=(.+)/m);
    if (matchNew) password = matchNew[1].trim();
    else if (matchOld) password = matchOld[1].trim();
  } catch { /* */ }

  if (!password) return;

  const line = cyan('  ════════════════════════════════════════════════════');

  console.log('');
  console.log(line);
  console.log('');
  console.log(`  ${bold('  Web Console')}`);
  console.log('');

  if (config.domain) {
    const proto = config.protocol || 'https';
    const url = `${proto}://${config.domain}/console/`;
    console.log(`    URL:      ${bold(url)}`);
  } else {
    const port = readRecordedConsolePort();
    console.log(`    Local:    ${bold(`http://localhost:${port}/`)}`);
    const ip = getNetworkIP();
    if (ip) {
      console.log(`    Network:  ${bold(`http://${ip}:${port}/`)}`);
    }
  }

  console.log(`    Password: ${bgGreen(bold(` ${password} `))}`);
  console.log('');
  console.log(`    ${dim(`Save this password — also in ${YOS_DIR}/.env`)}`);
  console.log('');
  console.log(line);
}

// ── Database initialization ─────────────────────────────────────

/**
 * Initialize databases for skills that require them.
 */
function initializeDatabases() {
  const dbInitScript = path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-db.js');
  const dbInitSql = path.join(SKILLS_DIR, 'comm-bridge', 'init-db.sql');
  if (!fs.existsSync(dbInitSql) || !fs.existsSync(dbInitScript)) return;

  try {
    execSync(`node "${dbInitScript}" init`, {
      cwd: path.join(SKILLS_DIR, 'comm-bridge'),
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log(`  ${success('Database initialized')}`);
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
    console.log(`  ${warn(`Database init failed: ${msg}`)}`);
  }
}

// ── Service startup ─────────────────────────────────────────────

/**
 * Prepare and start core services via PM2 ecosystem config.
 *
 * Returns the failures as well as the count. Reporting only the number that
 * started let `yos init` print "3 service(s) started", "initialized
 * successfully" and a console URL on a machine where the console was crash
 * looping on a port already in use — the same defect as saying a component
 * installed when its service could not run.
 *
 * @returns {{ started: number, failed: Array<{name: string, status: string}> }}
 */
function startCoreServices(webPassword = null) {
  installSkillDependencies();
  ensureWebConsolePassword(webPassword);
  initializeDatabases();

  const ecosystemPath = path.join(YOS_DIR, 'pm2', 'ecosystem.config.cjs');
  if (!fs.existsSync(ecosystemPath)) {
    console.log(`  ${warn('ecosystem.config.cjs not found')}`);
    return { started: 0, failed: [] };
  }

  try {
    // Delete existing core services first so PM2 fully re-evaluates ecosystem config
    // (--update-env does NOT re-execute the JS, so env changes like SYSTEM_PATH won't apply)
    const serviceNames = getCoreServiceNames();
    for (const name of serviceNames) {
      try { execSync(`pm2 delete "${name}"`, { stdio: 'pipe' }); } catch {}
    }
    execSync(`pm2 start "${ecosystemPath}"`, { stdio: 'pipe', timeout: 30000 });
    execSync('pm2 save', { stdio: 'pipe' });
  } catch (err) {
    console.log(`  ${warn(`Failed to start services: ${err.message}`)}`);
    return { started: 0, failed: [] };
  }

  // Report what the services are actually doing, not what they were doing the
  // instant pm2 accepted them.
  //
  // A snapshot right after `pm2 start` is worthless: a service that cannot bind
  // its port is still `online` for the first moment, so init used to print a ✓
  // for a web console that spent the next minute crash looping on EADDRINUSE.
  // Restarts gained over a short window is the signal that separates the two.
  try {
    const serviceNames = getCoreServiceNames();
    const before = new Map(serviceNames.map(name => [name, readServiceState(name)]));
    const settleMs = Number(process.env.YOS_SERVICE_SETTLE_MS) || 6000;
    execSync(`sleep ${Math.max(1, Math.round(settleMs / 1000))}`, { stdio: 'pipe' });

    let started = 0;
    const failed = [];
    for (const name of serviceNames) {
      const after = readServiceState(name);
      if (!after) continue;   // not defined on this machine
      const verdict = judgeSettle(before.get(name), after);
      if (verdict.success) {
        console.log(`  ${success(bold(name))}`);
        started++;
      } else {
        console.log(`  ${error(`${bold(name)}: ${verdict.error}`)}`);
        failed.push({ name, status: after.status, reason: verdict.error });
      }
    }
    return { started, failed };
  } catch {
    return { started: 0, failed: [] };
  }
}

/**
 * Say out loud that init did not finish clean, and how to look.
 *
 * @returns {number} exit code contribution: 1 when something is not running
 */
function reportServiceOutcome(outcome, { quiet = false } = {}) {
  const failed = outcome?.failed ?? [];
  if (failed.length === 0) return 0;
  if (!quiet) {
    const names = failed.map((service) => service.name).join(', ');
    console.log(`\n${warn(`${failed.length} service(s) did not start: ${names}`)}`);
    console.log(`  ${dim('Look at why with:')} ${dim(`pm2 logs ${failed[0].name} --err --lines 20`)}`);
    console.log(`  ${dim('Then: yos restart')}`);
  }
  return 1;
}

// ── PM2 boot auto-start ──────────────────────────────────────────

/**
 * Find the absolute path of the pm2 binary.
 */
function findPm2Binary() {
  // Check adjacent to the current node binary first (most reliable for nvm setups)
  const adjacent = path.join(path.dirname(process.execPath), 'pm2');
  try {
    fs.accessSync(adjacent, fs.constants.X_OK);
    return adjacent;
  } catch {
    // Fall through
  }
  // Search PATH
  const result = spawnSync('which', ['pm2'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return 'pm2';
}

/**
 * Build a systemd unit that starts PM2 in foreground mode (Type=simple).
 * This is more reliable than the unit generated by `pm2 startup`, which uses
 * PIDFile-based tracking and can fail on reboot when stale pid files exist.
 */
function buildPm2SystemdUnit(user, home, pm2Path) {
  const pm2Home = path.join(home, '.pm2');
  const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  return `[Unit]
Description=PM2 process manager for ${user}
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=simple
User=${user}
Environment=PATH=${currentPath}
Environment=PM2_HOME=${pm2Home}
Environment=HOME=${home}
ExecStart=${pm2Path} resurrect --no-daemon
ExecReload=${pm2Path} reload all
ExecStop=${pm2Path} kill
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Fallback: use `pm2 startup` for platforms without systemd (macOS, etc.).
 * On macOS this generates a launchd plist which is reliable.
 */
function setupPm2StartupViaCommand() {
  const result = spawnSync('pm2', ['startup'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15000,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

  const sudoMatch = output.match(/^(sudo .+)$/m);
  if (sudoMatch) {
    const sudoResult = spawnSync('sh', ['-c', sudoMatch[1]], {
      stdio: 'inherit',
      timeout: 60000,
    });
    if (sudoResult.status === 0) {
      console.log(`  ${success('PM2 boot auto-start configured')}`);
    } else {
      setupBootAutostartWithoutRoot('`pm2 startup` needs an administrator and sudo did not complete');
    }
    return;
  }

  if (result.status === 0) {
    console.log(`  ${success('PM2 boot auto-start configured')}`);
  } else {
    const msg = output.trim().split('\n')[0] || 'unknown error';
    setupBootAutostartWithoutRoot(`\`pm2 startup\` failed: ${msg}`);
  }
}

/**
 * Last resort when no privileged boot hook could be installed: a user crontab
 * `@reboot` entry, which a non-root account owns outright.
 *
 * Says plainly what is and is not true. The message that used to print here
 * called a missing boot hook optional and claimed nothing was lost by it. That
 * was false: without a boot hook the machine comes back from a reboot with every
 * service down and no notice to anyone.
 *
 * @param {string} why - What failed before we got here, for the log line
 */
function setupBootAutostartWithoutRoot(why) {
  const result = installRebootCrontab({
    pm2Path: findPm2Binary(),
    home: os.homedir(),
    logPath: path.join(YOS_DIR, 'pm2', 'reboot.log'),
  });

  if (result.ok) {
    console.log(`  ${success('Boot auto-start configured via your user crontab (no root needed)')}`);
    console.log(`    ${dim(`${why} — used @reboot instead, which needs no privileges.`)}`);
    console.log(`    ${dim('Check it any time with: crontab -l')}`);
    return;
  }

  // Nothing is in place. Do not call that "optional".
  console.log(`  ${warn('No boot auto-start is in place — after a reboot the services will NOT come back.')}`);
  console.log(`    ${dim(`${why}; the crontab fallback also failed: ${result.reason}.`)}`);
  console.log(`    ${cyan('To bring them back after a reboot:')} ${bold('pm2 resurrect')}`);
  console.log(`    ${cyan('To fix it for good, either:')}`);
  console.log(`      ${bold('pm2 startup')} ${dim('(then run the sudo command it prints — needs an administrator)')}`);
  console.log(`      ${dim('or ask an administrator for: ')}${bold(`loginctl enable-linger ${os.userInfo().username}`)}`);
}

/**
 * Report PM2 processes that this install did not start.
 *
 * TD-21: a machine reinstalled by wiping the home directory left three PM2 God
 * Daemons running, still holding the Web Console port, and init had no idea —
 * it never looked for a PM2 process it had not started, so the failure surfaced
 * later as an unexplained port conflict.
 *
 * Deliberately read-only. The processes belong to the account, a reinstall is
 * the worst moment to guess wrong, and killing something an operator runs on
 * purpose is not recoverable from a log line. So this states what is there and
 * hands over the exact command; the decision stays with the person.
 */
function reportPm2Leftovers({ quiet = false } = {}) {
  let read;
  try {
    const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8', stdio: 'pipe', timeout: 20000 });
    read = parseJlist(result.stdout);
  } catch {
    read = { ok: false, processes: [] };
  }

  if (!read.ok) {
    // "Could not tell" is not "nothing there" — saying the machine is clean on
    // the strength of an unreadable answer is the failure mode this codebase
    // keeps rediscovering, so say which one this is.
    if (!quiet) console.log(`  ${dim('Could not read the PM2 process list — skipped the leftover check.')}`);
    return;
  }

  const classified = classifyLeftovers({
    processes: read.processes,
    yosDir: YOS_DIR,
    exists: (p) => fs.existsSync(p),
  });
  const described = describeLeftovers(classified);
  if (!described) {
    if (!quiet) console.log(`  ${success('No PM2 processes from a previous install')}`);
    return;
  }

  // Always shown, quiet or not: it changes what the rest of this run means.
  console.log(`  ${warn(described.headline)}`);
  for (const line of described.details) console.log(`    ${dim(line)}`);
  console.log(`    ${cyan('This install will not stop them. To clear them yourself:')} ${bold(described.command)}`);
  if (classified.stale.length > 0) {
    console.log(`    ${dim('Until then they keep holding whatever ports they bound, which can make this install fail to start its own services.')}`);
  }
}

/**
 * Configure PM2 to auto-start on system boot.
 * - Linux with systemd: generates a stable unit directly (avoids PIDFile issues)
 * - Other platforms (macOS, etc.): falls back to `pm2 startup`
 * - No privileges anywhere: falls back to a user crontab `@reboot` entry
 */
function setupPm2Startup() {
  if (process.platform !== 'linux' || !commandExists('systemctl')) {
    setupPm2StartupViaCommand();
    return;
  }

  const user = os.userInfo().username;
  const home = os.homedir();
  const unitName = `pm2-${user}.service`;
  const unitPath = `/etc/systemd/system/${unitName}`;
  const tempUnitPath = path.join(YOS_DIR, `${unitName}.tmp`);

  try {
    const pm2Path = findPm2Binary();
    const unitContent = buildPm2SystemdUnit(user, home, pm2Path);

    // TD-10: this used to install the unit unconditionally. See
    // ../lib/pm2-unit-guard.js for the shared-host reboot it cost us.
    let existingUnit = null;
    try {
      existingUnit = fs.readFileSync(unitPath, 'utf8');
    } catch {
      existingUnit = null; // absent, or unreadable — treated the same: nothing to preserve
    }

    const decision = classifyUnitWrite({
      existing: existingUnit,
      next: unitContent,
      isolation: looksIsolated({ home, env: process.env, pm2Path, tmpDir: os.tmpdir() }),
      skipRequested: Boolean(process.env.YOS_SKIP_SYSTEMD),
    });

    if (decision.action === 'skip-isolated' || decision.action === 'skip-requested') {
      // No crontab fallback here on purpose: a user crontab belongs to the real
      // account regardless of which HOME this process was given, so writing a
      // @reboot line pointing into a sandbox is the same hijack by another road.
      console.log(`  ${warn('Skipped configuring boot auto-start for this machine.')}`);
      console.log(`    ${dim(`Reason: ${decision.reason}.`)}`);
      console.log(`    ${dim('Nothing on this machine was changed — no unit written, no crontab touched.')}`);
      return;
    }

    if (decision.action === 'skip-identical') {
      console.log(`  ${success(`PM2 boot auto-start already configured (${unitName})`)}`);
      console.log(`    ${dim(`Unit: ${unitPath} — identical to what this install would write, left alone.`)}`);
      warnIfForeignCgroup();
      return;
    }

    fs.writeFileSync(tempUnitPath, unitContent, 'utf8');

    const steps = [];
    if (decision.action === 'backup-then-write') {
      const backup = backupUnitPath(unitPath, new Date().toISOString());
      steps.push(['install', '-m', '0644', unitPath, backup]);
      console.log(`  ${warn('A different PM2 boot unit is already installed — backing it up before replacing it.')}`);
      for (const change of decision.changes) {
        console.log(`    ${dim(`${change.key}: ${change.from ?? '(absent)'} → ${change.to ?? '(absent)'}`)}`);
      }
      console.log(`    ${dim(`Backup: ${backup}`)}`);
    }
    steps.push(
      ['install', '-m', '0644', tempUnitPath, unitPath],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', unitName],
    );

    for (const args of steps) {
      const result = spawnSync('sudo', args, {
        stdio: 'inherit',
        timeout: 60000,
      });
      if (result.status !== 0) {
        setupBootAutostartWithoutRoot('The systemd route needs an administrator and sudo did not complete');
        return;
      }
    }

    console.log(`  ${success(`PM2 boot auto-start configured (${unitName})`)}`);
    console.log(`    ${dim(`Unit: ${unitPath}`)}`);
    warnIfForeignCgroup();
  } catch (err) {
    setupBootAutostartWithoutRoot(`The systemd route failed: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tempUnitPath); } catch { /* ignore */ }
  }
}

/**
 * Warn if the PM2 daemon is running inside another service's cgroup.
 * This happens when yos init is called from a systemd service — PM2
 * inherits the caller's cgroup instead of running under pm2-<user>.service.
 */
function warnIfForeignCgroup() {
  if (process.platform !== 'linux') return;

  try {
    const pidFile = path.join(os.homedir(), '.pm2', 'pm2.pid');
    if (!fs.existsSync(pidFile)) return;
    const pm2Pid = fs.readFileSync(pidFile, 'utf8').trim();
    if (!pm2Pid) return;

    const cgroupPath = `/proc/${pm2Pid}/cgroup`;
    if (!fs.existsSync(cgroupPath)) return;
    const cgroup = fs.readFileSync(cgroupPath, 'utf8').trim();

    const user = os.userInfo().username;
    const expectedUnit = `pm2-${user}.service`;

    // If PM2 is in its own systemd unit or in user scope, it's fine
    if (cgroup.includes(expectedUnit)) return;

    // If running in a Docker container (no systemd), skip
    if (fs.existsSync('/.dockerenv')) return;

    // PM2 daemon is in a foreign cgroup — warn
    // Extract the service name from the cgroup path for a clear message
    // cgroup v2: single line "0::/system.slice/foo.service"
    // cgroup v1: multiple lines "12:pids:/system.slice/foo.service\n..."
    const serviceMatch = cgroup.match(/\/([^/\n]+\.service)/);
    const foreignService = serviceMatch ? serviceMatch[1] : null;

    if (foreignService) {
      console.log(`  ${warn(`PM2 daemon is running inside ${bold(foreignService)}'s cgroup.`)}`);
    } else {
      console.log(`  ${warn('PM2 daemon is not running under its own systemd unit.')}`);
    }
    console.log(`    If ${foreignService || 'that service'} is restarted, PM2 will be killed.`);
    console.log(`    ${cyan('Reboot to let PM2 start under')} ${bold(expectedUnit)}.`);
  } catch {
    // Best-effort check — don't fail init if we can't read cgroup info
  }
}

// ── Caddy web server setup ───────────────────────────────────────

/**
 * Detect system architecture for Caddy binary download.
 * @returns {{ os: string, arch: string }}
 */
function detectPlatform() {
  const platform = process.platform === 'darwin' ? 'mac' : 'linux';
  const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' };
  const arch = archMap[process.arch] || 'amd64';
  return { os: platform, arch };
}

/**
 * Get the latest Caddy version from GitHub API.
 * Falls back to a known stable version on failure.
 * @returns {string} Version string without 'v' prefix (e.g. "2.10.2")
 */
function getLatestCaddyVersion() {
  const FALLBACK_VERSION = '2.10.2';
  // Our mirror first: on a machine that cannot reach GitHub the API call below
  // burns 15s per install and then silently pins whatever this file happened to
  // hard-code, which is how an installer quietly drifts years behind.
  const mirrorUrl = distVendorUrl('caddy/latest.json');
  if (mirrorUrl) {
    try {
      const output = execFileSync('curl', ['-fsSL', mirrorUrl], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
      });
      const version = (JSON.parse(output).tag_name || '').replace(/^v/, '');
      if (version) return version;
    } catch { /* fall through to GitHub */ }
  }
  try {
    const output = execSync(
      'curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 }
    );
    const data = JSON.parse(output);
    return (data.tag_name || '').replace(/^v/, '') || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * Download Caddy binary to ~/yos/bin/caddy.
 * @returns {boolean} true if download succeeded
 */
function downloadCaddy() {
  if (fs.existsSync(CADDY_BIN)) {
    console.log(`  ${success('Caddy binary already installed')}`);
    return true;
  }

  const { os: platform, arch } = detectPlatform();
  console.log(`  ${dim(`Detecting platform: ${platform}/${arch}`)}`);

  const version = getLatestCaddyVersion();
  console.log(`  ${dim(`Latest Caddy version: v${version}`)}`);

  const filename = `caddy_${version}_${platform}_${arch}.tar.gz`;
  const githubUrl = `https://github.com/caddyserver/caddy/releases/download/v${version}/${filename}`;
  const mirrorUrl = distVendorUrl(`caddy/v${version}/${filename}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-caddy-'));
  const tarballPath = path.join(tmpDir, filename);

  try {
    console.log(`  ${cyan('Downloading Caddy...')}`);
    // Mirror first, GitHub second: --https must not depend on GitHub being up.
    let downloaded = false;
    if (mirrorUrl) {
      try {
        execFileSync('curl', ['-fsSL', '-o', tarballPath, mirrorUrl], {
          stdio: 'pipe',
          timeout: 120000,
        });
        downloaded = true;
      } catch (err) {
        noteMirrorFallback('vendor', `caddy v${version} (${platform}/${arch})`, err);
      }
    }
    if (!downloaded) {
      execFileSync('curl', ['-fsSL', '-o', tarballPath, githubUrl], {
        stdio: 'pipe',
        timeout: 120000,
      });
    }

    // Extract just the caddy binary
    execSync(`tar xzf "${tarballPath}" -C "${tmpDir}" caddy`, {
      stdio: 'pipe',
      timeout: 30000,
    });

    // Move to bin directory
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.copyFileSync(path.join(tmpDir, 'caddy'), CADDY_BIN);
    fs.chmodSync(CADDY_BIN, 0o755);

    console.log(`  ${success(`Caddy v${version} installed to ~/yos/bin/caddy`)}`);
    return true;
  } catch (err) {
    console.log(`  ${warn(`Failed to download Caddy: ${err.message}`)}`);
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Set CAP_NET_BIND_SERVICE on Caddy binary so it can bind to ports 80/443
 * without running as root. Requires one-time sudo.
 * @returns {boolean} true if setcap succeeded
 */
function setCaddyCapabilities() {
  if (process.platform === 'darwin') return true; // macOS doesn't need this
  if (process.getuid?.() === 0) return true; // root already has all capabilities

  try {
    // Check if capability is already set
    const caps = execSync(`getcap "${CADDY_BIN}" 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (caps.includes('cap_net_bind_service')) {
      return true;
    }
  } catch { /* continue */ }

  try {
    execSync(`sudo setcap cap_net_bind_service=+ep "${CADDY_BIN}"`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log(`  ${success('Port binding capability set (ports 80/443)')}`);
    return true;
  } catch {
    console.log(`  ${warn('Could not set port binding capability (sudo required)')}`);
    console.log(`    ${dim('Caddy may not be able to bind to ports 80/443.')}`);
    console.log(`    ${dim(`Fix manually: sudo setcap cap_net_bind_service=+ep "${CADDY_BIN}"`)}`);
    return false;
  }
}

/**
 * Default HTTP port for local address mode (high port, no setcap needed).
 */
const LOCAL_HTTP_PORT = 3800;

/**
 * Check if a domain/address is a local or private address.
 * @param {string} addr - Domain or IP address
 * @returns {boolean}
 */
export function isLocalAddress(addr) {
  const a = addr.trim().toLowerCase();
  if (a === 'localhost' || a === 'localhost.') return true;
  // 0.0.0.0 (bind-all, not routable)
  if (a === '0.0.0.0') return true;
  // 127.x.x.x loopback
  if (/^127\./.test(a)) return true;
  // Private IPv4 ranges
  if (/^10\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  // IPv6 loopback
  if (a === '::1') return true;
  // IPv4-mapped IPv6 loopback
  if (a === '::ffff:127.0.0.1') return true;
  // IPv6 link-local (fe80::) and unique local (fc00::/7 → fc00:: and fd00::)
  if (/^fe80:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a)) return true;
  return false;
}

/**
 * Generate a Caddyfile for the given domain and protocol.
 * @param {string} domain - The domain name
 * @param {string} [protocol='https'] - 'https' (bare domain, auto-cert) or 'http'
 * @param {number} [port] - Optional port override (used for local addresses)
 */
function generateCaddyfile(domain, protocol = 'https', port) {
  const publicDir = path.join(HTTP_DIR, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  // Caddy syntax: bare domain = HTTPS + auto-cert, http:// prefix = HTTP only
  // For local addresses, bind to a specific port to avoid occupying 80/443
  let siteAddress;
  if (port != null) {
    siteAddress = `http://${domain}:${port}`;
  } else {
    siteAddress = protocol === 'http' ? `http://${domain}` : domain;
  }

  const content = `# YOS Caddyfile — managed by yos-core
# Domain: ${domain}
# Protocol: ${protocol}

${siteAddress} {
    root * ${publicDir}

    file_server {
        hide .git .env *.db *.json
    }

    @markdown path *.md
    handle @markdown {
        header Content-Type "text/plain; charset=utf-8"
    }

    handle /health {
        respond "OK" 200
    }

    # Web Console (core built-in)
    redir /console /console/ permanent
    handle /console/* {
        uri strip_prefix /console
        reverse_proxy localhost:${readRecordedConsolePort()}
    }

    log {
        output file ${HTTP_DIR}/caddy-access.log {
            roll_size 10mb
            roll_keep 3
        }
    }
}
`;

  fs.writeFileSync(CADDYFILE, content);
}

/**
 * Run the Caddy setup flow: download binary, prompt for domain,
 * generate Caddyfile, set capabilities.
 * @param {boolean} skipConfirm - Skip interactive prompts
 * @param {object} opts - Resolved CLI options
 * @returns {Promise<boolean>} true if Caddy was set up
 */
async function setupCaddy(skipConfirm, opts = {}) {
  const quiet = opts.quiet;

  // --no-caddy: skip entirely
  if (opts.caddy === false) {
    if (!quiet) console.log(`  ${dim('Caddy setup skipped (--no-caddy).')}`);
    return true; // not a failure, just skipped
  }

  // Check if already fully set up (and no override flags)
  if (fs.existsSync(CADDY_BIN) && fs.existsSync(CADDYFILE) && !opts.domain) {
    const config = getYosConfig();
    if (config.domain) {
      const proto = config.protocol || 'https';
      if (!quiet) console.log(`  ${success(`Caddy already configured (${bold(`${proto}://${config.domain}`)})`)}`);
      return true;
    }
  }

  // Ask user if they want Caddy (skip prompt if --caddy, domain, or -y)
  if (!skipConfirm && opts.caddy !== true && !opts.domain) {
    const wantCaddy = await promptYesNo('Set up Caddy web server? [Y/n]: ', true);
    if (!wantCaddy) {
      if (!quiet) console.log(`  ${dim('Skipping Caddy setup. Run "yos init" later to set up.')}`);
      return false;
    }
  }

  // Resolve domain: CLI/env > existing config > interactive prompt
  const config = getYosConfig();
  let domain = opts.domain || config.domain || '';
  if (!domain || domain === 'your.domain.com') {
    if (!skipConfirm) {
      domain = await prompt(
        'Enter your domain for HTTPS access (e.g., yos.example.com),\n'
        + '  or leave empty for local-only access: '
      );
    }
    if (!domain) {
      if (opts.caddy === true) {
        // --caddy without domain: install binary but skip Caddyfile
        if (!quiet) console.log(`  ${dim('No domain provided. Installing Caddy binary only.')}`);
        if (!downloadCaddy()) return false;
        setCaddyCapabilities();
        return true;
      }
      if (!quiet) console.log(`  ${warn('No domain provided. Skipping Caddy setup.')}`);
      return false;
    }
  }

  // Detect local addresses: localhost, 127.x.x.x, private IPs
  const isLocal = isLocalAddress(domain);

  // Resolve protocol: CLI/env > existing config > prompt > default
  let protocol;
  let localPort;
  if (isLocal) {
    // Local addresses: force HTTP on a high port, skip HTTPS prompt
    protocol = 'http';
    localPort = LOCAL_HTTP_PORT;
    if (!quiet) console.log(`  ${dim(`Local address detected — using HTTP on port ${LOCAL_HTTP_PORT} (no HTTPS certificate needed).`)}`);
  } else {
    if (opts.https === true) protocol = 'https';
    else if (opts.https === false) protocol = 'http';
    else protocol = config.protocol || '';

    if (!protocol && !skipConfirm) {
      const useHttps = await promptYesNo('Use HTTPS with auto-certificate? [Y/n]: ', true);
      protocol = useHttps ? 'https' : 'http';
    }
    if (!protocol) protocol = 'https';
  }

  // Save domain and protocol to config.json
  updateYosConfig({ domain, protocol, ...(localPort != null ? { port: localPort } : {}) });
  if (!quiet) {
    if (localPort) {
      console.log(`  ${dim('Address:')} ${bold(`http://${domain}:${localPort}`)}`);
    } else {
      console.log(`  ${dim('Domain:')} ${bold(domain)}`);
      console.log(`  ${dim('Protocol:')} ${bold(protocol)}`);
    }
  }

  // Download Caddy binary
  if (!downloadCaddy()) return false;

  // Set capabilities for port binding (only needed for ports < 1024)
  if (!localPort) {
    setCaddyCapabilities();
  }

  // Generate Caddyfile
  fs.mkdirSync(HTTP_DIR, { recursive: true });
  generateCaddyfile(domain, protocol, localPort);
  if (!quiet) console.log(`  ${success('Caddyfile generated at ~/yos/http/Caddyfile')}`);

  return true;
}

// ── CLI flag parsing & validation ────────────────────────────────

/**
 * Parse CLI flags for `yos init`.
 * Supports long flags, short flags, and combined short flags (e.g., -yq).
 *
 * @param {string[]} args - CLI arguments (after command name)
 * @returns {object} Parsed options
 */
export function parseInitFlags(args) {
  const opts = {
    yes: false,
    quiet: false,
    help: false,
    skipConsent: false,
    timezone: null,
    runtime: null,  // 'claude' | 'codex' — set via --runtime flag
    setupToken: null,
    apiKey: null,
    codexApiKey: null,
    baseUrl: null,
    codexBaseUrl: null,
    domain: null,
    https: null,   // null = not specified, true = --https, false = --no-https
    caddy: null,   // null = not specified, true = --caddy, false = --no-caddy
    webPassword: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Combined short flags (e.g., -yq → -y + -q)
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2) {
      for (const ch of arg.slice(1)) {
        if (ch === 'y') opts.yes = true;
        else if (ch === 'q') opts.quiet = true;
        else if (ch === 'h') opts.help = true;
      }
      continue;
    }

    switch (arg) {
      case '--yes': case '-y': opts.yes = true; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--timezone':
      case '--runtime':
      case '--setup-token':
      case '--api-key':
      case '--codex-api-key':
      case '--base-url':
      case '--codex-base-url':
      case '--domain':
      case '--web-password': {
        const val = args[++i];
        if (!val || val.startsWith('-')) {
          console.error(`${error(`Error: ${arg} requires a value`)}`);
          process.exit(1);
        }
        if (arg === '--timezone') opts.timezone = val;
        else if (arg === '--runtime') opts.runtime = val;
        else if (arg === '--setup-token') opts.setupToken = val;
        else if (arg === '--api-key') opts.apiKey = val;
        else if (arg === '--codex-api-key') opts.codexApiKey = val;
        else if (arg === '--base-url') opts.baseUrl = val;
        else if (arg === '--codex-base-url') opts.codexBaseUrl = val;
        else if (arg === '--domain') opts.domain = val;
        else if (arg === '--web-password') opts.webPassword = val;
        break;
      }
      case '--https': opts.https = true; break;
      case '--no-https': opts.https = false; break;
      case '--caddy': opts.caddy = true; break;
      case '--no-caddy': opts.caddy = false; break;
      case '--skip-consent': opts.skipConsent = true; break;
    }
  }

  return opts;
}

/**
 * Fill in options from environment variables where CLI flags were not provided.
 * Resolution: CLI flag > env var > existing config > interactive prompt.
 *
 * @param {object} opts - Parsed CLI options (mutated in place)
 */
/**
 * Read credentials yos previously stored in ~/yos/.env.
 *
 * Missing or unreadable file is not an error — it just means nothing is stored.
 *
 * @returns {{setupToken: string, apiKey: string, codexApiKey: string}}
 */
export function readStoredCredentials(readEnv = readEnvFile) {
  try {
    const env = readEnv();
    return {
      setupToken: env.get('CLAUDE_CODE_OAUTH_TOKEN') || '',
      apiKey: env.get('ANTHROPIC_API_KEY') || '',
      codexApiKey: env.get('OPENAI_API_KEY') || env.get('CODEX_API_KEY') || '',
    };
  } catch {
    return { setupToken: '', apiKey: '', codexApiKey: '' };
  }
}

export function resolveFromEnv(opts) {
  // Only promote auth tokens from env when:
  // 1. Not already authenticated (avoids redundant re-verification)
  // 2. No auth token was provided via CLI flag (avoids false mutual-exclusion
  //    errors when e.g. --setup-token is on CLI but ANTHROPIC_API_KEY is in env)
  const alreadyAuthed = commandExists('claude') && isClaudeAuthenticated();
  const hasCliAuth = opts.setupToken !== null || opts.apiKey !== null;
  if (!alreadyAuthed && !hasCliAuth) {
    // Also read the credential yos itself stores in ~/yos/.env. Every other
    // part of the product reads that file — the runtime adapter injects it at
    // launch, doctor checks against it — and init was the one component that
    // did not, so a key written there was ignored and the user was told to
    // supply a key they had already supplied.
    const stored = readStoredCredentials();
    // Setup token takes priority over API key when both are available.
    const setupToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || stored.setupToken;
    const apiKey = process.env.ANTHROPIC_API_KEY || stored.apiKey;
    if (setupToken) {
      opts.setupToken = setupToken;
    } else if (apiKey) {
      opts.apiKey = apiKey;
    }
  }
  if (opts.runtime === null && process.env.YOS_RUNTIME) {
    opts.runtime = process.env.YOS_RUNTIME;
  }
  if (opts.domain === null && process.env.YOS_DOMAIN) {
    opts.domain = process.env.YOS_DOMAIN;
  }
  if (opts.https === null && process.env.YOS_PROTOCOL) {
    opts.https = process.env.YOS_PROTOCOL === 'https';
  }
  if (opts.webPassword === null) {
    opts.webPassword = process.env.YOS_WEB_PASSWORD || process.env.WEB_CONSOLE_PASSWORD || null;
  }
  if (opts.codexApiKey === null) {
    opts.codexApiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY
      || readStoredCredentials().codexApiKey || null;
  }
  if (opts.baseUrl === null && process.env.ANTHROPIC_BASE_URL) {
    opts.baseUrl = process.env.ANTHROPIC_BASE_URL;
  }
  if (opts.codexBaseUrl === null && process.env.OPENAI_BASE_URL) {
    opts.codexBaseUrl = process.env.OPENAI_BASE_URL;
  }
  // TZ: do NOT pick up ambient TZ from the environment.
  // Docker containers often have TZ=UTC set by default, which would silently
  // overwrite user-configured timezones on re-init. Only --timezone flag applies.
  // The auto-detect in configureTimezone() will handle the default case.
}

export function validateInitOptions(opts) {
  // Mutual exclusion: setup-token and api-key
  if (opts.setupToken && opts.apiKey) {
    return '--setup-token and --api-key are mutually exclusive.\n  Run yos init and choose one during setup.';
  }

  // Setup token format
  if (opts.setupToken && !opts.setupToken.startsWith('sk-ant-oat')) {
    return 'Invalid setup token. It should start with "sk-ant-oat".\n  Generate one with: claude setup-token\n  Then run: yos init --setup-token <token>';
  }

  // API key format (reject setup tokens — they start with sk-ant-oat).
  // Name the mismatch when the key is recognisably another vendor's: "should
  // start with sk-ant-" sends someone hunting for a typo when what they
  // actually did was hand the Claude runtime an OpenAI key.
  if (opts.apiKey && !opts.apiKey.startsWith('sk-ant-')) {
    if (opts.apiKey.startsWith('sk-')) {
      return 'That looks like an OpenAI key, but this is the Claude runtime.\n'
        + '  Anthropic keys start with "sk-ant-"; OpenAI keys start with "sk-".\n'
        + '  For an OpenAI key, install the Codex runtime instead:\n'
        + '    yos init --runtime codex --codex-api-key <key>';
    }
    return 'Invalid API key. It should start with "sk-ant-".\n  Get your key at: https://console.anthropic.com/settings/keys\n  Then run: yos init --api-key <key>';
  }
  // The same mistake in the other direction.
  if (opts.codexApiKey && opts.codexApiKey.startsWith('sk-ant-')) {
    return 'That looks like an Anthropic key, but --codex-api-key is for OpenAI keys.\n'
      + '  For an Anthropic key, use the Claude runtime:\n'
      + '    yos init --runtime claude --api-key <key>';
  }
  if (opts.apiKey && opts.apiKey.startsWith('sk-ant-oat')) {
    return 'That looks like a setup token, not an API key.\n  Use --setup-token instead: yos init --setup-token <token>';
  }

  // Runtime validation
  if (opts.runtime && !['claude', 'codex'].includes(opts.runtime)) {
    return `Invalid runtime: "${opts.runtime}".\n  Supported: claude, codex\n  Example: yos init --runtime codex`;
  }

  // Timezone validation
  if (opts.timezone && !isValidTimezone(opts.timezone)) {
    return `Invalid timezone: "${opts.timezone}".\n  Run: yos init --timezone Asia/Shanghai`;
  }

  if (opts.baseUrl && !isValidBaseUrl(opts.baseUrl)) {
    return `Invalid base URL: "${opts.baseUrl}".\n  Run: yos init --base-url https://example.com/v1`;
  }
  if (opts.codexBaseUrl && !isValidBaseUrl(opts.codexBaseUrl)) {
    return `Invalid Codex base URL: "${opts.codexBaseUrl}".\n  Run: yos init --codex-base-url https://example.com/v1`;
  }

  // Domain validation (basic hostname check)
  if (opts.domain) {
    const domainPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
    if (!domainPattern.test(opts.domain)) {
      return `Invalid domain: "${opts.domain}".\n  Run: yos init --domain agent.example.com`;
    }
  }

  // Protocol validation (via YOS_PROTOCOL env var — already resolved to boolean,
  // but validate the raw env var if it was the source)
  if (process.env.YOS_PROTOCOL && !['https', 'http'].includes(process.env.YOS_PROTOCOL)) {
    return `Invalid YOS_PROTOCOL: "${process.env.YOS_PROTOCOL}". Must be "https" or "http".`;
  }

  return null;
}

/**
 * Print help text for `yos init`.
 */
export function printInitHelp() {
  console.log(`
Usage: yos init [options]

Options:
  -y, --yes                  Force non-interactive mode (even with a TTY)
  -q, --quiet                Minimal output
  --runtime <name>           Agent runtime: claude (default) or codex
  --timezone <tz>            Set timezone (IANA format, e.g., Asia/Shanghai)
  --setup-token <token>      Authenticate with Claude setup token
  --api-key <key>            Authenticate with Anthropic API key
  --codex-api-key <key>      Authenticate Codex with OpenAI API key (sk-...)
  --base-url <url>           Custom API base URL for Claude Code
  --codex-base-url <url>     Custom API base URL for Codex
  --domain <domain>          Configure Caddy with this domain
  --https / --no-https       Enable/disable HTTPS (default: https when domain set)
  --caddy / --no-caddy       Install/skip Caddy web server (default: install)
  --web-password <password>  Set web console password (default: auto-generate)

Non-interactive mode:
  Automatically enabled when stdin is not a TTY, or CI=true / NONINTERACTIVE=1
  is set. Use -y to force non-interactive in a terminal. Flags and env vars
  provide values; unfilled fields use sensible defaults.

Environment variables:
  CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, YOS_RUNTIME,
  OPENAI_API_KEY (or CODEX_API_KEY), YOS_DOMAIN, YOS_PROTOCOL, YOS_WEB_PASSWORD

  Resolution: CLI flag > env var > .env/config.json > interactive prompt

Note: --setup-token and --api-key values are visible in process listings.
  On shared systems, prefer environment variables instead:
    CLAUDE_CODE_OAUTH_TOKEN=... yos init
`);
}

// ── Main init command ───────────────────────────────────────────

export async function initCommand(args) {
  const opts = parseInitFlags(args);

  // --help: print usage and exit
  if (opts.help) {
    printInitHelp();
    return;
  }

  // Resolve from environment variables
  resolveFromEnv(opts);

  // Validate options
  const validationErr = validateInitOptions(opts);
  if (validationErr) {
    console.error(`${error(`Error: ${validationErr}`)}`);
    process.exit(1);
  }

  // Non-interactive mode: explicit -y, no TTY on stdin, or CI environment
  const skipConfirm = opts.yes ||
    !process.stdin.isTTY ||
    process.env.CI === 'true' ||
    process.env.NONINTERACTIVE === '1';
  const quiet = opts.quiet;

  // Track exit code: 0 = success, 1 = fatal, 2 = partial success
  let exitCode = 0;

  // Root sandbox — Claude Code refuses --dangerously-skip-permissions as root
  // unless IS_SANDBOX=1 is set. Auto-set it so root users (e.g. Docker) just work.
  if (process.getuid?.() === 0 && !process.env.IS_SANDBOX) {
    process.env.IS_SANDBOX = '1';
  }

  if (!quiet) {
    console.log(`\n${heading('Welcome to YOS!')} Let's set up your AI assistant.\n`);
  }

  // Security consent — first-time install only, skip on re-init, silent mode,
  // or when already accepted in install.sh (--skip-consent)
  if (!skipConfirm && !opts.skipConsent && detectInstallState() !== 'complete') {
    if (!quiet) {
      console.log(yellow(bold('  ◆ Security Notice')));
      console.log(dim('  ┌────────────────────────────────────────────────────────┐'));
      console.log(dim('  │                                                        │'));
      console.log(`  ${dim('│')}  ${dim('YOS currently assumes a trusted environment.')}     ${dim('│')}`);
      console.log(`  ${dim('│')}  ${dim('It runs with full system access as the current')}     ${dim('│')}`);
      console.log(`  ${dim('│')}  ${dim('user — it can execute commands, read/write')}          ${dim('│')}`);
      console.log(`  ${dim('│')}  ${dim('files, and access the network on your behalf.')}      ${dim('│')}`);
      console.log(dim('  │                                                        │'));
      console.log(`  ${dim('│')}  ${yellow('⚠ Dangerous: If untrusted people can reach')}         ${dim('│')}`);
      console.log(`  ${dim('│')}  ${yellow('this machine or talk to the bot, they can')}          ${dim('│')}`);
      console.log(`  ${dim('│')}  ${yellow('execute anything as your user.')}                     ${dim('│')}`);
      console.log(dim('  │                                                        │'));
      console.log(dim('  └────────────────────────────────────────────────────────┘'));
      console.log('');
      console.log('  Only continue if you understand the risks and trust');
      console.log('  the environment you are installing on.');
      console.log('');
    }
    const accepted = await promptYesNo('  I understand and want to continue [Y/n]: ', true);
    if (!accepted) {
      console.log(`\n${dim('Installation cancelled. No changes were made.')}`);
      process.exit(130); // 130 = user cancellation (same as Ctrl+C convention)
    }
    if (!quiet) console.log('');
  }

  // Step 1: Check prerequisites (always, even on re-init)
  if (!quiet) console.log(heading('Checking prerequisites...'));

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.error(`  ${error(`Node.js ${nodeCheck.version} (requires ${nodeCheck.required})`)}`);
    console.error(`    ${dim('Please upgrade Node.js and try again.')}`);
    process.exit(1);
  }
  if (!quiet) console.log(`  ${success(`Node.js ${nodeCheck.version}`)}`);

  // Step 2: Check/install tmux
  if (commandExists('tmux')) {
    if (!quiet) console.log(`  ${success('tmux installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('tmux not found')}`);
    if (!quiet) console.log(`    ${cyan('Installing tmux...')}`);
    if (installSystemPackage('tmux')) {
      if (!quiet) console.log(`  ${success('tmux installed')}`);
    } else {
      console.error(`  ${error('Failed to install tmux')}`);
      console.error(`    ${dim('Install manually: brew install tmux (macOS) / apt install tmux (Linux)')}`);
      process.exit(1);
    }
  }

  // Step 3: Check/install git
  if (commandExists('git')) {
    if (!quiet) console.log(`  ${success('git installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('git not found')}`);
    if (!quiet) console.log(`    ${cyan('Installing git...')}`);
    if (installSystemPackage('git')) {
      if (!quiet) console.log(`  ${success('git installed')}`);
    } else {
      console.error(`  ${error('Failed to install git')}`);
      console.error(`    ${dim('Install manually: brew install git (macOS) / apt install git (Linux)')}`);
      process.exit(1);
    }
  }

  // Step 4: Check/install PM2
  if (commandExists('pm2')) {
    if (!quiet) console.log(`  ${success('PM2 installed')}`);
  } else {
    if (!quiet) console.log(`  ${error('PM2 not found')}`);
    // PM2 sits ahead of the runtime, so a single unreachable registry here
    // ends the install before the runtime's own fallback ever gets a turn.
    const pm2Result = installGlobalPackageWithFallback('pm2', {
      binary: 'pm2',
      onAttempt: source => {
        if (!quiet) console.log(`    ${cyan(`Installing pm2 from ${source.label}...`)}`);
      },
    });
    if (pm2Result.ok) {
      if (!quiet) console.log(`  ${success(`PM2 installed from ${pm2Result.label}`)}`);
      if (pm2Result.fellBack && !quiet) {
        console.warn(`    ${dim('The configured registry did not answer — used the mirror instead.')}`);
      }
    } else {
      console.error(`  ${error('Failed to install PM2')}`);
      for (const line of describeNpmInstallFailure('pm2', pm2Result)) {
        console.error(`    ${dim(line)}`);
      }
      process.exit(1);
    }
  }

  // Step 4.1: PM2 processes this install did not start (TD-21)
  reportPm2Leftovers({ quiet });

  // Step 4.5: Select agent runtime
  // Resolution: --runtime flag > YOS_RUNTIME env > existing config > interactive prompt
  const existingRuntime = getYosConfig().runtime;
  let selectedRuntime = opts.runtime || existingRuntime || null;
  if (!selectedRuntime) {
    if (!skipConfirm) {
      if (!quiet) console.log('');
      const runtimeIdx = await promptChoice(
        '  Which agent runtime would you like to use?',
        ['Claude Code (Anthropic)', 'Codex (OpenAI)'],
      );
      selectedRuntime = runtimeIdx === 2 ? 'codex' : 'claude';
    } else {
      selectedRuntime = 'claude'; // backward-compatible default for non-interactive mode
    }
  }
  if (!quiet && !existingRuntime) {
    const runtimeLabel = selectedRuntime === 'codex' ? 'Codex (OpenAI)' : 'Claude Code';
    console.log(`  ${success(`Runtime: ${runtimeLabel}`)}`);
  }

  // Steps 5–6: Install and authenticate the selected runtime
  let claudeJustInstalled = false;
  let claudeAuthenticated = false;
  // Set when a credential was saved but the endpoint never confirmed it. Keeps
  // the install summary honest: neither "authenticated" nor "no credential".
  let credentialUnverified = null;
  let codexAuthenticated = false;
  let pendingApiKey = null; // set if user enters API key, written to .env after templates
  let pendingSetupToken = null; // set if user enters setup-token, written to .env after templates
  let pendingCodexApiKey = null; // set if codex api key provided, written to .env after templates
  let pendingClaudeBaseUrl = null;
  let pendingCodexBaseUrl = null;

  if (opts.baseUrl) {
    saveClaudeBaseUrl(opts.baseUrl);
    pendingClaudeBaseUrl = opts.baseUrl;
  }
  if (opts.codexBaseUrl) {
    saveCodexBaseUrl(opts.codexBaseUrl);
    pendingCodexBaseUrl = opts.codexBaseUrl;
  }

  if (selectedRuntime === 'codex') {
    // ── Step 5 (Codex): install ───────────────────────────────────────────
    if (commandExists('codex')) {
      if (!quiet) console.log(`  ${success('Codex installed')}`);
    } else {
      if (!quiet) console.log(`  ${error('Codex not found')}`);
      const codexResult = installCodex({
        onAttempt: source => {
          if (!quiet) console.log(`    ${cyan(`Installing @openai/codex from ${source.label}...`)}`);
        },
      });
      if (codexResult.ok) {
        if (!quiet) console.log(`  ${success(`Codex installed from ${codexResult.label}`)}`);
        if (codexResult.fellBack && !quiet) {
          console.warn(`    ${dim('The configured registry did not answer — used the mirror instead.')}`);
        }
      } else {
        console.error(`  ${error('Failed to install Codex')}`);
        for (const line of describeNpmInstallFailure('@openai/codex', codexResult)) {
          console.error(`    ${dim(line)}`);
        }
        process.exit(1);
      }
    }

    // ── Step 6 (Codex): auth + startup config ────────────────────────────
    if (commandExists('codex')) {
      if (opts.codexApiKey) {
        // Verify first, then save — mirrors Claude's verifyApiKey → saveApiKey pattern.
        // Do NOT save before verifying: a bad key in process.env causes isCodexAuthenticated()
        // to report "authenticated" even when the key is invalid (path 1 check is existence-only).
        const codexEndpoint = describeEndpoint(
          resolveCodexBaseUrl(opts.codexBaseUrl), OFFICIAL_CODEX_BASE_URL);
        if (!quiet) console.log(`  ${dim(`Verifying Codex API key against ${codexEndpoint.host}...`)}`);
        const verifyResult = await verifyCodexApiKey(opts.codexApiKey, opts.codexBaseUrl);
        const codexOutcome = decideCredentialOutcome(verifyResult);
        if (codexOutcome === 'refuse') {
          reportCredentialFailure('Codex API key', verifyResult, codexEndpoint.custom, 'platform.openai.com');
          if (skipConfirm) exitCode = 1;
        } else if (saveCodexApiKey(opts.codexApiKey)) {
          if (codexOutcome === 'verified') {
            codexAuthenticated = true;
            if (!quiet) console.log(`  ${success('Codex API key verified and saved')}`);
          } else {
            // Saved so the key is not lost, but never reported as authenticated:
            // the install summary must not claim a check that never happened.
            credentialUnverified = { label: 'Codex API key', result: verifyResult };
            if (!quiet) reportCredentialUnverified('Codex API key', verifyResult, codexEndpoint.custom);
          }
        } else {
          console.error(`  ${error('Failed to save Codex API key to auth.json.')}`);
          if (skipConfirm) exitCode = 1;
        }
      } else {
        codexAuthenticated = isCodexAuthenticated();
        if (codexAuthenticated) {
          if (!quiet) console.log(`  ${success('Codex authenticated')}`);
        } else {
          if (!quiet) console.log(`  ${warn('Codex not authenticated')}`);
          if (!skipConfirm) {
            const codexAuthChoice = await promptChoice(
              '\n  How would you like to authenticate Codex?',
              ['OpenAI API key', 'Device auth (headless/server — no browser needed)', 'Browser login'],
            );
            if (codexAuthChoice === 1) {
              // Option 1: API key
              console.log(`\n  ${dim('Paste your OpenAI API key (starts with sk-):')}`);
              const apiKey = await promptSecret('  API key: ');
              if (!apiKey) {
                console.log(`  ${warn('No key entered. Skipped.')}`);
              } else if (saveCodexApiKey(apiKey)) {
                codexAuthenticated = isCodexAuthenticated();
                if (codexAuthenticated) {
                  console.log(`  ${success('Codex API key saved and verified')}`);
                } else {
                  console.log(`  ${warn('Key saved but auth check failed. Continuing...')}`);
                }
              }
            } else if (codexAuthChoice === 2) {
              // Option 2: device-auth (headless)
              console.log(`\n  ${cyan('Starting Codex device auth...')}`);
              console.log(`  ${dim('Follow the instructions to authenticate. Press Ctrl+C when done.')}\n`);
              try {
                spawnSync('codex', ['login', '--device-auth'], { stdio: 'inherit' });
              } catch { /* user may Ctrl+C */ }
              codexAuthenticated = isCodexAuthenticated();
              if (codexAuthenticated) {
                console.log(`\n  ${success('Codex authenticated')}`);
              } else {
                console.log(`\n  ${warn('Authentication not completed.')}`);
                console.log(`    ${dim('Run "codex login --device-auth" to try again.')}`);
              }
            } else {
              // Option 3: browser login
              console.log(`\n  ${cyan('Starting Codex browser login...')}`);
              console.log(`  ${dim('After login completes, press Ctrl+C to return.')}\n`);
              try {
                spawnSync('codex', ['login'], { stdio: 'inherit' });
              } catch { /* user may Ctrl+C */ }
              codexAuthenticated = isCodexAuthenticated();
              if (codexAuthenticated) {
                console.log(`\n  ${success('Codex authenticated')}`);
              } else {
                console.log(`\n  ${warn('Authentication not completed.')}`);
                console.log(`    ${dim('Run "codex login" to try again.')}`);
              }
            }
          } else {
            if (!quiet) console.log(`    ${dim('Run "codex login --device-auth" or re-run with "--codex-api-key <key>" to authenticate.')}`);
          }
        }
      }

      // Write ~/.codex/config.toml to suppress interactive prompts on first launch
      if (writeCodexConfig(YOS_DIR, { openaiBaseUrl: pendingCodexBaseUrl || undefined })) {
        if (!quiet) console.log(`  ${success('Codex startup config written')}`);
      }
    }

  } else {
    // ── Step 5 (Claude): install ──────────────────────────────────────────
    if (commandExists('claude')) {
      if (!quiet) console.log(`  ${success('Claude Code installed')}`);
    } else {
      if (!quiet) console.log(`  ${error('Claude Code not found')}`);
      // Sources are tried in order (see planClaudeInstall) — say which one is
      // being used rather than announcing one and silently using another.
      const result = installClaude({
        onAttempt: step => {
          if (!quiet) console.log(`    ${cyan(`Installing Claude Code from ${step.label}...`)}`);
        },
      });
      if (result.ok) {
        if (!quiet) console.log(`  ${success(`Claude Code installed from ${result.label}`)}`);
        if (result.fellBack) {
          console.warn(`    ${dim('The first source did not answer — fell back. Nothing to do, just so you know where it came from.')}`);
        }
        claudeJustInstalled = true;
      } else {
        console.error(`  ${error('Failed to install Claude Code')}`);
        for (const line of describeClaudeInstallFailure(result)) {
          console.error(`    ${dim(line)}`);
        }
        process.exit(1);
      }
    }

    // ── Step 6 (Claude): auth check + guided login ────────────────────────
    if (commandExists('claude')) {
      claudeAuthenticated = isClaudeAuthenticated();
      if (claudeAuthenticated) {
        if (!quiet) console.log(`  ${success('Claude Code authenticated')}`);
      } else if (opts.setupToken) {
      // Setup token provided via flag/env — save, verify via actual API call, rollback on failure
      if (saveSetupToken(opts.setupToken)) {
        if (!quiet) console.log(`  ${dim('Verifying setup token...')}`);
        const tokenResult = verifySetupToken();
        if (tokenResult.valid) {
          pendingSetupToken = opts.setupToken;
          claudeAuthenticated = true;
          if (!quiet) console.log(`  ${success('Setup token verified and saved')}`);
        } else {
          rollbackSetupToken();
          if (tokenResult.authError) {
            console.error(`  ${error('Setup token is invalid or expired.')}`);
            console.error(`    ${dim('Generate a new one: claude setup-token')}`);
          } else {
            console.error(`  ${error('Could not verify setup token. Check network and try again.')}`);
            if (tokenResult.message) console.error(`    ${dim(tokenResult.message.split('\n')[0])}`);
          }
          if (skipConfirm) exitCode = 1;
        }
      }
    } else if (opts.apiKey) {
      // API key provided via flag/env — verify and use directly (already validated format)
      // Verify against the configured endpoint, not the vendor host: a key that
      // is valid on the customer's gateway must not be rejected just because
      // the vendor's host is unreachable from their network.
      const claudeEndpoint = describeEndpoint(resolveClaudeBaseUrl(opts.baseUrl));
      if (!quiet) console.log(`  ${dim(`Verifying API key against ${claudeEndpoint.host}...`)}`);
      const keyResult = await verifyApiKey(opts.apiKey, opts.baseUrl);
      const keyOutcome = decideCredentialOutcome(keyResult);
      if (keyOutcome === 'refuse') {
        reportCredentialFailure('Anthropic API key', keyResult, claudeEndpoint.custom, 'console.anthropic.com');
        if (skipConfirm) exitCode = 1;
      } else if (saveApiKey(opts.apiKey)) {
        pendingApiKey = opts.apiKey;
        if (keyOutcome === 'verified') {
          claudeAuthenticated = true;
          if (!quiet) console.log(`  ${success('API key verified and saved')}`);
        } else {
          // Saved so the key is not lost, but never reported as authenticated.
          credentialUnverified = { label: 'Anthropic API key', result: keyResult };
          if (!quiet) reportCredentialUnverified('Anthropic API key', keyResult, claudeEndpoint.custom);
        }
      } else {
        console.error(`  ${error('Failed to save the API key.')}`);
        if (skipConfirm) exitCode = 1;
      }
    } else {
      if (!quiet) console.log(`  ${warn('Claude Code not authenticated')}`);
      if (!skipConfirm) {
        const authChoice = await promptChoice(
          '\n  How would you like to authenticate?',
          ['Claude subscription (opens browser login)', 'Anthropic API key', 'Setup token (from claude setup-token)'],
        );

        if (authChoice === 1) {
          // Option 1: Subscription login (existing flow)
          console.log(`\n  ${cyan('Starting Claude Code for authentication...')}`);
          console.log(`  ${dim('After login, type /exit to return to yos init.')}\n`);
          const sigintListeners = process.rawListeners('SIGINT');
          process.removeAllListeners('SIGINT');
          process.on('SIGINT', () => {});
          try {
            // On macOS, spawning Claude from a curl|bash pipeline leaves stdin
            // in a state where ink's TUI can't receive keyboard input — even with
            // /dev/tty redirects. Use `script` to allocate a fresh pseudo-terminal
            // that gives Claude full terminal control.
            if (process.platform === 'darwin') {
              spawnSync('script', ['-q', '/dev/null', 'claude'], { stdio: 'inherit' });
            } else {
              spawnSync('claude', [], { stdio: 'inherit' });
            }
          } catch { /* user may Ctrl+C */ }
          process.removeAllListeners('SIGINT');
          for (const l of sigintListeners) process.on('SIGINT', l);
          claudeAuthenticated = isClaudeAuthenticated();
          if (claudeAuthenticated) {
            console.log(`\n  ${success('Claude Code authenticated')}`);
          } else {
            console.log(`\n  ${warn('Authentication not completed.')}`);
            console.log(`    ${dim('Run "claude" to authenticate then "yos init" again.')}`);
          }
        } else if (authChoice === 2) {
          // Option 2: API key
          console.log(`\n  ${dim('Paste your Anthropic API key (starts with sk-ant-):')}`);
          const apiKey = await promptSecret('  API key: ');
          if (!apiKey) {
            console.log(`  ${warn('No key entered. Skipped.')}`);
          } else if (!apiKey.startsWith('sk-ant-')) {
            console.log(`  ${error('Invalid format. API key should start with sk-ant-')}`);
            console.log(`    ${dim('You can set it later: export ANTHROPIC_API_KEY=sk-ant-xxx')}`);
          } else {
            const promptEndpoint = describeEndpoint(resolveClaudeBaseUrl(opts.baseUrl));
            console.log(`  ${dim(`Verifying API key against ${promptEndpoint.host}...`)}`);
            const keyResult = await verifyApiKey(apiKey, opts.baseUrl);
            const promptOutcome = decideCredentialOutcome(keyResult);
            if (promptOutcome === 'refuse') {
              reportCredentialFailure('Anthropic API key', keyResult, promptEndpoint.custom, 'console.anthropic.com');
            } else if (saveApiKey(apiKey)) {
              pendingApiKey = apiKey;
              if (promptOutcome === 'verified') {
                claudeAuthenticated = true;
                console.log(`  ${success('API key verified and saved')}`);
              } else {
                credentialUnverified = { label: 'Anthropic API key', result: keyResult };
                reportCredentialUnverified('Anthropic API key', keyResult, promptEndpoint.custom);
              }
            }
          }
        } else if (authChoice === 3) {
          // Option 3: Setup token (OAuth token from claude setup-token)
          console.log(`\n  ${dim('Paste your setup token (starts with sk-ant-oat):')}`);
          console.log(`  ${dim('Generate one by running "claude setup-token" on a machine with a browser.')}`);
          const token = await promptSecret('  Setup token: ');
          if (!token) {
            console.log(`  ${warn('No token entered. Skipped.')}`);
          } else if (!token.startsWith('sk-ant-oat')) {
            console.log(`  ${error('Invalid format. Setup token should start with sk-ant-oat')}`);
            console.log(`    ${dim('Run "claude setup-token" to generate a valid token.')}`);
          } else if (saveSetupToken(token)) {
            console.log(`  ${dim('Verifying setup token...')}`);
            const tokenResult = verifySetupToken();
            if (tokenResult.valid) {
              pendingSetupToken = token;
              claudeAuthenticated = true;
              console.log(`  ${success('Setup token verified and saved')}`);
            } else {
              rollbackSetupToken();
              if (tokenResult.authError) {
                console.log(`  ${error('Setup token is invalid or expired.')}`);
                console.log(`    ${dim('Generate a new one: claude setup-token')}`);
              } else {
                console.log(`  ${error('Could not verify setup token. Check network and try again.')}`);
                if (tokenResult.message) console.log(`    ${dim(tokenResult.message.split('\n')[0])}`);
              }
            }
          }
        }
      } else {
        if (!quiet) console.log(`    ${dim('Run "yos init" again to authenticate.')}`);
      }
    }
    } // end if (commandExists('claude')) — Step 6
  } // end else (Claude runtime branch)

  // Pre-accept Claude Code terms (skips manual prompts on first launch).
  // Called regardless of auth state — user may configure credentials after init.
  if (selectedRuntime === 'claude') {
    if (preAcceptClaudeTerms()) {
      if (!quiet) console.log(`  ${success('Claude Code terms pre-accepted')}`);
    }
  }

  if (!quiet) console.log('');

  // Re-init: skip directory creation, just sync + deploy + start
  const installState = detectInstallState();

  if (installState === 'complete') {
    if (!quiet) console.log(`${dim('YOS is already initialized at')} ${bold(YOS_DIR)}\n`);

    // Ensure bin directory and PATH are configured (idempotent)
    fs.mkdirSync(BIN_DIR, { recursive: true });
    if (ensureBinInPath()) {
      if (!quiet) console.log(success('Added ~/yos/bin to PATH'));
    }

    const syncResult = syncCoreSkills();
    if (!quiet) {
      if (syncResult.updated.length > 0) {
        console.log(`${success('Core Skills updated:')} ${syncResult.updated.join(', ')}`);
      }
      if (syncResult.installed.length > 0) {
        console.log(`${success('Core Skills installed:')} ${syncResult.installed.join(', ')}`);
      }
    }

    // Persist runtime selection before deploying templates so deployTemplates()
    // generates the correct instruction file for the new runtime.
    if (!existingRuntime || existingRuntime !== selectedRuntime) {
      updateYosConfig({ runtime: selectedRuntime });
    }

    // Ensure new-session thresholds are explicitly set in config (idempotent)
    ensureNewSessionThresholdDefaults();

    if (!quiet) console.log(heading('Deploying templates...'));
    deployTemplates();

    // Migrate WEB_CONSOLE_PASSWORD → YOS_WEB_PASSWORD
    migrateWebConsolePassword();

    // Write auth credentials to .env if entered during this run
    if (pendingApiKey) {
      saveApiKeyToEnv(pendingApiKey);
    }
    if (pendingSetupToken) {
      saveSetupTokenToEnv(pendingSetupToken);
    }
    if (pendingCodexApiKey) {
      saveCodexApiKeyToEnv(pendingCodexApiKey);
    }
    if (pendingClaudeBaseUrl) {
      saveClaudeBaseUrlToSettingsAndEnv(pendingClaudeBaseUrl);
    }
    if (pendingCodexBaseUrl) {
      saveCodexBaseUrlToEnv(pendingCodexBaseUrl);
      writeCodexConfig(YOS_DIR, { openaiBaseUrl: pendingCodexBaseUrl });
    }

    recordReleaseSource();

    // Timezone: use resolved value or show current
    if (!quiet) console.log(heading('Checking timezone...'));
    await configureTimezone(skipConfirm, true, opts.timezone, quiet);

    // Caddy setup (idempotent — skips if already configured)
    if (!quiet) console.log(heading('Checking Caddy...'));
    const caddyOk = await setupCaddy(skipConfirm, opts);
    if (!caddyOk && opts.caddy !== false && opts.domain) {
      exitCode = exitCode || 2; // optional step failed — don't downgrade a fatal (1)
    }

    // On runtime switch: clear stale health state before restart.
    // NOTE: do NOT kill the old session here — init.js may itself be running
    // inside that session (as a subprocess of the current runtime), so
    // tmux kill-session would silently fail or kill the parent process mid-run.
    // The new activity-monitor kills the stale session on startup instead.
    if (existingRuntime && existingRuntime !== selectedRuntime) {
      try { fs.unlinkSync(path.join(YOS_DIR, 'activity-monitor', 'agent-status.json')); } catch {}
      try { fs.unlinkSync(path.join(YOS_DIR, 'activity-monitor', 'heartbeat-pending.json')); } catch {}
      try { fs.unlinkSync(path.join(YOS_DIR, 'activity-monitor', 'codex-heartbeat-pending.json')); } catch {}
    }
    if (!quiet) console.log(heading('Starting services...'));
    await settleWebConsolePort({ quiet });
    const serviceOutcome = startCoreServices(opts.webPassword);
    const servicesStarted = serviceOutcome.started;
    if (servicesStarted > 0) {
      setupPm2Startup();
      if (!quiet) console.log(`\n${green(`${servicesStarted} service(s) started.`)} ${dim('Run "yos status" to check.')}`);
    } else {
      if (!quiet) console.log(`\n${dim('No services to start.')}`);
    }
    exitCode = reportServiceOutcome(serviceOutcome, { quiet }) || exitCode;

    if (selectedRuntime === 'claude' && claudeAuthenticated && !skipConfirm && needsBypassAcceptance()) {
      await guideBypassAcceptance();
    }

    if (selectedRuntime === 'codex' ? !codexAuthenticated : !claudeAuthenticated) {
      if (!quiet) {
        const runtimeName = selectedRuntime === 'codex' ? 'Codex' : 'Claude Code';
        if (credentialUnverified) {
          // A credential IS on disk — saying "not authenticated" would send the
          // user hunting for a key they already provided.
          console.log(`\n${warn(`${runtimeName} credential saved but unverified.`)}`);
          console.log(`  ${dim(`${credentialUnverified.result.target} never confirmed it. ${runtimeName} will report the real error on first use.`)}`);
        } else {
          console.log(`\n${warn(`${runtimeName} is not authenticated.`)}`);
          console.log(`  ${dim('Run "yos init" again to authenticate.')}`);
        }
      }
    }
    printWebConsoleInfo();
    if (!quiet) console.log(`\n${dim('Use "yos add <component>" to add components.')}`);
    if (exitCode) process.exit(exitCode);
    return;
  }

  if (installState === 'incomplete') {
    if (!quiet) console.log(`${warn('Incomplete installation detected at')} ${bold(YOS_DIR)}`);
    if (!skipConfirm) {
      const answer = await prompt('Continue previous installation or start fresh? [c/f] (c): ');
      if (answer.toLowerCase() === 'f') {
        if (!quiet) console.log('Resetting managed state...');
        resetManagedState();
        if (!quiet) console.log('Starting fresh...\n');
      } else {
        if (!quiet) console.log('Continuing...\n');
      }
    }
  }

  // Step 6: Create directory structure
  if (!quiet) {
    console.log(`${dim('Install directory:')} ${bold(YOS_DIR)}`);
    console.log(`\n${heading('Setting up...')}`);
  }
  createDirectoryStructure();
  if (!quiet) console.log(`  ${success('Created directory structure')}`);

  // Configure PATH for ~/yos/bin
  if (ensureBinInPath()) {
    if (!quiet) console.log(`  ${success('Added ~/yos/bin to PATH')}`);
  }

  // Persist runtime selection after successful install (guard: only on change)
  if (!existingRuntime || existingRuntime !== selectedRuntime) {
    updateYosConfig({ runtime: selectedRuntime });
  }

  // Fresh installs pair the opus[1m] default model with an explicit lower
  // Claude new-session threshold. This is intentionally not used by re-init.
  seedFreshInstallNewSessionThresholdDefault();

  // Step 7: deploy templates and initialize the current instruction layout.
  deployTemplates({ freshInstall: true });
  if (!quiet) console.log(`  ${success('Templates deployed')}`);

  // Migrate WEB_CONSOLE_PASSWORD → YOS_WEB_PASSWORD
  migrateWebConsolePassword();

  // Write auth credentials to .env now that templates have been deployed
  if (pendingApiKey) {
    saveApiKeyToEnv(pendingApiKey);
  }
  if (pendingSetupToken) {
    saveSetupTokenToEnv(pendingSetupToken);
  }
  if (pendingCodexApiKey) {
    saveCodexApiKeyToEnv(pendingCodexApiKey);
  }
  if (pendingClaudeBaseUrl) {
    saveClaudeBaseUrlToSettingsAndEnv(pendingClaudeBaseUrl);
  }
  if (pendingCodexBaseUrl) {
    saveCodexBaseUrlToEnv(pendingCodexBaseUrl);
    writeCodexConfig(YOS_DIR, { openaiBaseUrl: pendingCodexBaseUrl });
  }
  const recordedReleaseSource = recordReleaseSource();
  if (recordedReleaseSource && !quiet) {
    console.log(`  ${success(`Upgrades will come from ${bold(recordedReleaseSource)}`)}`);
  }

  // The console port has to be settled before the Caddyfile names it and before
  // the service is started under it.
  await settleWebConsolePort({ quiet });

  // Step 8: Configure timezone
  if (!quiet) console.log(`\n${heading('Timezone configuration...')}`);
  await configureTimezone(skipConfirm, false, opts.timezone, quiet);

  // Step 9: Sync Core Skills
  const syncResult = syncCoreSkills();
  if (!quiet) {
    if (syncResult.error) {
      console.log(`  ${warn(syncResult.error)}`);
    } else {
      const counts = [`${syncResult.installed.length} installed`, `${syncResult.updated.length} updated`];
      console.log(`  ${success(`Core Skills synced (${counts.join(', ')})`)}`);
      for (const name of syncResult.installed) {
        console.log(`    ${green('+')} ${bold(name)}`);
      }
    }
  }

  // Step 10: Caddy web server setup
  if (!quiet) console.log(`\n${heading('HTTPS setup...')}`);
  const caddyOk = await setupCaddy(skipConfirm, opts);
  if (!caddyOk && opts.caddy !== false && opts.domain) {
    exitCode = exitCode || 2; // optional step failed — don't downgrade a fatal (1)
  }

  // On runtime switch: clear stale health state before restart.
  // NOTE: do NOT kill the old session here — init.js may run from inside the
  // old session, and killing it would terminate this process before services start.
  // The activity-monitor kills the stale session on startup instead.
  if (existingRuntime && existingRuntime !== selectedRuntime) {
    try { fs.unlinkSync(path.join(YOS_DIR, 'activity-monitor', 'agent-status.json')); } catch {}
    try { fs.unlinkSync(path.join(YOS_DIR, 'activity-monitor', 'heartbeat-pending.json')); } catch {}
    try { fs.unlinkSync(path.join(YOS_DIR, 'activity-monitor', 'codex-heartbeat-pending.json')); } catch {}
  }

  // Step 11: Start services
  if (!quiet) console.log(`\n${heading('Starting services...')}`);
  const serviceOutcome = startCoreServices(opts.webPassword);
  const servicesStarted = serviceOutcome.started;

  if (servicesStarted > 0) {
    setupPm2Startup();
  }
  exitCode = reportServiceOutcome(serviceOutcome, { quiet }) || exitCode;

  // First-time Claude bypass acceptance (only if Claude runtime and authenticated)
  if (selectedRuntime === 'claude' && claudeAuthenticated && !skipConfirm && needsBypassAcceptance()) {
    await guideBypassAcceptance();
  }

  // Done — but "successfully" has to mean it. A machine whose console never
  // came up is not an initialized machine, and the user is about to be handed
  // a URL for it.
  if (!quiet) {
    console.log(serviceOutcome.failed.length === 0
      ? `\n${success(bold('YOS initialized successfully!'))}\n`
      : `\n${warn(bold('YOS initialized, but not everything is running — see above.'))}\n`);
  }

  if (servicesStarted > 0 && !quiet) {
    console.log(`${green(`${servicesStarted} service(s) started.`)} ${dim('Run "yos status" to check.')}\n`);
  }

  printWebConsoleInfo();

  if (claudeJustInstalled) {
    // Auto-add ~/.local/bin to shell profile so future shell sessions find claude
    ensureLocalBinInProfile();
  }

  if (!quiet) {
    const runtimeAuthOk = selectedRuntime === 'codex' ? codexAuthenticated : claudeAuthenticated;
    if (!runtimeAuthOk && credentialUnverified) {
      // Distinct from "not authenticated": the credential is on disk, we just
      // never got an answer about it. Telling the user to supply a key they
      // already supplied is the panel lying in the other direction.
      const runtimeName = selectedRuntime === 'codex' ? 'Codex' : 'Claude';
      printWarningBox([
        `⚠  ${runtimeName} credential saved but unverified`,
        '',
        `YOS is installed and the key is stored, but`,
        `${credentialUnverified.result.target} never confirmed it.`,
        '',
        'To confirm:',
        '  yos doctor',
      ]);
    } else if (!runtimeAuthOk) {
      // Yellow warning box — same treatment regardless of whether a credential
      // was attempted or not. Auth is required; Next steps without it is misleading.
      console.log('');
      console.log(yellow('  ┌────────────────────────────────────────────────────────┐'));
      console.log(yellow('  │                                                        │'));
      if (selectedRuntime === 'codex') {
        console.log(yellow('  │  ⚠  Codex is not authenticated                         │'));
        console.log(yellow('  │                                                        │'));
        console.log(yellow('  │  YOS is installed, but Codex will not work until     │'));
        console.log(yellow('  │  you authenticate by running "codex login".            │'));
        console.log(yellow('  │                                                        │'));
        console.log(yellow('  │  To fix:                                               │'));
        console.log(yellow('  │    codex login                                         │'));
      } else {
        const fixCmd = (opts.setupToken || opts.apiKey)
          ? (opts.setupToken ? 'yos init --setup-token <valid-token>' : 'yos init --api-key <valid-key>')
          : 'yos init';
        console.log(yellow('  │  ⚠  Claude is not authenticated                       │'));
        console.log(yellow('  │                                                        │'));
        console.log(yellow('  │  YOS is installed, but Claude will not work until    │'));
        console.log(yellow('  │  a valid credential is provided.                       │'));
        console.log(yellow('  │                                                        │'));
        console.log(yellow('  │  To fix:                                               │'));
        console.log(yellow(`  │    ${fixCmd}${' '.repeat(Math.max(0, 52 - fixCmd.length))}│`));
      }
      console.log(yellow('  │                                                        │'));
      console.log(yellow('  └────────────────────────────────────────────────────────┘'));
      console.log('');
    } else {
      console.log(`\n${heading('Next steps:')}`);
      console.log(`  ${bold('yos add telegram')}    ${dim('# Add Telegram bot')}`);
      console.log(`  ${bold('yos add lark')}        ${dim('# Add Lark bot')}`);
      console.log(`  ${bold('yos status')}          ${dim('# Check service status')}`);
      console.log('');
    }
  }

  if (exitCode) process.exit(exitCode);
}
