/**
 * claude-credentials.js — the single place that knows what YOS writes into
 * Claude Code's own config files, and the only place that writes/removes it.
 *
 * Two files belong to Claude Code, not to YOS, yet YOS writes into both:
 *   ~/.claude/settings.json   → env.ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
 *                               / ANTHROPIC_BASE_URL
 *   ~/.claude.json            → customApiKeyResponses.approved (key suffix)
 *
 * Why this module exists:
 *  - The approved-suffix write had two independent implementations
 *    (runtime-setup.js and runtime/claude.js). Editing one left the other
 *    behind, and no test went red. (TD-115)
 *  - `yos uninstall --self` never took any of it back: a customer who declined
 *    "remove Claude CLI" (the default) was left with our key and our gateway
 *    address in his own config after we said we had uninstalled. (TD-114)
 *
 * The removal rule is deliberately conservative: a value is ours to delete only
 * when ~/yos/.env — the file YOS itself wrote at install time — still holds the
 * same value. If the customer changed it, or we cannot read our own .env, the
 * entry stays and the uninstall says so. Deleting a credential we cannot prove
 * we installed would destroy a Claude Code setup that predates YOS.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The `env` keys YOS writes into ~/.claude/settings.json.
 * Whoever adds another one edits this list — see the writers in
 * runtime-setup.js (saveApiKey / saveSetupToken / saveClaudeBaseUrlToSettings).
 */
export const CLAUDE_SETTINGS_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];

/** Keys above that are credentials (their suffix also lands in ~/.claude.json). */
const CREDENTIAL_KEYS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

export function claudeSettingsPath(home = os.homedir()) {
  return path.join(home, '.claude', 'settings.json');
}

export function claudeJsonPath(home = os.homedir()) {
  return path.join(home, '.claude.json');
}

/**
 * Pre-approve a key/token in ~/.claude.json so Claude Code skips its
 * interactive "Detected a custom API key" confirmation.
 *
 * This is THE implementation — callers must not write
 * customApiKeyResponses.approved themselves (a duplicate is what TD-115 was).
 *
 * @param {string} keyOrToken
 * @param {{home?: string}} [opts]
 * @returns {boolean} true when the suffix is registered (already or now)
 */
export function approveCustomApiKey(keyOrToken, { home = os.homedir() } = {}) {
  if (!keyOrToken) return false;
  const target = claudeJsonPath(home);
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { }
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    const suffix = credentialSuffix(keyOrToken);
    if (!config.customApiKeyResponses.approved.includes(suffix)) {
      config.customApiKeyResponses.approved.push(suffix);
      fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
    }
    return true;
  } catch {
    return false;
  }
}

/** The form a credential takes inside ~/.claude.json. */
export function credentialSuffix(keyOrToken) {
  return String(keyOrToken).slice(-20);
}

/** Read `KEY=value` out of the dotenv body YOS wrote. '' when absent. */
function parseEnvValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Take back what YOS put into Claude Code's own config files.
 *
 * @param {{home?: string, yosDir?: string}} [opts]
 * @returns {{
 *   settingsPath: string,
 *   removed: string[],
 *   kept: Array<{key: string, reason: string}>,
 *   approvedRemoved: number,
 * }}
 */
export function reclaimClaudeCredentials({ home = os.homedir(), yosDir } = {}) {
  const settingsPath = claudeSettingsPath(home);
  const result = { settingsPath, removed: [], kept: [], approvedRemoved: 0 };

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return result; // nothing of ours there, or not ours to rewrite
  }
  if (!settings || typeof settings !== 'object' || !settings.env) return result;

  // ~/yos/.env is the receipt: it holds what we wrote at install time.
  let envBody = null;
  try {
    envBody = fs.readFileSync(path.join(yosDir, '.env'), 'utf8');
  } catch {
    envBody = null;
  }

  const removedCredentials = [];
  for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
    const current = settings.env[key];
    if (current === undefined) continue;

    if (envBody === null) {
      result.kept.push({ key, reason: 'cannot read ~/yos/.env, so cannot prove YOS wrote it' });
      continue;
    }
    const installed = parseEnvValue(envBody, key);
    if (!installed) {
      result.kept.push({ key, reason: 'not in ~/yos/.env — YOS did not write it' });
      continue;
    }
    if (String(current) !== installed) {
      result.kept.push({ key, reason: 'changed since install — this value is yours, not ours' });
      continue;
    }

    delete settings.env[key];
    result.removed.push(key);
    if (CREDENTIAL_KEYS.has(key)) removedCredentials.push(String(current));
  }

  if (result.removed.length === 0) return result;

  if (Object.keys(settings.env).length === 0) delete settings.env;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    // Could not write it back — report nothing removed rather than claim it.
    return { settingsPath, removed: [], kept: result.kept, approvedRemoved: 0 };
  }

  result.approvedRemoved = forgetApprovedCredentials(removedCredentials, { home });
  return result;
}

/**
 * Drop the approved suffixes of credentials we just removed from
 * ~/.claude.json. Only suffixes matching those exact credentials are touched.
 *
 * @param {string[]} credentials
 * @param {{home?: string}} [opts]
 * @returns {number} how many entries were dropped
 */
export function forgetApprovedCredentials(credentials, { home = os.homedir() } = {}) {
  if (!credentials || credentials.length === 0) return 0;
  const target = claudeJsonPath(home);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return 0;
  }
  const approved = config?.customApiKeyResponses?.approved;
  if (!Array.isArray(approved)) return 0;

  const suffixes = new Set(credentials.map(credentialSuffix));
  const kept = approved.filter((entry) => !suffixes.has(entry));
  if (kept.length === approved.length) return 0;

  config.customApiKeyResponses.approved = kept;
  try {
    fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  } catch {
    return 0;
  }
  return approved.length - kept.length;
}
