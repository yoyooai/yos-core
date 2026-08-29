import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import { deriveCapabilityIndex } from '../scripts/lib/capability-index.mjs';
import { buildLocalCapabilityCatalog } from '../cli/lib/capability-catalog.js';

import { makeTempDir } from './helpers/temp-dir.js';

function write(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

describe('derived shelf capability index', () => {
  test('derives providers from mirrored release metadata without copying artifact facts', () => {
    const root = makeTempDir('yos-capability-index-');
    write(root, 'yoyooai/yos-components/raw/feishu-v0.1.4/channels/001_feishu/SKILL.md', `---\nname: feishu\ncapabilities:\n  - id: communication.message\n    title: Messages\n    operations: [send, receive]\n    keywords: [chat]\n    stability: stable\n---\n`);
    write(root, 'yoyooai/yos-components/raw/feishu-v0.1.4/channels/001_feishu/package.json', JSON.stringify({
      name: 'yos-feishu', version: '0.1.4', yos: { id: 'channel.feishu', core: '>=0.1.0-alpha.1 <0.2.0' }, engines: { node: '>=20.20.0' },
    }));
    const index = {
      schemaVersion: 1,
      buildId: 'c'.repeat(64),
      repos: [{ repo: 'yoyooai/yos-components', tags: ['feishu-v0.1.4'] }],
      files: [{ path: 'artifact.tgz', bytes: 123, sha256: 'd'.repeat(64), url: 'https://forbidden.example/a' }],
    };
    const registry = { components: { feishu: { repo: 'yoyooai/yos-components', path: 'channels/001_feishu', tagPrefix: 'feishu', official: true } } };
    const result = deriveCapabilityIndex({ index, registry, outputRoot: root });

    expect(result.buildId).toBe(index.buildId);
    expect(result.capabilities[0].providers[0]).toMatchObject({
      id: 'channel.feishu', registryName: 'feishu', version: '0.1.4', tag: 'feishu-v0.1.4',
    });
    expect(JSON.stringify(result)).not.toMatch(/sha256|bytes|https:\/\//);
  });

  test('is stable regardless of registry key order', () => {
    const index = { schemaVersion: 1, buildId: 'e'.repeat(64), repos: [], files: [] };
    const root = makeTempDir('yos-capability-index-empty-');
    const a = deriveCapabilityIndex({ index, registry: { components: { z: {}, a: {} } }, outputRoot: root });
    const b = deriveCapabilityIndex({ index, registry: { components: { a: {}, z: {} } }, outputRoot: root });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('uses one provider-neutral title in shelf and local catalogs regardless of provider order', () => {
    const root = makeTempDir('yos-capability-title-');
    const providers = [
      { name: 'feishu', id: 'channel.feishu', title: '飞书消息', tag: 'feishu-v0.1.4' },
      { name: 'weixin', id: 'channel.weixin', title: '微信消息', tag: 'weixin-v0.1.3' },
    ];
    for (const provider of providers) {
      const base = `yoyooai/yos-components/raw/${provider.tag}/channels/${provider.name}`;
      write(root, `${base}/SKILL.md`, `---\nname: ${provider.name}\ncapabilities:\n  - id: communication.message\n    title: ${provider.title}\n    operations: [send, receive]\n    keywords: [chat]\n    stability: stable\n---\n`);
      write(root, `${base}/package.json`, JSON.stringify({
        name: `yos-${provider.name}`,
        version: provider.tag.replace(/^.*-v/, ''),
        yos: { id: provider.id, core: '>=0.1.0-alpha.1 <0.2.0' },
        engines: { node: '>=20.20.0' },
      }));
    }
    const index = {
      schemaVersion: 1,
      buildId: 'f'.repeat(64),
      repos: [{ repo: 'yoyooai/yos-components', tags: providers.map((provider) => provider.tag) }],
      files: [],
    };
    const registry = {
      components: Object.fromEntries([...providers].reverse().map((provider) => [provider.name, {
        repo: 'yoyooai/yos-components',
        path: `channels/${provider.name}`,
        tagPrefix: provider.name,
        official: true,
      }])),
    };

    const shelf = deriveCapabilityIndex({ index, registry, outputRoot: root });
    const local = buildLocalCapabilityCatalog({
      componentProviders: [...providers].reverse().map((provider) => ({
        id: provider.id,
        dir: path.join(root, `yoyooai/yos-components/raw/${provider.tag}/channels/${provider.name}`),
        provenance: 'official',
      })),
      coreVersion: '0.1.14',
      nodeVersion: '24.18.0',
    });

    expect(shelf.capabilities[0].title).toBe('Message routing');
    expect(local.capabilities[0].title).toBe('Message routing');
    expect(shelf.capabilities[0].providers.map((provider) => provider.title).sort()).toEqual(['feishu', 'weixin']);
    expect(local.capabilities[0].providers.map((provider) => provider.title).sort()).toEqual(['feishu', 'weixin']);
  });
});
