/**
 * api-endpoint.js — single source of truth for "which API endpoint do we talk to".
 *
 * A YOS install may point at a self-hosted gateway instead of the vendor's
 * official endpoint. Every credential probe and reachability check must target
 * the SAME endpoint the runtime will actually use. Probing api.anthropic.com
 * while the runtime talks to a private gateway produces both false failures
 * (a gateway customer behind a firewall is told their good key is invalid) and
 * false passes (doctor greenlights a host nobody uses).
 *
 * Resolution order mirrors what the launched runtime actually sees:
 *   Claude — explicit override → ~/yos/.env → ~/.claude/settings.json → process.env → official
 *            (.env wins because ClaudeAdapter injects it over the ambient env at launch;
 *             yos writes .env and settings.json together, so they normally agree)
 *   Codex  — explicit override → ~/.codex/config.toml → process.env → official
 *            (config.toml wins because the Codex CLI reads it natively and
 *             deliberately ignores OPENAI_* env vars)
 *
 * Reading the stored config — not just the command-line flag — is what makes a
 * second `yos init` with no flags keep talking to the customer's gateway.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { YOS_DIR } from './config.js';

export const OFFICIAL_CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const OFFICIAL_CODEX_BASE_URL = 'https://api.openai.com/v1';

/** Hostnames that mean "the vendor's own endpoint", not a customer gateway. */
const OFFICIAL_HOSTNAMES = new Set(
  [OFFICIAL_CLAUDE_BASE_URL, OFFICIAL_CODEX_BASE_URL].map((u) => new URL(u).hostname)
);

function trimSlashes(value) {
  return String(value).trim().replace(/\/+$/, '');
}

/** Read `KEY=value` from a dotenv-style file body. Returns '' when absent. */
function parseEnvValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function readYosEnvValue(key) {
  try {
    return parseEnvValue(fs.readFileSync(path.join(YOS_DIR, '.env'), 'utf8'), key);
  } catch {
    return '';
  }
}

function readClaudeSettingsBaseUrl() {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')
    );
    return settings?.env?.ANTHROPIC_BASE_URL || '';
  } catch {
    return '';
  }
}

function readCodexConfigBaseUrl() {
  try {
    const config = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    return config.match(/^\s*openai_base_url\s*=\s*"([^"]+)"\s*$/m)?.[1] || '';
  } catch {
    return '';
  }
}

function firstConfigured(candidates, fallback) {
  for (const candidate of candidates) {
    if (candidate && String(candidate).trim()) return trimSlashes(candidate);
  }
  return fallback;
}

/**
 * Resolve the Anthropic-compatible base URL this install talks to.
 * @param {string} [override] - Explicit value (e.g. `yos init --base-url`), wins over config.
 * @returns {string} Base URL with no trailing slash.
 */
export function resolveClaudeBaseUrl(override) {
  return firstConfigured([
    override,
    readYosEnvValue('ANTHROPIC_BASE_URL'),
    readClaudeSettingsBaseUrl(),
    process.env.ANTHROPIC_BASE_URL,
  ], OFFICIAL_CLAUDE_BASE_URL);
}

/**
 * Resolve the OpenAI-compatible base URL this install talks to.
 * @param {string} [override] - Explicit value (e.g. `yos init --codex-base-url`).
 * @returns {string} Base URL with no trailing slash (conventionally ends in /v1).
 */
export function resolveCodexBaseUrl(override) {
  return firstConfigured(
    [override, readCodexConfigBaseUrl(), process.env.OPENAI_BASE_URL],
    OFFICIAL_CODEX_BASE_URL
  );
}

/**
 * Resolve the base URL for whichever runtime is active.
 * @param {'claude'|'codex'} runtime
 * @param {string} [override]
 * @returns {string}
 */
export function resolveRuntimeBaseUrl(runtime, override) {
  return runtime === 'codex' ? resolveCodexBaseUrl(override) : resolveClaudeBaseUrl(override);
}

/**
 * True when the endpoint is a customer gateway rather than the vendor's host.
 * Error messages branch on this: telling a gateway customer to "check your key
 * at console.anthropic.com" points them at an account that never saw the key.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isCustomEndpoint(baseUrl) {
  return describeEndpoint(baseUrl).custom;
}

/**
 * Split a base URL into the parts network checks need.
 * Falls back to the official endpoint when the configured value is unparseable,
 * so a malformed config degrades to a working check rather than a crash.
 *
 * @param {string} baseUrl
 * @param {string} [fallback=OFFICIAL_CLAUDE_BASE_URL]
 * @returns {{ origin: string, hostname: string, host: string, isIpLiteral: boolean, custom: boolean }}
 */
export function describeEndpoint(baseUrl, fallback = OFFICIAL_CLAUDE_BASE_URL) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    url = new URL(fallback);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return {
    origin: url.origin,
    hostname,
    host: url.host,
    // DNS resolution is meaningless for a literal address — callers skip it.
    isIpLiteral: /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':'),
    custom: !OFFICIAL_HOSTNAMES.has(hostname),
  };
}

/**
 * Build the URL for a credential probe against a base URL.
 *
 * Handles the `/v1` convention mismatch: OpenAI-style base URLs conventionally
 * already end in `/v1`, Anthropic-style ones do not. Appending blindly yields
 * `/v1/v1/models`, which a gateway answers with 404 — indistinguishable from a
 * bad key unless we get the path right.
 *
 * @param {string} baseUrl - Configured base URL
 * @param {string} apiPath - API path beginning with `/v1/`
 * @returns {{ url: string, host: string }|null} null when the base URL is unusable
 */
export function buildProbeUrl(baseUrl, apiPath) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  // A gateway may legitimately be plain http on a private network; anything
  // that is not http(s) is a configuration mistake, not something to probe.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const basePath = url.pathname.replace(/\/+$/, '');
  const suffix = /\/v1$/.test(basePath) && apiPath.startsWith('/v1/')
    ? apiPath.slice('/v1'.length)
    : apiPath;

  return { url: `${url.origin}${basePath}${suffix}`, host: url.host };
}
