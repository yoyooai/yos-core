import fs from 'node:fs';
import path from 'node:path';

import { parseCapabilitySkill } from '../../cli/lib/capability-schema.js';
import {
  readDeclaredNodeRange,
  readDeclaredYosContract,
} from '../../cli/lib/component-engines.js';
// One definition of "newest released tag", shared with the shelf verifier.
import { newestReleaseTag, tagVersion } from './release-tags.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function providerOrder(a, b) {
  return a.id.localeCompare(b.id, 'en');
}

/**
 * Derive the capability reverse index from metadata already mirrored for
 * released component tags. Artifact URLs, sizes and digests remain solely in
 * index.json and are intentionally absent here.
 */
export function deriveCapabilityIndex({ index, registry, outputRoot }) {
  if (index?.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(index.buildId ?? '')) {
    throw new Error('index.json must carry a valid buildId before deriving capabilities');
  }

  const repos = new Map((index.repos ?? []).map((entry) => [entry.repo, entry]));
  const byCapability = new Map();
  const components = registry?.components ?? registry ?? {};

  for (const registryName of Object.keys(components).sort((a, b) => a.localeCompare(b, 'en'))) {
    const metadata = components[registryName] ?? {};
    if (typeof metadata.repo !== 'string' || typeof metadata.path !== 'string'
      || typeof metadata.tagPrefix !== 'string') continue;
    const repo = repos.get(metadata.repo);
    if (!repo || !Array.isArray(repo.tags)) continue;
    const tag = newestReleaseTag(repo.tags, metadata.tagPrefix);
    if (!tag) continue;

    const providerRoot = path.join(outputRoot, metadata.repo, 'raw', tag, metadata.path);
    const skillPath = path.join(providerRoot, 'SKILL.md');
    const packagePath = path.join(providerRoot, 'package.json');
    if (!fs.existsSync(skillPath) || !fs.existsSync(packagePath)) continue;

    const declaration = parseCapabilitySkill(providerRoot);
    if (declaration.declarationStatus !== 'declared') continue;
    const pkg = readJson(packagePath);
    const yos = readDeclaredYosContract(providerRoot);
    const nodeRange = readDeclaredNodeRange(providerRoot);
    if (!yos?.id || typeof pkg.version !== 'string' || pkg.version !== tagVersion(tag)) {
      throw new Error(`${registryName}@${tag} has inconsistent component identity or version metadata`);
    }

    for (const capabilityDeclaration of declaration.capabilities) {
      if (!byCapability.has(capabilityDeclaration.id)) {
        byCapability.set(capabilityDeclaration.id, {
          id: capabilityDeclaration.id,
          title: capabilityDeclaration.title,
          keywords: new Set(),
          operations: new Set(),
          providers: [],
        });
      }
      const capability = byCapability.get(capabilityDeclaration.id);
      capabilityDeclaration.keywords.forEach((keyword) => capability.keywords.add(keyword));
      capabilityDeclaration.operations.forEach((operation) => capability.operations.add(operation));
      capability.providers.push({
        id: yos.id,
        registryName,
        repo: metadata.repo,
        tag,
        path: metadata.path,
        version: pkg.version,
        source: 'component',
        provenance: metadata.official === true ? 'official' : 'third-party',
        stability: capabilityDeclaration.stability,
        operations: [...capabilityDeclaration.operations],
        coreRange: yos.core ?? null,
        nodeRange: nodeRange ?? null,
      });
    }
  }

  return {
    schemaVersion: 1,
    buildId: index.buildId,
    capabilities: [...byCapability.values()]
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
      .map((capability) => ({
        ...capability,
        keywords: [...capability.keywords].sort((a, b) => a.localeCompare(b, 'en')),
        operations: [...capability.operations].sort((a, b) => a.localeCompare(b, 'en')),
        providers: capability.providers.sort(providerOrder),
      })),
  };
}
