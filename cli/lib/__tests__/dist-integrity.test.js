/**
 * The mirror publishes a sha256 for every file it carries; downloads must use it.
 *
 * What this guards is narrower than "corrupt download": gzip's CRC and tar's
 * headers already reject a damaged archive. The gap is the archive that is
 * well-formed and simply wrong — the mirror caught mid-publish (it publishes
 * with `rsync --delete`, so index.json and the artifacts disagree for a window),
 * or a stale copy held by a proxy at the current release's URL. Both extract
 * cleanly and install the wrong version in silence.
 *
 * The other half of the contract is just as important: when the digest CANNOT be
 * checked, that has to be said. "Not checked" reading as "checked" is how this
 * went unnoticed while the mirror had been publishing digests all along.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  fetchMirrorIndex,
  mirrorRelativePath,
  resetMirrorIndexCache,
  sha256File,
  verifyMirrorDownload,
} from '../dist-integrity.js';

const BASE = 'https://dist.yoyooai.com';
const TARBALL_URL = `${BASE}/yoyooai/yos-core/tarball/tags/v0.1.3.tar.gz`;
const TARBALL_PATH = 'yoyooai/yos-core/tarball/tags/v0.1.3.tar.gz';
const env = { YOS_DIST_BASE: BASE };

afterEach(() => resetMirrorIndexCache());

/** A real file on disk, so the digest is computed rather than asserted. */
function writeTemp(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-integrity-test-'));
  const file = path.join(dir, 'archive.tar.gz');
  fs.writeFileSync(file, contents);
  return file;
}

const digestOf = (contents) => crypto.createHash('sha256').update(contents).digest('hex');

function indexWith(entries) {
  return () => JSON.stringify({ schemaVersion: 1, files: entries });
}

describe('mirrorRelativePath', () => {
  it('strips the mirror base to get the index key', () => {
    assert.equal(mirrorRelativePath(TARBALL_URL, BASE), TARBALL_PATH);
  });

  it('tolerates a trailing slash on the base', () => {
    assert.equal(mirrorRelativePath(TARBALL_URL, `${BASE}/`), TARBALL_PATH);
  });

  it('returns null for a URL that is not on the mirror', () => {
    assert.equal(mirrorRelativePath('https://github.com/x/y/archive/v1.tar.gz', BASE), null);
  });
});

describe('verifyMirrorDownload', () => {
  it('accepts a file whose digest matches what the mirror published', () => {
    const body = Buffer.from('the real release');
    const file = writeTemp(body);

    const result = verifyMirrorDownload({
      filePath: file,
      url: TARBALL_URL,
      env,
      fetchIndex: indexWith([{ path: TARBALL_PATH, sha256: digestOf(body), bytes: body.length }]),
    });

    assert.equal(result.status, 'match');
  });

  it('rejects a well-formed file that is not the one asked for', () => {
    // The mid-publish case: the index names one release, the URL serves another.
    const served = Buffer.from('the PREVIOUS release, still valid gzip');
    const file = writeTemp(served);

    const result = verifyMirrorDownload({
      filePath: file,
      url: TARBALL_URL,
      env,
      fetchIndex: indexWith([{ path: TARBALL_PATH, sha256: digestOf(Buffer.from('the real release')) }]),
    });

    assert.equal(result.status, 'mismatch');
    assert.equal(result.actual, digestOf(served));
    assert.match(result.message, /does not match the digest/);
    assert.match(result.message, /mid-publish/);
  });

  it('says so when the index cannot be read, instead of passing silently', () => {
    const result = verifyMirrorDownload({
      filePath: writeTemp(Buffer.from('x')),
      url: TARBALL_URL,
      env,
      fetchIndex: () => { throw new Error('curl: (28) timeout'); },
    });

    assert.equal(result.status, 'no-index');
    assert.match(result.message, /not checked/);
  });

  it('says so when the file is absent from the index, instead of passing silently', () => {
    const result = verifyMirrorDownload({
      filePath: writeTemp(Buffer.from('x')),
      url: TARBALL_URL,
      env,
      fetchIndex: indexWith([{ path: 'some/other/file.tar.gz', sha256: 'a'.repeat(64) }]),
    });

    assert.equal(result.status, 'unknown-file');
    assert.match(result.message, /not listed in the mirror index/);
  });

  it('treats an index without usable entries as no index at all', () => {
    for (const body of ['{}', '{"files":[]}', '{"files":[{"path":"a"}]}', 'not json']) {
      resetMirrorIndexCache();
      const result = verifyMirrorDownload({
        filePath: writeTemp(Buffer.from('x')),
        url: TARBALL_URL,
        env,
        fetchIndex: () => body,
      });
      assert.equal(result.status, 'no-index', `for index body: ${body}`);
    }
  });

  it('does not check when the mirror is switched off', () => {
    const result = verifyMirrorDownload({
      filePath: writeTemp(Buffer.from('x')),
      url: TARBALL_URL,
      env: { YOS_DIST_BASE: '' },
      fetchIndex: () => { throw new Error('must not be reached'); },
    });
    assert.equal(result.status, 'no-index');
  });

  it('fetches the index once however many files are checked', () => {
    let fetches = 0;
    const body = Buffer.from('shared');
    const fetchIndex = () => {
      fetches += 1;
      return JSON.stringify({
        files: [
          { path: TARBALL_PATH, sha256: digestOf(body) },
          { path: 'yoyooai/yos-core/tarball/tags/v0.1.4.tar.gz', sha256: digestOf(body) },
        ],
      });
    };

    for (const url of [TARBALL_URL, `${BASE}/yoyooai/yos-core/tarball/tags/v0.1.4.tar.gz`]) {
      const result = verifyMirrorDownload({ filePath: writeTemp(body), url, env, fetchIndex });
      assert.equal(result.status, 'match');
    }
    assert.equal(fetches, 1, 'index.json should be fetched once per process');
  });
});

describe('sha256File', () => {
  it('digests the bytes on disk', () => {
    const body = Buffer.from('abc');
    assert.equal(sha256File(writeTemp(body)), digestOf(body));
  });
});

describe('the download path actually uses it', () => {
  // Everything above tests a module. A module nobody calls is TD-69 all over
  // again: correct, published, and doing nothing. These read the real download
  // code, because the wiring is what was missing for the whole life of the bug.
  const downloadSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'download.js'),
    'utf8'
  );

  it('checks the mirror download before returning it', () => {
    const mirrorBlock = downloadSource.slice(
      downloadSource.indexOf('function curlDownloadOnce'),
      downloadSource.indexOf('// 2. Try public GitHub endpoint')
    );
    assert.ok(mirrorBlock.length > 0, 'the mirror branch should still be first');
    assert.ok(
      mirrorBlock.includes('assertMirrorIntegrity('),
      'a mirror download must be checked against the published digest before it is used'
    );
    // Order matters: checking after returning checks nothing.
    assert.ok(
      mirrorBlock.indexOf('assertMirrorIntegrity(') < mirrorBlock.indexOf('return;'),
      'the check has to happen before the download is accepted'
    );
  });

  it('treats a mismatch as a failure, not as a note', () => {
    const guard = downloadSource.slice(
      downloadSource.indexOf('function assertMirrorIntegrity'),
      downloadSource.indexOf('function curlDownload(')
    );
    assert.match(guard, /status === 'mismatch'/);
    assert.match(guard, /throw new Error\(result\.message\)/);
  });

  it('says out loud when it could not check', () => {
    const guard = downloadSource.slice(
      downloadSource.indexOf('function assertMirrorIntegrity'),
      downloadSource.indexOf('function curlDownload(')
    );
    assert.match(guard, /status !== 'match'/, 'the un-checkable cases must be reported');
    assert.match(guard, /write\(/);
  });
});

describe('fetchMirrorIndex', () => {
  it('keys digests by mirror-relative path', () => {
    const index = fetchMirrorIndex({
      env,
      fetchIndex: indexWith([{ path: TARBALL_PATH, sha256: 'b'.repeat(64), bytes: 12 }]),
    });
    assert.equal(index.base, BASE);
    assert.equal(index.digests.get(TARBALL_PATH).sha256, 'b'.repeat(64));
  });
});
