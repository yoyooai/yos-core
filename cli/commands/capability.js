import fs from 'node:fs';
import path from 'node:path';

import { SKILLS_DIR, getYosConfig } from '../lib/config.js';
import { loadComponents } from '../lib/components.js';
import { loadLocalRegistry, loadShelfCapabilityCatalog } from '../lib/registry.js';
import {
  buildLocalCapabilityCatalog,
  discoverLocalCapabilityProviders,
  mergeCapabilityCatalogs,
} from '../lib/capability-catalog.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CORE_SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills');

function readCoreVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

export async function loadLocalCapabilityCatalog() {
  const components = loadComponents();
  const registry = loadLocalRegistry();
  const providers = discoverLocalCapabilityProviders({
    coreSkillsDir: CORE_SKILLS_DIR,
    installedSkillsDir: SKILLS_DIR,
    components,
    registry,
  });
  const catalog = buildLocalCapabilityCatalog({
    ...providers,
    coreVersion: readCoreVersion(),
    nodeVersion: process.version,
    // Runtime-scoped declarations are dropped for other runtimes. Customers
    // install Codex by default, so without this the list carries entries that
    // can never run on the machine reading it.
    activeRuntime: getYosConfig().runtime ?? null,
  });
  return catalog;
}

export async function loadCapabilityCatalog({ env = process.env } = {}) {
  const local = await loadLocalCapabilityCatalog();
  const remote = await loadShelfCapabilityCatalog({ env });
  return mergeCapabilityCatalogs(local, remote, {
    coreVersion: readCoreVersion(),
    nodeVersion: process.version,
  });
}

function publicCatalog(catalog) {
  const { healthChecks: ignored, ...publicView } = catalog;
  return publicView;
}

function includesKeyword(capability, keyword) {
  const needle = keyword.toLowerCase();
  return [
    capability.id,
    capability.title,
    ...capability.keywords,
    ...capability.operations,
    ...capability.providers.map((provider) => provider.id),
  ].some((value) => String(value).toLowerCase().includes(needle));
}

function printCapability(capability, stdout) {
  stdout(`${capability.id}  ${capability.title}`);
  stdout(`  Operations: ${capability.operations.join(', ')}`);
  for (const provider of capability.providers) {
    stdout(`  - ${provider.id} [${provider.source}, ${provider.status}, ${provider.provenance}]`);
  }
}

function printUndeclaredProviders(catalog, stdout) {
  const undeclared = (catalog.providers ?? [])
    .filter(({ declarationStatus }) => declarationStatus === 'undeclared')
    .map(({ id }) => id)
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (undeclared.length === 0) return;
  stdout(`Undeclared capabilities: ${undeclared.join(', ')}`);
}

export async function capabilityCommand(args, dependencies = {}) {
  const loadCatalog = dependencies.loadCatalog ?? loadCapabilityCatalog;
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const setExitCode = dependencies.setExitCode ?? ((code) => { process.exitCode = code; });
  const json = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  const action = positional[0] ?? 'list';
  const value = positional[1];

  function fail(code, message) {
    if (json) stdout(JSON.stringify({ success: false, error: code, message }, null, 2));
    else stderr(`${code}: ${message}`);
    setExitCode(1);
  }

  if (!['list', 'search', 'show', 'providers'].includes(action)) {
    fail('capability_command_unknown', `Unknown capability command: ${action}`);
    return;
  }
  if (action !== 'list' && !value) {
    fail('capability_argument_required', `${action} requires a keyword or capability ID`);
    return;
  }

  let catalog;
  try {
    catalog = publicCatalog(await loadCatalog());
  } catch {
    fail('capability_catalog_invalid', 'Capability declarations could not be read safely. Run yos doctor for details.');
    return;
  }
  if (action === 'list') {
    if (json) stdout(JSON.stringify(catalog, null, 2));
    else if (catalog.capabilities.length === 0) stdout('No capabilities declared.');
    else {
      catalog.capabilities.forEach((capability) => printCapability(capability, stdout));
      printUndeclaredProviders(catalog, stdout);
    }
    return;
  }

  if (action === 'search') {
    const capabilities = catalog.capabilities.filter((capability) => includesKeyword(capability, value));
    if (json) stdout(JSON.stringify({ ...catalog, capabilities }, null, 2));
    else if (capabilities.length === 0) stdout(`No capabilities match "${value}".`);
    else capabilities.forEach((capability) => printCapability(capability, stdout));
    return;
  }

  const capability = catalog.capabilities.find(({ id }) => id === value);
  if (!capability) {
    fail('capability_not_found', `Capability not found: ${value}`);
    return;
  }
  if (action === 'show') {
    if (json) stdout(JSON.stringify({ schemaVersion: catalog.schemaVersion, remote: catalog.remote, capability }, null, 2));
    else printCapability(capability, stdout);
    return;
  }

  if (json) {
    stdout(JSON.stringify({
      schemaVersion: catalog.schemaVersion,
      remote: catalog.remote,
      capabilityId: capability.id,
      providers: capability.providers,
    }, null, 2));
  } else {
    capability.providers.forEach((provider) => stdout(
      `${provider.id}  ${provider.source}  ${provider.status}  ${provider.provenance}`,
    ));
  }
}
