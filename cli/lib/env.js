/**
 * .env file read/write utilities
 *
 * Writes are append-only by default. Callers may explicitly replace blank
 * placeholders while preserving all non-empty user-managed values.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE } from './config.js';

/**
 * Parse the .env file into a Map of key → value.
 * Ignores comments and blank lines.
 *
 * @returns {Map<string, string>}
 */
export function readEnvFile(envFile = ENV_FILE) {
  const env = new Map();
  if (!fs.existsSync(envFile)) return env;

  const content = fs.readFileSync(envFile, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    // Strip surrounding quotes from value
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env.set(key, value);
  }
  return env;
}

/**
 * Of the config keys a component declares as required, which ones are not set.
 *
 * Checked against the process environment and `~/yos/.env` only — a component
 * whose configure hook stores values elsewhere can be fully configured and
 * still show up here, so callers must describe the result as "not found in
 * .env", never as proof that the component is misconfigured.
 *
 * @param {Array<string|{name: string}>} required - SKILL.md `config.required`
 * @param {{ env?: Record<string, string>, readEnv?: () => Map<string, string> }} [deps]
 * @returns {string[]} declared names with no value in either place
 */
export function findUnsetRequiredConfig(required, { env = process.env, readEnv = readEnvFile } = {}) {
  if (!Array.isArray(required) || required.length === 0) return [];

  const fromFile = readEnv();
  const names = required
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter((name) => typeof name === 'string' && name.length > 0);

  return names.filter((name) => {
    const fileValue = fromFile.get(name);
    const envValue = env[name];
    const hasFileValue = typeof fileValue === 'string' && fileValue.trim() !== '';
    const hasEnvValue = typeof envValue === 'string' && envValue.trim() !== '';
    return !hasFileValue && !hasEnvValue;
  });
}

/**
 * Pair the names of unset required values with whatever the component said
 * about them.
 *
 * Naming `FEISHU_APP_ID` tells a customer which value is missing but not where
 * to get it, and the answer is not something we should hardcode per component:
 * components already declare it (`description` in their `config.required`), we
 * were simply dropping it on the floor at the moment it was most useful.
 *
 * @param {Array<string|{name: string, description?: string}>} required
 * @param {string[]} names - Names to describe, typically from findUnsetRequiredConfig
 * @returns {Array<{name: string, description: string}>} description is '' when undeclared
 */
export function describeRequiredConfig(required, names) {
  const wanted = new Set(Array.isArray(names) ? names : []);
  const described = new Map();
  if (Array.isArray(required)) {
    for (const item of required) {
      const name = typeof item === 'string' ? item : item?.name;
      if (typeof name !== 'string' || !wanted.has(name)) continue;
      const description = typeof item === 'object' && typeof item?.description === 'string'
        ? item.description.trim()
        : '';
      described.set(name, description);
    }
  }
  return [...wanted].map((name) => ({ name, description: described.get(name) ?? '' }));
}

/**
 * Append environment entries to .env file.
 * Skips keys that already exist unless replaceEmpty explicitly allows filling
 * an empty placeholder.
 *
 * @param {Map<string, string> | Record<string, string>} entries - Key-value pairs to write
 * @param {string} componentName - Used as section comment header
 * @returns {{ written: string[], skipped: string[] }}
 */
export function writeEnvEntries(entries, componentName, {
  envFile = ENV_FILE,
  replaceEmpty = false,
  replaceExisting = false,
} = {}) {
  const existing = readEnvFile(envFile);
  const written = [];
  const skipped = [];

  const pairs = entries instanceof Map ? entries : new Map(Object.entries(entries));

  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const lines = [];
  for (const [key, value] of pairs) {
    const cleanValue = String(value ?? '').replace(/[\r\n]/g, '').trim();
    if (existing.has(key)) {
      if (replaceExisting || (replaceEmpty && existing.get(key).trim() === '')) {
        const needsQuote = /[\s#"'$`\\]/.test(cleanValue);
        const escaped = cleanValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
        const replacement = `${key}=${needsQuote ? `"${escaped}"` : cleanValue}`;
        const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
        content = content.replace(keyPattern, replacement);
        existing.set(key, cleanValue);
        written.push(key);
        continue;
      }
      skipped.push(key);
      continue;
    }
    // Quote values that contain spaces or special characters
    const needsQuote = /[\s#"'$`\\]/.test(cleanValue);
    const escaped = cleanValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    lines.push(`${key}=${needsQuote ? `"${escaped}"` : cleanValue}`);
    written.push(key);
  }

  if (written.length === 0) return { written, skipped };

  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  if (content !== (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '')) {
    fs.writeFileSync(envFile, content);
  }

  if (lines.length === 0) return { written, skipped };

  // Build block to append
  let block = '\n';
  block += `# ${componentName}\n`;
  block += lines.join('\n') + '\n';

  // Ensure parent directory exists
  fs.appendFileSync(envFile, block);

  return { written, skipped };
}
