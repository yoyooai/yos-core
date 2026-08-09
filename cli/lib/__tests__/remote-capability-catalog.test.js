import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeCapabilityCatalogs } from '../capability-catalog.js';

describe('remote capability authority and local fallback', () => {
  const local = {
    schemaVersion: 1,
    capabilities: [{
      id: 'communication.message', title: 'Messages', keywords: [], operations: ['send'],
      providers: [{ id: 'comm-bridge', source: 'core', provenance: 'official', status: 'installed', operations: ['send'] }],
    }],
    providers: [], healthChecks: [],
  };

  it('discovers a newly published provider without changing the OS', () => {
    const remote = {
      status: 'available', source: 'shelf', errorCode: null,
      catalog: {
        capabilities: [{
          id: 'communication.message', title: 'Messages', keywords: ['feishu'], operations: ['send', 'receive'],
          providers: [{
            id: 'channel.feishu', registryName: 'feishu', version: '0.1.4', source: 'component',
            provenance: 'official', stability: 'stable', operations: ['send', 'receive'],
            coreRange: '>=0.1.0-alpha.1 <0.2.0', nodeRange: '>=20.20.0',
          }],
        }],
      },
    };
    const merged = mergeCapabilityCatalogs(local, remote, { coreVersion: '0.1.13', nodeVersion: '24.18.0' });
    assert.deepEqual(merged.capabilities[0].providers.map(({ id, status }) => ({ id, status })), [
      { id: 'comm-bridge', status: 'installed' },
      { id: 'channel.feishu', status: 'available' },
    ]);
    assert.equal(merged.remote.status, 'available');
  });

  it('keeps installed capabilities visible when the shelf is degraded', () => {
    const merged = mergeCapabilityCatalogs(local, {
      status: 'degraded', source: 'shelf', errorCode: 'capability_registry_unreachable', catalog: null,
    }, { coreVersion: '0.1.13', nodeVersion: '24.18.0' });
    assert.equal(merged.capabilities[0].providers[0].id, 'comm-bridge');
    assert.deepEqual(merged.remote, {
      status: 'degraded', source: 'shelf', errorCode: 'capability_registry_unreachable',
    });
  });

  it('marks an incompatible remote provider without hiding it', () => {
    const remote = {
      status: 'available', source: 'shelf', errorCode: null,
      catalog: { capabilities: [{
        id: 'browser.control', title: 'Browser', keywords: [], operations: ['open'],
        providers: [{ id: 'tool.future', source: 'component', provenance: 'official', stability: 'beta', operations: ['open'], coreRange: '>=9.0.0', nodeRange: '>=99.0.0' }],
      }] },
    };
    const merged = mergeCapabilityCatalogs(local, remote, { coreVersion: '0.1.13', nodeVersion: '24.18.0' });
    assert.equal(merged.capabilities.find(({ id }) => id === 'browser.control').providers[0].status, 'incompatible');
  });
});
