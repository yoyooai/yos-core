import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DIST_BASE,
  DistOriginError,
  distMirrorUrl,
  distVendorUrl,
  isDistOnly,
  isMirroredRepo,
  noteMirrorFallback,
  normalizeDistBase,
  resolveDistBase,
  resolveVendorBase,
  resetMirrorFallbackNotices,
} from '../dist-origin.js';

describe('distribution origin', () => {
  it('defaults to our own domain, not to GitHub', () => {
    // The whole point of this module: out of the box, nothing resolves to a
    // GitHub host. If this assertion ever has to change, customers in China
    // are back to a coin flip.
    assert.equal(DEFAULT_DIST_BASE, 'https://yoyooai.com/dist');
    assert.ok(!/github/i.test(DEFAULT_DIST_BASE));
    assert.deepEqual(resolveDistBase({}), { enabled: true, base: DEFAULT_DIST_BASE });
  });

  it('builds every mirror read from the base URL', () => {
    const env = {};
    assert.equal(
      distMirrorUrl('tags', { repo: 'yoyooai/yos-core' }, env),
      'https://yoyooai.com/dist/yoyooai/yos-core/tags.json',
    );
    assert.equal(
      distMirrorUrl('latest-release', { repo: 'yoyooai/yos-core' }, env),
      'https://yoyooai.com/dist/yoyooai/yos-core/releases/latest.json',
    );
    assert.equal(
      distMirrorUrl('raw', { repo: 'yoyooai/yos-core', filePath: 'registry.json' }, env),
      'https://yoyooai.com/dist/yoyooai/yos-core/raw/main/registry.json',
    );
    assert.equal(
      distMirrorUrl('tarball', { repo: 'yoyooai/yos-components', ref: 'feishu-v0.1.0', refType: 'tag' }, env),
      'https://yoyooai.com/dist/yoyooai/yos-components/tarball/tags/feishu-v0.1.0.tar.gz',
    );
    assert.equal(
      distMirrorUrl('tarball', { repo: 'yoyooai/yos-core', ref: 'main', refType: 'branch' }, env),
      'https://yoyooai.com/dist/yoyooai/yos-core/tarball/heads/main.tar.gz',
    );
    assert.equal(
      distVendorUrl('caddy/v2.10.2/caddy_2.10.2_linux_amd64.tar.gz', env),
      'https://yoyooai.com/dist/vendor/caddy/v2.10.2/caddy_2.10.2_linux_amd64.tar.gz',
    );
    assert.equal(resolveVendorBase(env), 'https://yoyooai.com/dist/vendor');
  });

  it('keeps the package path free of the tag\'s v prefix so it matches npm pack output', () => {
    assert.equal(
      distMirrorUrl('package', { repo: 'yoyooai/yos-core', version: 'v0.1.0-alpha.3' }, {}),
      'https://yoyooai.com/dist/yoyooai/yos-core/package/yos-0.1.0-alpha.3.tgz',
    );
  });

  it('leaves repositories we do not mirror to GitHub instead of a guaranteed 404', () => {
    assert.equal(isMirroredRepo('someone-else/yos-thing', {}), false);
    assert.equal(distMirrorUrl('tags', { repo: 'someone-else/yos-thing' }, {}), null);
    assert.equal(isMirroredRepo('YoyooAI/yos-core', {}), true, 'owner match is case-insensitive');
    assert.equal(isMirroredRepo('someone-else/yos-thing', { YOS_DIST_OWNERS: '*' }), true);
    assert.equal(isMirroredRepo('not-a-repo', {}), false);
  });

  it('can be switched off, but only explicitly', () => {
    assert.deepEqual(resolveDistBase({ YOS_DIST_BASE: '' }), { enabled: false, base: null });
    assert.equal(distMirrorUrl('tags', { repo: 'yoyooai/yos-core' }, { YOS_DIST_BASE: '' }), null);
    assert.equal(distVendorUrl('caddy/latest.json', { YOS_DIST_BASE: '' }), null);
    assert.equal(resolveDistBase({ YOS_DIST_BASE: 'https://mirror.example/d/' }).base, 'https://mirror.example/d');
  });

  it('fails loudly on a malformed base instead of quietly reverting to GitHub', () => {
    for (const value of ['not a url', 'http://mirror.example/dist', 'https://u:p@mirror.example/d',
      'https://mirror.example/d?token=1', 'https://mirror.example/d#x']) {
      assert.throws(() => resolveDistBase({ YOS_DIST_BASE: value }), DistOriginError, value);
    }
    // Loopback over http stays allowed: tests and acceptance runs need it.
    assert.equal(normalizeDistBase('http://127.0.0.1:8080/dist'), 'http://127.0.0.1:8080/dist');
  });

  it('refuses refs and paths that would escape the mirror', () => {
    for (const ref of ['../../etc', 'v1.0.0?x=1', 'v1.0.0#f', '']) {
      assert.throws(
        () => distMirrorUrl('tarball', { repo: 'yoyooai/yos-core', ref, refType: 'tag' }, {}),
        DistOriginError,
        ref,
      );
    }
    for (const filePath of ['../secrets', 'a/../../b', 'with space']) {
      assert.throws(
        () => distMirrorUrl('raw', { repo: 'yoyooai/yos-core', filePath }, {}),
        DistOriginError,
        filePath,
      );
    }
    assert.throws(() => distVendorUrl('../../etc/passwd', {}), DistOriginError);
  });

  it('recognises the dist-only switch used by acceptance runs', () => {
    assert.equal(isDistOnly({}), false);
    for (const value of ['1', 'true', 'YES']) assert.equal(isDistOnly({ YOS_DIST_ONLY: value }), true);
    assert.equal(isDistOnly({ YOS_DIST_ONLY: '0' }), false);
  });

  it('reports a mirror miss once per target so a fallback is never silent', () => {
    resetMirrorFallbackNotices();
    const written = [];
    const write = message => written.push(message);
    assert.equal(noteMirrorFallback('tags', 'yoyooai/yos-core', new Error('boom'), { write }), true);
    assert.equal(noteMirrorFallback('tags', 'yoyooai/yos-core', new Error('boom'), { write }), false);
    assert.equal(written.length, 1);
    assert.match(written[0], /mirror miss \(tags yoyooai\/yos-core\)/);
    assert.match(written[0], /falling back to GitHub/);
    resetMirrorFallbackNotices();
  });
});
