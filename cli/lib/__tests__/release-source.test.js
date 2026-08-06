import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRegistryRepo, resolveReleaseRepo } from '../release-source.js';

describe('YOS release source', () => {
  it('fails closed when no release repository is configured', () => {
    const result = resolveReleaseRepo({});
    // The machine-readable code is pinned exactly — callers branch on it.
    assert.equal(result.success, false);
    assert.equal(result.error, 'release_source_not_configured');
    // The human-readable half is pinned by content, not by exact string: it now
    // carries the repair, and asserting the whole sentence made this test the
    // thing that broke when the message got more useful (2026-08-06).
    assert.match(result.message, /YOS_RELEASE_REPO is not configured/);
    assert.match(result.message, /export YOS_RELEASE_REPO=/);
  });

  it('accepts an explicit GitHub owner/repository pair', () => {
    assert.deepEqual(resolveReleaseRepo({ YOS_RELEASE_REPO: 'example/yos' }), {
      success: true,
      repo: 'example/yos',
    });
  });

  it('rejects URLs and malformed repository values', () => {
    for (const value of ['yos', 'https://example.com/yos', '../yos', 'owner/repo/extra']) {
      const result = resolveReleaseRepo({ YOS_RELEASE_REPO: value });
      assert.equal(result.success, false);
      assert.equal(result.error, 'invalid_release_source');
    }
  });

  it('keeps the component registry offline unless explicitly configured', () => {
    assert.equal(resolveRegistryRepo({}).error, 'registry_source_not_configured');
    assert.deepEqual(
      resolveRegistryRepo({ YOS_REGISTRY_REPO: 'company/yos-registry' }),
      { success: true, repo: 'company/yos-registry' },
    );
  });
});
