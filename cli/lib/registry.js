/**
 * Registry utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY_FILE } from './config.js';
import { fetchRawFile } from './github.js';
import { resolveRegistryRepo } from './release-source.js';

// Built-in registry shipped with the yos package
const BUILTIN_REGISTRY_PATH = path.join(import.meta.dirname, '..', '..', 'registry.json');

const REGISTRY_PATH = 'registry.json';

/**
 * Load built-in registry bundled with yos-core.
 * Returns the components object (unwrapped).
 */
function loadBuiltinRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(BUILTIN_REGISTRY_PATH, 'utf8'));
    return data.components || data;
  } catch {
    return {};
  }
}

/**
 * Load local registry from ~/.yos/registry.json, merged with built-in.
 * Built-in provides defaults; local file overrides.
 * Returns the components object (unwrapped from version/components structure)
 */
export function loadLocalRegistry() {
  const builtin = loadBuiltinRegistry();
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    const local = data.components || data;
    return { ...builtin, ...local };
  } catch {
    return builtin;
  }
}

/**
 * Load registry with fallback chain:
 * 1. Explicit remote registry from YOS_REGISTRY_REPO (supports private repos)
 * 2. Local registry (~/.yos/registry.json) + built-in
 *
 * Returns the components object (unwrapped)
 */
export async function loadRegistry() {
  // loadLocalRegistry already merges built-in + local file
  const fallback = loadLocalRegistry();

  const registrySource = resolveRegistryRepo();
  if (!registrySource.success) return fallback;

  try {
    const content = fetchRawFile(registrySource.repo, REGISTRY_PATH);
    const parsed = JSON.parse(content);
    return parsed.components || parsed;
  } catch {
    return fallback;
  }
}
