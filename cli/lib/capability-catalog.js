import fs from 'node:fs';
import path from 'node:path';

import { parseCapabilitySkill } from './capability-schema.js';
import { canonicalCapabilityTitle } from './capability-titles.js';
import {
  checkNodeEngine,
  checkYosCoreCompatibility,
  readDeclaredNodeRange,
  readDeclaredYosContract,
} from './component-engines.js';

function readPackageVersion(providerDir, readFile) {
  try {
    const pkg = JSON.parse(readFile(path.join(providerDir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function normalizeProvider(provider, source, options) {
  const declaration = parseCapabilitySkill(provider.dir, options);
  const yosContract = source === 'component'
    ? readDeclaredYosContract(provider.dir, options)
    : null;
  const nodeRange = readDeclaredNodeRange(provider.dir, options);
  const node = checkNodeEngine(nodeRange, options.nodeVersion);
  const core = source === 'component'
    ? checkYosCoreCompatibility(yosContract?.core ?? null, options.coreVersion)
    : { checked: false, satisfied: true, range: null, running: options.coreVersion };
  const compatible = node.satisfied && core.satisfied;

  return {
    id: provider.id?.includes('.')
      ? provider.id
      : (yosContract?.id ?? provider.id ?? declaration.frontmatter.name),
    title: declaration.frontmatter.name ?? provider.id,
    version: readPackageVersion(provider.dir, options.readFile),
    source,
    provenance: source === 'core' ? 'official' : (provider.provenance ?? 'third-party'),
    status: compatible ? 'installed' : 'incompatible',
    declarationStatus: declaration.declarationStatus,
    compatibility: { node, core },
    dir: provider.dir,
    // Where the probe actually runs. For a core skill the declaration is read
    // from the package copy, which ships no node_modules — a probe that
    // imports anything cannot run there. See discoverLocalCapabilityProviders.
    runDir: provider.runDir ?? provider.dir,
    capabilities: declaration.capabilities,
  };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function discoverLocalCapabilityProviders({
  coreSkillsDir,
  installedSkillsDir,
  components = {},
  registry = {},
  readdir = fs.readdirSync,
} = {}) {
  // Core skills exist twice on a machine: the package copy, which carries the
  // SKILL.md the declaration is read from, and the installed copy under the
  // skills directory, which is the one with node_modules. A health probe that
  // imports a dependency can only run in the second. Resolving it against the
  // first made every probe with an import fail to load and report the thing it
  // was probing as broken — an alarm that fires on a healthy machine and names
  // the wrong cause.
  const installedCoreDirs = new Map();
  if (installedSkillsDir) {
    let installed = [];
    try {
      installed = readdir(installedSkillsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of installed) {
      // Same rule as below: a symlinked skill directory is not trusted to run.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      installedCoreDirs.set(entry.name, path.join(installedSkillsDir, entry.name));
    }
  }

  const coreProviders = [];
  if (coreSkillsDir) {
    let entries = [];
    try {
      entries = readdir(coreSkillsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(coreSkillsDir, entry.name);
      if (entry.isSymbolicLink()) {
        const error = new Error(`core skill directory must not be a symbolic link: ${entry.name}`);
        error.code = 'capability_provider_invalid';
        throw error;
      }
      // Fall back to the package copy when the skill is not installed: a
      // dependency-free probe still runs there, and one that needs a
      // dependency reports that plainly rather than silently passing.
      coreProviders.push({ id: entry.name, dir, runDir: installedCoreDirs.get(entry.name) ?? dir });
    }
  }

  const componentProviders = [];
  for (const name of Object.keys(components).sort((a, b) => a.localeCompare(b, 'en'))) {
    const component = components[name] ?? {};
    const dir = component.skillDir || path.join(installedSkillsDir, name);
    if (!installedSkillsDir || !isInside(installedSkillsDir, dir)) {
      const error = new Error(`installed component path is outside the skills directory: ${name}`);
      error.code = 'capability_provider_invalid';
      throw error;
    }
    let provenance = 'third-party';
    if (component.source?.type === 'local-path') provenance = 'local-path';
    else if (registry[name]?.official === true) provenance = 'official';
    componentProviders.push({
      id: name,
      dir,
      provenance,
      installMode: component.type || 'declarative',
    });
  }

  return {
    coreProviders: coreProviders.sort((a, b) => a.id.localeCompare(b.id, 'en')),
    componentProviders,
  };
}

/**
 * A declaration scoped to other runtimes describes something this machine
 * cannot do, so the catalog leaves it out rather than advertising it.
 *
 * Fail open on purpose: when the active runtime is unknown, nothing is
 * filtered. Hiding a capability the machine really has is worse than listing
 * one it does not — the first makes a working product look broken, which is
 * the failure this whole area exists to prevent.
 */
function appliesToRuntime(declaration, activeRuntime) {
  if (!declaration.runtimes) return true;
  if (!activeRuntime) return true;
  return declaration.runtimes.includes(activeRuntime);
}

export function buildLocalCapabilityCatalog({
  coreProviders = [],
  componentProviders = [],
  coreVersion,
  nodeVersion = process.version,
  activeRuntime = null,
  readFile = fs.readFileSync,
  lstat = fs.lstatSync,
} = {}) {
  const options = { coreVersion, nodeVersion, readFile, lstat };
  const providers = [
    ...coreProviders.map((provider) => normalizeProvider(provider, 'core', options)),
    ...componentProviders.map((provider) => normalizeProvider(provider, 'component', options)),
  ].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'core' ? -1 : 1;
    return a.id.localeCompare(b.id, 'en');
  });

  const byCapability = new Map();
  const healthChecks = [];
  for (const provider of providers) {
    for (const declaration of provider.capabilities) {
      if (!appliesToRuntime(declaration, activeRuntime)) continue;
      if (!byCapability.has(declaration.id)) {
        byCapability.set(declaration.id, {
          id: declaration.id,
          title: canonicalCapabilityTitle(declaration.id),
          keywords: new Set(),
          operations: new Set(),
          providers: [],
        });
      }
      const capability = byCapability.get(declaration.id);
      declaration.keywords.forEach((keyword) => capability.keywords.add(keyword));
      declaration.operations.forEach((operation) => capability.operations.add(operation));
      capability.providers.push({
        id: provider.id,
        title: provider.title,
        version: provider.version,
        source: provider.source,
        provenance: provider.provenance,
        status: provider.status,
        declarationStatus: provider.declarationStatus,
        stability: declaration.stability,
        operations: declaration.operations,
        health: declaration.health ?? null,
        compatibility: provider.compatibility,
      });
      if (declaration.health) {
        healthChecks.push({
          providerId: provider.id,
          capabilityId: declaration.id,
          path: path.resolve(provider.runDir, declaration.health),
        });
      }
    }
  }

  const capabilities = [...byCapability.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    .map((capability) => ({
      ...capability,
      title: canonicalCapabilityTitle(capability.id),
      keywords: [...capability.keywords].sort((a, b) => a.localeCompare(b, 'en')),
      operations: [...capability.operations].sort((a, b) => a.localeCompare(b, 'en')),
      providers: capability.providers.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'core' ? -1 : 1;
        return a.id.localeCompare(b.id, 'en');
      }),
    }));

  return {
    schemaVersion: 1,
    generatedAt: null,
    capabilities,
    providers: providers.map(
      ({ capabilities: ignored, dir: ignoredDir, runDir: ignoredRunDir, ...provider }) => provider,
    ),
    healthChecks,
  };
}

function providerSort(a, b) {
  if (a.source !== b.source) return a.source === 'core' ? -1 : 1;
  const statusRank = { installed: 0, available: 1, incompatible: 2 };
  const status = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
  if (status !== 0) return status;
  return a.id.localeCompare(b.id, 'en');
}

/**
 * Combine immutable local facts with the shelf's list of installable providers.
 * Installed providers always win on identity; an outage never hides local data.
 */
export function mergeCapabilityCatalogs(local, remote, {
  coreVersion,
  nodeVersion = process.version,
} = {}) {
  const byCapability = new Map((local.capabilities ?? []).map((capability) => [
    capability.id,
    {
      ...capability,
      keywords: new Set(capability.keywords ?? []),
      operations: new Set(capability.operations ?? []),
      providers: [...(capability.providers ?? [])],
    },
  ]));
  const installedProviderIds = new Set(
    [...byCapability.values()].flatMap((capability) => capability.providers.map((provider) => provider.id)),
  );

  if (remote?.status === 'available' && remote.catalog) {
    for (const declaration of remote.catalog.capabilities ?? []) {
      if (!byCapability.has(declaration.id)) {
        byCapability.set(declaration.id, {
          id: declaration.id,
          title: canonicalCapabilityTitle(declaration.id),
          keywords: new Set(),
          operations: new Set(),
          providers: [],
        });
      }
      const capability = byCapability.get(declaration.id);
      capability.title = canonicalCapabilityTitle(declaration.id);
      for (const keyword of declaration.keywords ?? []) capability.keywords.add(keyword);
      for (const operation of declaration.operations ?? []) capability.operations.add(operation);

      for (const provider of declaration.providers ?? []) {
        if (installedProviderIds.has(provider.id)) continue;
        const node = checkNodeEngine(provider.nodeRange ?? null, nodeVersion);
        const core = checkYosCoreCompatibility(provider.coreRange ?? null, coreVersion);
        capability.providers.push({
          ...provider,
          status: node.satisfied && core.satisfied ? 'available' : 'incompatible',
          compatibility: { node, core },
        });
      }
    }
  }

  return {
    ...local,
    capabilities: [...byCapability.values()]
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
      .map((capability) => ({
        ...capability,
        keywords: [...capability.keywords].sort((a, b) => a.localeCompare(b, 'en')),
        operations: [...capability.operations].sort((a, b) => a.localeCompare(b, 'en')),
        providers: capability.providers.sort(providerSort),
      })),
    remote: {
      status: remote?.status ?? 'not_configured',
      source: remote?.source ?? 'shelf',
      errorCode: remote?.errorCode ?? null,
    },
  };
}
