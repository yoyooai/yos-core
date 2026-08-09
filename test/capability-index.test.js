import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import { deriveCapabilityIndex } from '../scripts/lib/capability-index.mjs';

function write(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

describe('derived shelf capability index', () => {
  test('derives providers from mirrored release metadata without copying artifact facts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-capability-index-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-capability-index-empty-'));
    const a = deriveCapabilityIndex({ index, registry: { components: { z: {}, a: {} } }, outputRoot: root });
    const b = deriveCapabilityIndex({ index, registry: { components: { a: {}, z: {} } }, outputRoot: root });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
