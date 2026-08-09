import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

const registryModule = await import('../registry.js');

function stateLoader() {
  assert.equal(
    typeof registryModule.loadRegistryWithStatus,
    'function',
    'registry.js must expose remote failure instead of returning an indistinguishable fallback',
  );
  return registryModule.loadRegistryWithStatus;
}

describe('registry source visibility', () => {
  function coverCapabilityArtifact(documents) {
    const capabilityUrl = 'https://mirror.example/dist/capabilities.json';
    const indexUrl = 'https://mirror.example/dist/index.json';
    const text = documents[capabilityUrl];
    const index = JSON.parse(documents[indexUrl]);
    index.files = [{
      path: 'capabilities.json',
      bytes: Buffer.byteLength(text),
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    }];
    documents[indexUrl] = JSON.stringify(index);
  }

  it('returns a stable unreachable state when the configured remote fails', async () => {
    const fallback = { feishu: { name: 'Feishu' } };
    const result = await stateLoader()({
      env: { YOS_REGISTRY_REPO: 'example/components' },
      loadFallback: () => fallback,
      fetchRemote: () => {
        throw new Error('curl failed for https://user:secret@example.invalid/private');
      },
    });

    assert.deepEqual(result.components, fallback);
    assert.equal(result.source, 'fallback');
    assert.equal(result.status, 'unreachable');
    assert.equal(result.errorCode, 'registry_unreachable');
    assert.doesNotMatch(JSON.stringify(result), /user:secret|curl failed|example\.invalid/);
  });

  it('distinguishes a successful remote catalog from fallback data', async () => {
    const remote = { weixin: { name: 'Weixin' } };
    const result = await stateLoader()({
      env: { YOS_REGISTRY_REPO: 'example/components' },
      loadFallback: () => ({}),
      fetchRemote: () => JSON.stringify({ components: remote }),
    });

    assert.deepEqual(result, {
      components: remote,
      source: 'remote',
      status: 'available',
      errorCode: null,
    });
  });

  it('loads a matched shelf capability index and rejects mixed build identities', async () => {
    assert.equal(typeof registryModule.loadShelfCapabilityCatalog, 'function');
    const documents = {
      'https://mirror.example/dist/index.json': JSON.stringify({
        schemaVersion: 1,
        buildId: 'a'.repeat(64),
        repos: [{ repo: 'yoyooai/yos-components', tags: ['feishu-v0.1.4'] }],
      }),
      'https://mirror.example/dist/capabilities.json': JSON.stringify({
        schemaVersion: 1,
        buildId: 'a'.repeat(64),
        capabilities: [{
          id: 'communication.message', title: 'Messages', keywords: ['chat'], operations: ['send'],
          providers: [{
            id: 'channel.feishu', registryName: 'feishu', repo: 'yoyooai/yos-components',
            tag: 'feishu-v0.1.4', path: 'channels/001_feishu', version: '0.1.4',
            source: 'component', provenance: 'official', stability: 'stable', operations: ['send'],
            coreRange: '>=0.1.0-alpha.1 <0.2.0', nodeRange: '>=20.20.0',
          }],
        }],
      }),
    };
    coverCapabilityArtifact(documents);
    const fetchText = (url) => documents[url];
    const loaded = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' }, fetchText,
    });
    assert.equal(loaded.status, 'available');
    assert.equal(loaded.catalog.buildId, 'a'.repeat(64));

    documents['https://mirror.example/dist/capabilities.json'] = documents['https://mirror.example/dist/capabilities.json']
      .replaceAll('a'.repeat(64), 'b'.repeat(64));
    const mixed = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' }, fetchText,
    });
    assert.equal(mixed.status, 'degraded');
    assert.equal(mixed.errorCode, 'capability_registry_build_mismatch');
  });

  it('rejects a hand-edited capability artifact even when its build ID was preserved', async () => {
    const catalog = JSON.stringify({ schemaVersion: 1, buildId: 'a'.repeat(64), capabilities: [] });
    const documents = {
      'https://mirror.example/dist/index.json': JSON.stringify({
        schemaVersion: 1,
        buildId: 'a'.repeat(64),
        repos: [],
        files: [{
          path: 'capabilities.json',
          bytes: Buffer.byteLength(catalog),
          sha256: crypto.createHash('sha256').update(catalog).digest('hex'),
        }],
      }),
      'https://mirror.example/dist/capabilities.json': `${catalog} `,
    };
    const result = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' },
      fetchText: (url) => documents[url],
    });
    assert.equal(result.errorCode, 'capability_registry_integrity_mismatch');
  });

  it('rejects a provider whose release tag is absent from index.json', async () => {
    const documents = {
      'https://mirror.example/dist/index.json': JSON.stringify({
        schemaVersion: 1,
        buildId: 'a'.repeat(64),
        repos: [{ repo: 'yoyooai/yos-components', tags: ['feishu-v0.1.4'] }],
      }),
      'https://mirror.example/dist/capabilities.json': JSON.stringify({
        schemaVersion: 1,
        buildId: 'a'.repeat(64),
        capabilities: [{
          id: 'communication.message',
          title: 'Messages',
          keywords: ['chat'],
          operations: ['send'],
          providers: [{
            id: 'channel.feishu',
            registryName: 'feishu',
            repo: 'yoyooai/yos-components',
            tag: 'feishu-v0.1.5',
            path: 'channels/001_feishu',
            version: '0.1.5',
            source: 'component',
            provenance: 'official',
            stability: 'stable',
            operations: ['send'],
            coreRange: '>=0.1.0-alpha.1 <0.2.0',
            nodeRange: '>=20.20.0',
          }],
        }],
      }),
    };
    coverCapabilityArtifact(documents);

    const result = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' },
      fetchText: (url) => documents[url],
    });
    assert.equal(result.status, 'degraded');
    assert.equal(result.errorCode, 'capability_registry_invalid');
  });

  it('keeps remote errors stable and free of private URLs or stderr', async () => {
    const result = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' },
      fetchText: () => { throw new Error('curl failed https://user:secret@private.example/path'); },
    });
    assert.deepEqual(result, {
      status: 'degraded', source: 'shelf', errorCode: 'capability_registry_unreachable', catalog: null,
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|private\.example|curl failed/);
  });

  it('distinguishes malformed and invalid shelf documents from transport failure', async () => {
    const malformed = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' },
      fetchText: (url) => url.endsWith('/index.json') ? '{not json' : '{}',
    });
    assert.equal(malformed.errorCode, 'capability_registry_invalid');

    const invalidSchema = await registryModule.loadShelfCapabilityCatalog({
      env: { YOS_DIST_BASE: 'https://mirror.example/dist' },
      fetchText: (url) => JSON.stringify(url.endsWith('/index.json')
        ? { schemaVersion: 99, buildId: 'a'.repeat(64), repos: [] }
        : { schemaVersion: 1, buildId: 'a'.repeat(64), capabilities: [] }),
    });
    assert.equal(invalidSchema.errorCode, 'capability_registry_invalid');
  });
});
