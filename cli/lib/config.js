/**
 * Shared configuration constants and helpers
 */

import fs from 'node:fs';
import path from 'node:path';

export const YOS_DIR = process.env.YOS_DIR || path.join(process.env.HOME, 'yos');
export const SKILLS_DIR = path.join(YOS_DIR, '.claude', 'skills');
export const CONFIG_DIR = path.join(YOS_DIR, '.yos');
export const COMPONENTS_DIR = path.join(YOS_DIR, 'components');
export const LOCKS_DIR = path.join(CONFIG_DIR, 'locks');
export const REGISTRY_FILE = path.join(CONFIG_DIR, 'registry.json');
export const COMPONENTS_FILE = path.join(CONFIG_DIR, 'components.json');
export const BIN_DIR = path.join(YOS_DIR, 'bin');
export const ENV_FILE = path.join(YOS_DIR, '.env');
export const HTTP_DIR = path.join(YOS_DIR, 'http');
export const CADDYFILE = path.join(HTTP_DIR, 'Caddyfile');
export const CADDY_BIN = path.join(BIN_DIR, 'caddy');

// ── Config file (config.json) ───────────────────────────────────

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Read the yos config.json.
 * @returns {object} Config object (empty object if file doesn't exist)
 */
export function getYosConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write the yos config.json (merges with existing).
 * @param {object} updates - Key-value pairs to merge into config
 */
export function updateYosConfig(updates) {
  const config = getYosConfig();
  Object.assign(config, updates);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
