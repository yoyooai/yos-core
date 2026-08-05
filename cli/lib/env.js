/**
 * .env file read/write utilities
 *
 * Append-only writes: never overwrites existing keys.
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
export function readEnvFile() {
  const env = new Map();
  if (!fs.existsSync(ENV_FILE)) return env;

  const content = fs.readFileSync(ENV_FILE, 'utf8');
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
 * Append environment entries to .env file.
 * Skips keys that already exist (append-only, never overwrites).
 *
 * @param {Map<string, string> | Record<string, string>} entries - Key-value pairs to write
 * @param {string} componentName - Used as section comment header
 * @returns {{ written: string[], skipped: string[] }}
 */
export function writeEnvEntries(entries, componentName) {
  const existing = readEnvFile();
  const written = [];
  const skipped = [];

  const pairs = entries instanceof Map ? entries : new Map(Object.entries(entries));

  const lines = [];
  for (const [key, value] of pairs) {
    if (existing.has(key)) {
      skipped.push(key);
      continue;
    }
    // Strip any embedded \r\n characters from value
    const cleanValue = value.replace(/[\r\n]/g, '').trim();
    // Quote values that contain spaces or special characters
    const needsQuote = /[\s#"'$`\\]/.test(cleanValue);
    const escaped = cleanValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    lines.push(`${key}=${needsQuote ? `"${escaped}"` : cleanValue}`);
    written.push(key);
  }

  if (lines.length === 0) return { written, skipped };

  // Build block to append
  let block = '\n';
  block += `# ${componentName}\n`;
  block += lines.join('\n') + '\n';

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });

  fs.appendFileSync(ENV_FILE, block);

  return { written, skipped };
}
