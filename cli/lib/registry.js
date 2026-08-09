/**
 * Registry utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REGISTRY_FILE } from './config.js';
import { resolveDistBase } from './dist-origin.js';
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
  return (await loadRegistryWithStatus()).components;
}

/**
 * Load the legacy component registry without hiding a configured-source failure.
 * Existing callers can keep using loadRegistry(); capability discovery uses the
 * status-bearing form so a remote outage is visible to users.
 */
export async function loadRegistryWithStatus({
  env = process.env,
  loadFallback = loadLocalRegistry,
  fetchRemote = fetchRawFile,
} = {}) {
  const fallback = loadFallback();
  const registrySource = resolveRegistryRepo(env);
  if (!registrySource.success) {
    return {
      components: fallback,
      source: 'fallback',
      status: 'not_configured',
      errorCode: registrySource.error,
    };
  }

  try {
    const content = fetchRemote(registrySource.repo, REGISTRY_PATH);
    const parsed = JSON.parse(content);
    return {
      components: parsed.components || parsed,
      source: 'remote',
      status: 'available',
      errorCode: null,
    };
  } catch {
    return {
      components: fallback,
      source: 'fallback',
      status: 'unreachable',
      errorCode: 'registry_unreachable',
    };
  }
}

const BUILD_ID_PATTERN = /^[0-9a-f]{64}$/;
const CAPABILITY_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function fetchShelfText(url) {
  return execFileSync('curl', [
    '-fsSL',
    '--max-time', '10',
    '--max-filesize', String(2 * 1024 * 1024),
    '--proto', '=https,http',
    '--proto-redir', '=https',
    url,
  ], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertShelfCapabilityCatalog(index, catalog) {
  if (index?.schemaVersion !== 1 || catalog?.schemaVersion !== 1) {
    throw new Error('unsupported capability catalog schema');
  }
  if (!BUILD_ID_PATTERN.test(index.buildId) || !BUILD_ID_PATTERN.test(catalog.buildId)) {
    throw new Error('invalid capability catalog build identity');
  }
  if (index.buildId !== catalog.buildId) {
    const error = new Error('capability catalog build identity mismatch');
    error.code = 'capability_registry_build_mismatch';
    throw error;
  }
  if (!Array.isArray(index.repos) || !Array.isArray(catalog.capabilities)) {
    throw new Error('invalid capability catalog structure');
  }

  const published = new Set();
  for (const repo of index.repos) {
    if (typeof repo?.repo !== 'string' || !Array.isArray(repo.tags)) {
      throw new Error('invalid capability catalog repository');
    }
    for (const tag of repo.tags) published.add(`${repo.repo}\0${tag}`);
  }

  const capabilityIds = new Set();
  for (const capability of catalog.capabilities) {
    if (!capability || typeof capability.id !== 'string' || capabilityIds.has(capability.id)
      || typeof capability.title !== 'string' || !Array.isArray(capability.keywords)
      || !Array.isArray(capability.operations) || !Array.isArray(capability.providers)) {
      throw new Error('invalid capability declaration');
    }
    capabilityIds.add(capability.id);
    for (const operation of capability.operations) {
      if (!CAPABILITY_IDENTIFIER.test(operation)) throw new Error('invalid capability operation');
    }
    for (const provider of capability.providers) {
      const allowed = new Set([
        'id', 'registryName', 'repo', 'tag', 'path', 'version', 'source', 'provenance',
        'stability', 'operations', 'coreRange', 'nodeRange',
      ]);
      if (!provider || Object.keys(provider).some((key) => !allowed.has(key))
        || typeof provider.id !== 'string' || typeof provider.registryName !== 'string'
        || typeof provider.repo !== 'string' || typeof provider.tag !== 'string'
        || !published.has(`${provider.repo}\0${provider.tag}`)
        || !Array.isArray(provider.operations)) {
        throw new Error('invalid capability provider');
      }
      for (const operation of provider.operations) {
        if (!CAPABILITY_IDENTIFIER.test(operation)) throw new Error('invalid provider operation');
      }
    }
  }
}

function assertCapabilityArtifactIntegrity(index, capabilityText) {
  const entries = index.files?.filter((entry) => entry?.path === 'capabilities.json') ?? [];
  if (entries.length !== 1) {
    const error = new Error('capability artifact is not covered by index.json');
    error.code = 'capability_registry_integrity_mismatch';
    throw error;
  }
  const entry = entries[0];
  const bytes = Buffer.byteLength(capabilityText);
  const digest = crypto.createHash('sha256').update(capabilityText).digest('hex');
  if (entry.bytes !== bytes || entry.sha256 !== digest) {
    const error = new Error('capability artifact integrity mismatch');
    error.code = 'capability_registry_integrity_mismatch';
    throw error;
  }
}

/** Load the two same-build shelf documents used by capability discovery. */
export async function loadShelfCapabilityCatalog({
  env = process.env,
  fetchText = fetchShelfText,
} = {}) {
  try {
    const origin = resolveDistBase(env);
    if (!origin.enabled) {
      return { status: 'not_configured', source: 'shelf', errorCode: null, catalog: null };
    }
    const [indexText, capabilityText] = await Promise.all([
      Promise.resolve(fetchText(`${origin.base}/index.json`)),
      Promise.resolve(fetchText(`${origin.base}/capabilities.json`)),
    ]);
    let index;
    let catalog;
    try {
      index = JSON.parse(indexText);
      catalog = JSON.parse(capabilityText);
      assertShelfCapabilityCatalog(index, catalog);
      assertCapabilityArtifactIntegrity(index, capabilityText);
    } catch (error) {
      if (['capability_registry_build_mismatch', 'capability_registry_integrity_mismatch'].includes(error?.code)) {
        throw error;
      }
      const invalid = new Error('invalid capability catalog');
      invalid.code = 'capability_registry_invalid';
      throw invalid;
    }
    return { status: 'available', source: 'shelf', errorCode: null, catalog };
  } catch (error) {
    return {
      status: 'degraded',
      source: 'shelf',
      errorCode: [
        'capability_registry_build_mismatch',
        'capability_registry_integrity_mismatch',
        'capability_registry_invalid',
      ].includes(error?.code)
        ? error.code
        : 'capability_registry_unreachable',
      catalog: null,
    };
  }
}
