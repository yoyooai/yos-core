/**
 * runtime-setup.js — shared runtime install + auth helpers.
 *
 * Used by both `yos init` and `yos runtime` to avoid duplicating
 * install/auth logic. All functions are pure utilities with no side-effects
 * beyond writing to well-known credential files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { YOS_DIR } from './config.js';
import { commandExists } from './shell-utils.js';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from './auth-parsers.js';
import { installCoreCodexHook } from './codex-hooks.js';

function upsertEnvValue(content, key, value, comment = null) {
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = comment ? `\n\n# ${comment}\n` : '\n';
  return content.trimEnd() + `${prefix}${line}\n`;
}

export function isValidBaseUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host;
  } catch {
    return false;
  }
}

// ── Install ────────────────────────────────────────────────────────────────

/**
 * npm's way of saying "this account may not write to the global prefix".
 * The wording varies by npm version; the error code does not.
 */
const PERMISSION_DENIED = /\bEACCES\b|\bEPERM\b|permission denied/i;

/**
 * Run one global npm install and report *why* it failed, not just that it did.
 *
 * A permission failure and an unreachable registry need opposite repairs, and
 * telling them apart is only possible here, where npm's own output still
 * exists. Swallowing it is what let a permission failure be reported as a
 * network problem for the whole life of this function.
 *
 * @param {string} pkg
 * @param {{ registry?: string|null, timeout?: number, elevate?: boolean }} opts
 * @returns {{ ok: boolean, permissionDenied: boolean }}
 */
function runGlobalInstall(pkg, opts = {}) {
  const { registry = null, timeout = 120000, elevate = false } = opts;
  const args = ['install', '-g', pkg];
  if (registry) args.push(`--registry=${registry}`);
  const file = elevate ? 'sudo' : 'npm';
  // `-n` so a machine whose sudo wants a password fails here instead of
  // blocking a non-interactive install on a prompt nobody can answer.
  const argv = elevate ? ['-n', 'npm', ...args] : args;
  try {
    execFileSync(file, argv, { stdio: 'pipe', timeout });
    return { ok: true, permissionDenied: false };
  } catch (err) {
    const text = [err?.message, err?.stderr, err?.stdout]
      .map(v => (v == null ? '' : String(v))).join('\n');
    return { ok: false, permissionDenied: PERMISSION_DENIED.test(text) };
  }
}

/**
 * Can this account get to root without being asked for a password?
 * @returns {boolean}
 */
function canElevate() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return false;
  if (!commandExists('sudo')) return false;
  try {
    const r = spawnSync('sudo', ['-n', 'true'], { stdio: 'pipe', timeout: 10000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Install an npm global package.
 * @param {string} pkg - Package name (e.g. "@openai/codex")
 * @param {{ registry?: string|null, timeout?: number, elevate?: boolean }} opts
 * @returns {boolean}
 */
export function installGlobalPackage(pkg, opts = {}) {
  return runGlobalInstall(pkg, opts).ok;
}

/**
 * The registries an npm install may be served from, in order.
 *
 * One definition, used by every global install we perform — the runtime, PM2,
 * and the Codex CLI all reach npm the same way, so a machine that can only
 * reach a mirror must not have to be lucky about which package it needs.
 *
 * YOS_NPM_REGISTRY overrides the mirror; an explicitly empty value drops it
 * rather than restoring the default, the same rule YOS_DIST_BASE follows.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<{registry: string|null, label: string}>}
 */
export function npmInstallSources(env = process.env) {
  const sources = [{ registry: null, label: 'npm (configured registry)' }];
  const mirror = env.YOS_NPM_REGISTRY === undefined
    ? DEFAULT_NPM_MIRROR
    : String(env.YOS_NPM_REGISTRY).trim();
  if (mirror) sources.push({ registry: mirror, label: `npm (${sourceHost(mirror)})` });
  return sources;
}

/**
 * Install a global npm package, trying each registry in turn.
 *
 * When `binary` is given, a registry that reports success but leaves nothing
 * runnable does not end the search — the next registry gets a turn. Same rule
 * installClaude() applies, for the same reason: "npm exited 0" is not the thing
 * we actually need.
 *
 * @param {string} pkg
 * @param {{ binary?: string|null, env?: NodeJS.ProcessEnv, timeout?: number, onAttempt?: (source: object) => void }} opts
 * @returns {{ ok: boolean, label: string|null, fellBack: boolean, attempts: Array<{label: string, installed: boolean, found: boolean}> }}
 */
export function installGlobalPackageWithFallback(pkg, opts = {}) {
  const { binary = null, env = process.env, timeout = 120000, onAttempt = null } = opts;
  const attempts = [];
  let permissionDenied = false;

  const tryChain = (elevate) => {
    for (const source of npmInstallSources(env)) {
      if (onAttempt) onAttempt({ ...source, elevate });
      const run = runGlobalInstall(pkg, { registry: source.registry, timeout, elevate });
      if (run.permissionDenied) permissionDenied = true;
      const found = run.ok && binary ? commandExists(binary) : run.ok;
      attempts.push({ label: source.label, installed: run.ok, found, elevated: elevate });
      if (found) {
        return { ok: true, label: source.label, fellBack: attempts.length > 1, attempts, permissionDenied, elevated: elevate };
      }
    }
    return null;
  };

  const plain = tryChain(false);
  if (plain) return plain;

  // A prefix this account may not write to is the installer's problem too, and
  // the installer solves it by elevating. It installed `yos` that way moments
  // ago — so on the very same machine, the next global install must not give up
  // where the one before it succeeded. Only for a permission failure, and only
  // when sudo needs no password: anything else is still a real failure.
  if (permissionDenied && canElevate()) {
    const elevated = tryChain(true);
    if (elevated) return elevated;
  }

  return { ok: false, label: null, fellBack: false, attempts, permissionDenied, elevated: false };
}

/**
 * Human-readable repair lines for a failed global npm install.
 * @param {string} pkg
 * @param {{ attempts: Array<{label: string, installed: boolean, found: boolean}> }} result
 * @returns {string[]}
 */
export function describeNpmInstallFailure(pkg, result) {
  const attempts = result?.attempts ?? [];
  const lines = attempts.map(a => (
    a.installed && !a.found
      ? `Tried ${a.label}${a.elevated ? ' with sudo' : ''}: reported success but the command is still missing — check your npm global bin directory is on PATH.`
      : `Tried ${a.label}${a.elevated ? ' with sudo' : ''}: failed.`
  ));

  // Advice has to name the cause it actually had. Sending someone at a mirror
  // when the prefix is unwritable costs them the whole afternoon: every mirror
  // answers fine, and none of them is the problem.
  if (result?.permissionDenied) {
    const prefix = npmGlobalPrefix();
    lines.push(`npm could not write to the global directory${prefix ? ` (${prefix})` : ''} — this is a permissions problem, not a network one, so changing registry will not help.`);
    lines.push('Two ways forward:');
    lines.push('  1. Re-run from a terminal you can type into, or as a user with passwordless sudo.');
    lines.push(`  2. Install into your own directory instead:\n       npm config set prefix "$HOME/.local"\n       export PATH="$HOME/.local/bin:$PATH"\n     then run the command again. Add that PATH line to your shell profile to keep it.`);
    return lines;
  }

  lines.push(`Install manually: npm install -g ${pkg}`);
  lines.push(`Behind a slow link, point npm at a reachable mirror: npm install -g ${pkg} --registry=${DEFAULT_NPM_MIRROR}`);
  return lines;
}

/**
 * The npm global prefix, for naming the directory a permission error is about.
 * @returns {string|null}
 */
function npmGlobalPrefix() {
  try {
    return String(execFileSync('npm', ['config', 'get', 'prefix'], {
      stdio: 'pipe', timeout: 10000, encoding: 'utf8',
    })).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Install the Codex CLI globally via npm, mirror included.
 * @param {{ env?: NodeJS.ProcessEnv, onAttempt?: (source: object) => void }} opts
 * @returns {{ ok: boolean, label: string|null, fellBack: boolean, attempts: Array<object> }}
 */
export function installCodex(opts = {}) {
  return installGlobalPackageWithFallback('@openai/codex', { binary: 'codex', ...opts });
}

// The runtime is the one download a fresh machine cannot skip, so it must not
// hang off a single host. Claude Code ships from two independent places: the
// native installer script, and the npm package (which carries the same native
// binary as a platform optionalDependency). A registry mirror therefore serves
// a complete runtime — verified with claude.ai black-holed.
export const CLAUDE_NATIVE_INSTALL_URL = 'https://claude.ai/install.sh';
export const CLAUDE_NPM_PACKAGE = '@anthropic-ai/claude-code';
export const DEFAULT_NPM_MIRROR = 'https://registry.npmmirror.com';

// ~278MB through npm, so the npm sources get more room than a normal package.
const CLAUDE_INSTALL_TIMEOUT_MS = 600000;

/**
 * Everything the native installer puts on disk, so the uninstall can take it
 * back off.
 *
 * TD-62 ④: `yos self-uninstall` ran `npm uninstall -g @anthropic-ai/claude-code`
 * and deleted `~/.claude`. But the runtime is normally installed by the native
 * script above, which npm knows nothing about — so the uninstall reported
 * success while the `claude` binary was still sitting in the account, still on
 * PATH. "Uninstalled" has to mean uninstalled.
 *
 * It lives in this file on purpose: the code that installs the runtime and the
 * list of what installing it leaves behind must not drift apart, so adding a
 * path is one edit, here.
 *
 * @param {string} home
 * @returns {string[]} paths to remove, deepest-independent first
 */
export function claudeNativeArtifacts(home) {
  return [
    // The launcher on PATH — a symlink into the versioned directory below.
    `${home}/.local/bin/claude`,
    // The versioned payload the launcher points at.
    `${home}/.local/share/claude`,
  ];
}


function sourceHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/**
 * Ordered list of sources to try when installing Claude Code.
 *
 * Pure, so the ordering and the env overrides are testable without a network:
 * the executor below only walks whatever this returns.
 *
 * Overrides — an explicitly empty value drops that source rather than
 * restoring the default, the same rule YOS_DIST_BASE follows:
 *   YOS_CLAUDE_INSTALL_URL  native installer URL   ("" → skip the native step)
 *   YOS_NPM_REGISTRY        mirror registry        ("" → skip the mirror step)
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Array<{id: string, kind: 'script'|'npm', label: string, url?: string, pkg?: string, registry?: string|null}>}
 */
export function planClaudeInstall(env = process.env) {
  const steps = [];

  const nativeUrl = env.YOS_CLAUDE_INSTALL_URL === undefined
    ? CLAUDE_NATIVE_INSTALL_URL
    : String(env.YOS_CLAUDE_INSTALL_URL).trim();
  if (nativeUrl) {
    steps.push({
      id: 'native',
      kind: 'script',
      url: nativeUrl,
      label: `native installer (${sourceHost(nativeUrl)})`,
    });
  }

  // Same registry list every other global install uses — one definition, so a
  // mirror added for PM2 is automatically a mirror for the runtime.
  for (const source of npmInstallSources(env)) {
    steps.push({
      id: source.registry ? 'npm-mirror' : 'npm',
      kind: 'npm',
      pkg: CLAUDE_NPM_PACKAGE,
      registry: source.registry,
      label: source.label,
    });
  }

  return steps;
}

/**
 * Fetch the installer, then run it — deliberately two steps.
 *
 * `curl … | bash` reports the exit status of bash, so a download that never
 * happened still looks like a success: bash reads empty stdin and exits 0. That
 * turns "the host was unreachable" into "installed but not on PATH", which
 * sends the customer to fix the wrong thing. Downloading first keeps the two
 * failures distinguishable, and keeps a half-downloaded error page from being
 * executed.
 *
 * --connect-timeout keeps an unreachable host from burning the whole budget
 * before the next source gets a turn; a slow-but-alive download is untouched.
 */
function runInstallScript(url) {
  const scriptPath = path.join(os.tmpdir(), `yos-runtime-install-${process.pid}.sh`);
  try {
    execFileSync('curl', ['-fsSL', '--connect-timeout', '20', url, '-o', scriptPath], {
      stdio: 'pipe',
      timeout: CLAUDE_INSTALL_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
  try {
    execFileSync('bash', [scriptPath], { stdio: 'pipe', timeout: CLAUDE_INSTALL_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(scriptPath, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Install Claude Code, trying every source in order until one yields a usable
 * `claude` on PATH.
 *
 * A source that reports success but leaves no runnable binary is not accepted —
 * the next source gets a turn, and the attempt is recorded as installed-but-not-found
 * so the caller can tell a download failure from a PATH problem.
 *
 * @param {{ env?: NodeJS.ProcessEnv, onAttempt?: (step: object) => void }} opts
 * @returns {{ ok: boolean, via: string|null, label: string|null, fellBack: boolean, attempts: Array<{id: string, label: string, installed: boolean, found: boolean}> }}
 */
export function installClaude(opts = {}) {
  const { env = process.env, onAttempt = null } = opts;
  const steps = planClaudeInstall(env);
  const attempts = [];

  for (const step of steps) {
    if (onAttempt) onAttempt(step);
    const installed = step.kind === 'script'
      ? runInstallScript(step.url)
      : installGlobalPackage(step.pkg, {
        registry: step.registry,
        timeout: CLAUDE_INSTALL_TIMEOUT_MS,
      });
    const found = installed ? commandExists('claude') : false;
    attempts.push({ id: step.id, label: step.label, installed, found });
    if (found) {
      return {
        ok: true,
        via: step.id,
        label: step.label,
        fellBack: attempts.length > 1,
        attempts,
      };
    }
  }

  return { ok: false, via: null, label: null, fellBack: false, attempts };
}

/**
 * Human-readable repair lines for a failed installClaude() run.
 * Leads with what actually happened, then the manual routes.
 * @param {{ attempts: Array<{label: string, installed: boolean, found: boolean}> }} result
 * @returns {string[]}
 */
export function describeClaudeInstallFailure(result) {
  const attempts = result?.attempts ?? [];
  const lines = attempts.map(a => (
    a.installed && !a.found
      ? `Tried ${a.label}: reported success but no "claude" on PATH — add ~/.local/bin to your PATH.`
      : `Tried ${a.label}: failed.`
  ));
  lines.push(`Install manually: curl -fsSL ${CLAUDE_NATIVE_INSTALL_URL} | bash`);
  lines.push(`Or via npm: npm install -g ${CLAUDE_NPM_PACKAGE}`);
  lines.push(`Behind a slow link, point npm at a reachable mirror: npm install -g ${CLAUDE_NPM_PACKAGE} --registry=${DEFAULT_NPM_MIRROR}`);
  return lines;
}

// ── Auth checks ────────────────────────────────────────────────────────────

/**
 * Check if Claude Code is authenticated.
 * Reads the explicit `loggedIn` field from `claude auth status --json` rather
 * than trusting the process exit code. Local-only — reads stored credentials,
 * no network call.
 * @returns {boolean}
 */
export function isClaudeAuthenticated() {
  try {
    const result = spawnSync('claude', ['auth', 'status', '--json'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
    });
    return parseClaudeAuthStatus(result.stdout);
  } catch {
    return false;
  }
}

/**
 * Check if Codex CLI is authenticated.
 * Checks three paths in order:
 *   1. Process env vars (OPENAI_API_KEY / CODEX_API_KEY) — set in-process by saveCodexApiKey()
 *      during the current init run
 *   2. ~/.codex/auth.json — direct read for auth_mode=apikey (avoids relying on `codex login status`
 *      which may return non-zero for API-key-only auth on some Codex CLI versions)
 *   3. `codex login status` — authoritative CLI check for OAuth/device auth (chatgpt auth_mode)
 * Note: does NOT read ~/yos/.env — Codex CLI deliberately ignores env vars, so an API key
 * in .env has no meaning for Codex. Keys are stored in ~/.codex/auth.json (see saveCodexApiKey).
 * @returns {boolean}
 */
export function isCodexAuthenticated() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;

  // Direct auth.json check — handles auth_mode=apikey without relying on CLI behavior.
  try {
    const authJson = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'
    ));
    if (authJson?.auth_mode === 'apikey' && (authJson?.OPENAI_API_KEY || authJson?.apiKey)) {
      return true;
    }
  } catch { /* auth.json absent or malformed — fall through */ }

  // Use `codex login status` as the authoritative check for OAuth/device auth.
  // NOTE: `codex login status` exits 0 in BOTH states ("Logged in using ..." and
  // "Not logged in"), so the exit code is meaningless — parse the output text.
  // The status line is written to STDERR (stdout is empty), so combine streams.
  try {
    const result = spawnSync('codex', ['login', 'status'], {
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    });
    return parseCodexLoginStatus((result.stdout || '') + (result.stderr || ''));
  } catch {
    return false;
  }
}

// ── Claude credential helpers ──────────────────────────────────────────────

/**
 * Pre-approve an API key / setup token in ~/.claude.json so Claude Code skips
 * the interactive "Detected a custom API key" confirmation prompt.
 * Also marks onboarding as complete.
 * @param {string} keyOrToken
 */
export function approveApiKey(keyOrToken) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch {}
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    const keySuffix = keyOrToken.slice(-20);
    if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
      config.customApiKeyResponses.approved.push(keySuffix);
    }
    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      try {
        const ver = execSync('claude --version 2>/dev/null', { encoding: 'utf8' }).trim();
        config.lastOnboardingVersion = ver;
      } catch { /* omit if claude binary not yet available */ }
    }
    if (!config.projects) config.projects = {};
    const projectPath = path.resolve(YOS_DIR);
    if (!config.projects[projectPath]) config.projects[projectPath] = {};
    if (!config.projects[projectPath].hasTrustDialogAccepted) {
      config.projects[projectPath].hasTrustDialogAccepted = true;
      config.projects[projectPath].hasCompletedProjectOnboarding = true;
    }
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch {}
}

/**
 * Save an Anthropic API key to ~/.claude/settings.json and pre-approve it.
 * @param {string} apiKey - The API key (sk-ant-api...)
 * @returns {boolean}
 */
export function saveApiKey(apiKey) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_API_KEY = apiKey;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    return false;
  }
  approveApiKey(apiKey);
  process.env.ANTHROPIC_API_KEY = apiKey;
  return true;
}

/**
 * Write ANTHROPIC_API_KEY to ~/yos/.env.
 * @param {string} apiKey
 */
export function saveApiKeyToEnv(apiKey) {
  const envPath = path.join(YOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'ANTHROPIC_API_KEY', apiKey, 'Anthropic API key (set by yos init)');
    fs.writeFileSync(envPath, content);
  } catch {}
}

/**
 * Save a Claude Code setup token to ~/.claude/settings.json and pre-approve it.
 * Removes any existing API key to avoid having both.
 * @param {string} token - The setup token (sk-ant-oat...)
 * @returns {boolean}
 */
export function saveSetupToken(token) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    delete settings.env.ANTHROPIC_API_KEY;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    return false;
  }
  approveApiKey(token);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return true;
}

/**
 * Write CLAUDE_CODE_OAUTH_TOKEN to ~/yos/.env.
 * Removes any existing ANTHROPIC_API_KEY line to avoid having both.
 * @param {string} token
 */
export function saveSetupTokenToEnv(token) {
  const envPath = path.join(YOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'CLAUDE_CODE_OAUTH_TOKEN', token, 'Claude Code setup token (set by yos init)');
    content = content.replace(/^# Anthropic API key \(set by yos init\)\n/m, '');
    content = content.replace(/^\s*ANTHROPIC_API_KEY\s*=.*\n?/m, '');
    fs.writeFileSync(envPath, content);
  } catch {}
}

/**
 * Set ANTHROPIC_BASE_URL in process.env for the current process.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveClaudeBaseUrl(baseUrl) {
  try {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write ANTHROPIC_BASE_URL to Claude settings.json.
 * @param {string} baseUrl
 * @returns {boolean}
 */
function saveClaudeBaseUrlToSettings(baseUrl) {
  const settingsDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
    if (!settings.env) settings.env = {};
    settings.env.ANTHROPIC_BASE_URL = baseUrl;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Write ANTHROPIC_BASE_URL to Claude settings.json and ~/yos/.env.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveClaudeBaseUrlToSettingsAndEnv(baseUrl) {
  const envPath = path.join(YOS_DIR, '.env');
  try {
    if (!saveClaudeBaseUrlToSettings(baseUrl)) return false;
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'ANTHROPIC_BASE_URL', baseUrl, 'Anthropic base URL for Claude Code (set by yos init)');
    fs.writeFileSync(envPath, content);
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

// ── Codex credential helpers ───────────────────────────────────────────────

const CODEX_PROJECT_HEADER = [
  '# YOS project-level Codex config.',
  '# YOS applies overwrite, backfill, key-level, and exact-replacement settings; other settings are preserved.',
].join('\n');

const CODEX_GLOBAL_HEADER = [
  '# Codex global config.',
  '# YOS manages its project trust entry and optional base URL; other settings are preserved.',
].join('\n');

const CODEX_NOTICE = {
  hide_full_access_warning: true,
  hide_world_writable_warning: true,
  hide_rate_limit_model_nudge: true,
  hide_gpt5_1_migration_prompt: true,
  'hide_gpt-5.1-codex-max_migration_prompt': true,
};

const CODEX_MODEL_MIGRATIONS = {
  'gpt-5.3-codex': 'gpt-5.4',
};

function parseCodexToml(content) {
  if (!content.trim()) return {};
  try {
    return parse(content);
  } catch {
    return {};
  }
}

function tomlWithHeader(header, obj) {
  return `${header}\n\n${stringify(obj)}`;
}

function isTomlSectionValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Render project-level .codex/config.toml with headless configuration.
 *
 * Contains settings required for yos unattended operation: interactive prompt
 * suppression, feature flags, and model migration acknowledgements. These are
 * project requirements, not user preferences.
 *
 * Written to <projectDir>/.codex/config.toml (Codex project-level config).
 *
 * @param {string} existingContent - Existing project config.toml contents (optional)
 * @returns {string}
 */
export function renderCodexProjectConfig(existingContent = '') {
  const obj = parseCodexToml(existingContent);

  // Always overwrite: these values are required for unattended YOS runtime behavior.
  obj.check_for_update_on_startup = false;
  obj.model_availability_nux = 'gpt-5.4';

  // Backfill: default only when the user has not configured a value.
  if (obj.model === undefined) obj.model = 'gpt-5.5';
  if (obj.model_reasoning_effort === undefined) obj.model_reasoning_effort = 'medium';

  obj.features = isTomlSectionValue(obj.features) ? obj.features : {};
  obj.features.multi_agent = true;
  obj.features.fast_mode = false;
  obj.features.hooks = true;

  const existingNotice = isTomlSectionValue(obj.notice) ? obj.notice : {};
  const notice = { ...CODEX_NOTICE };
  for (const [key, value] of Object.entries(existingNotice)) {
    if (key !== 'model_migrations' && isTomlSectionValue(value)) {
      notice[key] = value;
    }
  }
  notice.model_migrations = { ...CODEX_MODEL_MIGRATIONS };
  obj.notice = notice;

  return tomlWithHeader(CODEX_PROJECT_HEADER, obj);
}

/**
 * Render global ~/.codex/config.toml with user/environment-level settings.
 *
 * Contains only trust declarations and optional base URL override.
 * Existing [projects.*] trust entries are preserved; the yos project trust
 * entry is always regenerated.
 *
 * @param {string} projectDir - The yos working directory to pre-trust
 * @param {string} existingContent - Existing global config.toml contents (optional)
 * @param {{ openaiBaseUrl?: string }} opts - Optional Codex config overrides
 * @returns {string}
 */
export function renderCodexGlobalConfig(projectDir, existingContent = '', opts = {}) {
  const absProject = path.resolve(projectDir);
  const openaiBaseUrl = opts.openaiBaseUrl || process.env.OPENAI_BASE_URL || '';
  const obj = parseCodexToml(existingContent);
  if (openaiBaseUrl) {
    obj.openai_base_url = openaiBaseUrl;
  }
  obj.features = isTomlSectionValue(obj.features) ? obj.features : {};
  obj.features.hooks = true;
  obj.projects = isTomlSectionValue(obj.projects) ? obj.projects : {};
  obj.projects[absProject] = { trust_level: 'trusted' };
  return tomlWithHeader(CODEX_GLOBAL_HEADER, obj);
}

/**
 * Write Codex configuration to both project-level and global locations.
 *
 * - Project config (<projectDir>/.codex/config.toml): headless settings,
 *   features, notice suppression — required for yos unattended operation.
 * - Global config (~/.codex/config.toml): trust declarations, optional
 *   base URL override.
 *
 * Called by both `yos init` (Codex runtime) and `yos runtime codex` so the
 * config is always present when switching to Codex.
 *
 * @param {string} projectDir - The yos working directory to pre-trust
 * @returns {boolean} true on success
 */
export function writeCodexConfig(projectDir, opts = {}) {
  try {
    // Write project-level config
    const projectCodexDir = path.join(path.resolve(projectDir), '.codex');
    fs.mkdirSync(projectCodexDir, { recursive: true });
    const projectConfigPath = path.join(projectCodexDir, 'config.toml');
    let existingProject = '';
    try {
      existingProject = fs.readFileSync(projectConfigPath, 'utf8');
    } catch { /* new file — nothing to preserve */ }
    fs.writeFileSync(
      projectConfigPath,
      renderCodexProjectConfig(existingProject),
      'utf8'
    );

    // Write global config
    const globalCodexDir = path.join(os.homedir(), '.codex');
    const globalConfigPath = path.join(globalCodexDir, 'config.toml');
    let existing = '';
    try {
      existing = fs.readFileSync(globalConfigPath, 'utf8');
    } catch { /* new file — nothing to preserve */ }
    fs.mkdirSync(globalCodexDir, { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      renderCodexGlobalConfig(projectDir, existing, opts),
      'utf8'
    );

    installCoreCodexHook({ yosDir: projectDir });

    return true;
  } catch {
    return false;
  }
}

/**
 * Persist an OpenAI API key to ~/.codex/auth.json (Codex's native credential store).
 * Also sets OPENAI_API_KEY in process.env for the current init process so that
 * isCodexAuthenticated() can detect it immediately without re-reading disk.
 *
 * We do NOT write to ~/yos/.env — Codex CLI deliberately does not read OPENAI_API_KEY
 * from environment variables, so a key in .env has no effect on Codex. The canonical
 * credential store is auth.json.
 *
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKey(apiKey) {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    fs.mkdirSync(codexDir, { recursive: true });
    let authContent = {};
    try { authContent = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { }
    authContent.auth_mode = 'apikey';
    authContent.OPENAI_API_KEY = apiKey;
    fs.writeFileSync(authPath, JSON.stringify(authContent, null, 2) + '\n', { mode: 0o600 });
    process.env.OPENAI_API_KEY = apiKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write OPENAI_API_KEY to ~/yos/.env for runtime processes that still read it there.
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKeyToEnv(apiKey) {
  const envPath = path.join(YOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'OPENAI_API_KEY', apiKey, 'OpenAI API key for Codex (set by yos init)');
    fs.writeFileSync(envPath, content);
    process.env.OPENAI_API_KEY = apiKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Set OPENAI_BASE_URL in process.env for the current process.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveCodexBaseUrl(baseUrl) {
  try {
    process.env.OPENAI_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write OPENAI_BASE_URL to ~/yos/.env.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveCodexBaseUrlToEnv(baseUrl) {
  const envPath = path.join(YOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'OPENAI_BASE_URL', baseUrl, 'OpenAI base URL for Codex (set by yos init)');
    fs.writeFileSync(envPath, content);
    process.env.OPENAI_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}
