/**
 * `yos upgrade --self --check` must not download the release.
 *
 * The question is "is there an update, and what changed". Answering it used to
 * cost the entire release: measured 2026-08-06 against production, an 859 KB
 * tarball fetched to read a 10 KB CHANGELOG.md. On the cross-border links these
 * machines sit on (measured 62–175 KB/s in July) that is minutes of silence for
 * a question that should cost one small GET.
 *
 * Two things are guarded here, and the second is the one that rots quietly:
 *   1. the notes come from a single raw file fetch, not a release download;
 *   2. the reference is the version's own immutable tag — never `main`, never a
 *      moving `stable/` pointer. Notes read from a moving ref stop describing
 *      the version being offered as soon as the next release lands.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fetchCoreChangelog } from '../self-upgrade.js';
import { readOptionalCoreChangelogFromSource } from '../../commands/component.js';

const COMPONENT_JS = path.join(import.meta.dirname, '..', '..', 'commands', 'component.js');

/**
 * The body of a top-level `function name(...) { ... }`, by brace balance.
 *
 * The parameter list has to be skipped explicitly: destructured parameters like
 * `({ jsonOutput, branch })` start with a brace, and taking the first brace
 * after the name measures the parameters instead of the body — which reads as
 * "the function contains nothing", i.e. green for the wrong reason.
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist — did it get renamed?`);

  const parenOpen = source.indexOf('(', start);
  let parens = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) { parenClose = i; break; }
    }
  }
  assert.notEqual(parenClose, -1, `could not find the parameter list of ${name}`);

  const open = source.indexOf('{', parenClose);
  assert.notEqual(open, -1, `could not find the body of ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const okRepo = () => ({ success: true, repo: 'yoyooai/yos-core' });

describe('fetchCoreChangelog', () => {
  it('reads one file and does not touch the release archive', () => {
    const calls = [];
    const result = fetchCoreChangelog('0.1.3', undefined, {
      resolveReleaseRepo: okRepo,
      fetchRawFile: (repo, filePath, ref) => {
        calls.push({ repo, filePath, ref });
        return '# Changelog\n\n## 0.1.3\n- something\n';
      },
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1, 'exactly one fetch');
    assert.deepEqual(calls[0], {
      repo: 'yoyooai/yos-core',
      filePath: 'CHANGELOG.md',
      ref: 'v0.1.3',
    });
  });

  it('pins the notes to the version tag, not a moving reference', () => {
    const refs = [];
    fetchCoreChangelog('0.1.3', undefined, {
      resolveReleaseRepo: okRepo,
      fetchRawFile: (_repo, _file, ref) => { refs.push(ref); return '# Changelog\n'; },
    });

    assert.deepEqual(refs, ['v0.1.3']);
    for (const ref of refs) {
      assert.notEqual(ref, 'main', 'main moves; the notes must not');
      assert.ok(!ref.includes('stable'), 'stable/ moves; the notes must not');
      assert.match(ref, /^v\d+\.\d+\.\d+/, 'the reference must be a version tag');
    }
  });

  it('honours an explicit branch, because then the branch IS what is offered', () => {
    const refs = [];
    fetchCoreChangelog('0.1.3', 'feature/x', {
      resolveReleaseRepo: okRepo,
      fetchRawFile: (_repo, _file, ref) => { refs.push(ref); return '# Changelog\n'; },
    });
    assert.deepEqual(refs, ['feature/x']);
  });

  it('reports a fetch failure instead of throwing', () => {
    const result = fetchCoreChangelog('0.1.3', undefined, {
      resolveReleaseRepo: okRepo,
      fetchRawFile: () => { throw new Error('curl: (28) timeout'); },
    });
    assert.equal(result.success, false);
    assert.match(result.error, /timeout/);
  });

  it('treats an empty changelog as a failure rather than as empty notes', () => {
    const result = fetchCoreChangelog('0.1.3', undefined, {
      resolveReleaseRepo: okRepo,
      fetchRawFile: () => '   \n',
    });
    assert.equal(result.success, false);
  });

  it('reports an unconfigured release source', () => {
    const result = fetchCoreChangelog('0.1.3', undefined, {
      resolveReleaseRepo: () => ({ success: false, message: 'YOS_RELEASE_REPO is not configured' }),
      fetchRawFile: () => { throw new Error('must not be reached'); },
    });
    assert.equal(result.success, false);
    assert.match(result.error, /not configured/);
  });
});

describe('the --check code path itself', () => {
  // The unit tests above prove the cheap fetch works. This one keeps the
  // expensive path from coming back: re-adding a release download to --check
  // would restore the original defect while every test above stayed green.
  it('does not download a release, in any spelling', () => {
    const body = functionBody(fs.readFileSync(COMPONENT_JS, 'utf8'), 'handleSelfCheckOnly');

    for (const forbidden of ['downloadCoreToTemp', 'downloadToTemp', 'downloadArchive', 'downloadBranch']) {
      assert.ok(
        !body.includes(forbidden),
        `--check must not call ${forbidden}: it answers "what changed" from CHANGELOG.md alone`
      );
    }
    // No download means nothing to clean up. A cleanup call is the fingerprint
    // of a download having been reintroduced.
    assert.ok(!body.includes('cleanupCoreTemp'), '--check has no temp dir to clean up');
  });

  it('gets its notes through the cheap reader', () => {
    const body = functionBody(fs.readFileSync(COMPONENT_JS, 'utf8'), 'handleSelfCheckOnly');
    assert.ok(
      body.includes('readOptionalCoreChangelogFromSource'),
      '--check should read the notes without a download'
    );
  });

  // The upgrade path is a different question: by then the tree is needed on
  // disk anyway. Asserting it still downloads keeps the test above from being
  // "fixed" by gutting downloads everywhere.
  it('leaves the real upgrade path downloading, because that one needs the tree', () => {
    const source = fs.readFileSync(COMPONENT_JS, 'utf8');
    assert.ok(source.includes('downloadCoreToTemp('), 'the upgrade path still downloads the release');
  });
});

describe('readOptionalCoreChangelogFromSource', () => {
  it('degrades to a warning, keeping the check itself successful', () => {
    const notes = readOptionalCoreChangelogFromSource('0.1.3', undefined, '0.1.2', {
      fetchCoreChangelog: () => ({ success: false, error: 'offline' }),
    });
    assert.equal(notes.changelog, null);
    assert.match(notes.warning, /unavailable/i);
  });

  it('filters the notes down to what is new for this machine', () => {
    const notes = readOptionalCoreChangelogFromSource('0.1.3', undefined, '0.1.2', {
      fetchCoreChangelog: () => ({ success: true, changelog: '# Changelog\n\n## 0.1.3\n- new\n\n## 0.1.2\n- old\n' }),
    });
    assert.match(notes.changelog, /0\.1\.3/);
    assert.ok(!notes.changelog.includes('- old'), 'already-installed versions are not news');
    assert.equal(notes.warning, null);
  });

  it('survives a changelog it cannot parse', () => {
    const notes = readOptionalCoreChangelogFromSource('0.1.3', undefined, '0.1.2', {
      fetchCoreChangelog: () => ({ success: true, changelog: '# Changelog\n' }),
      filterChangelog: () => { throw new Error('unparseable'); },
    });
    assert.equal(notes.changelog, null);
    assert.match(notes.warning, /unavailable/i);
  });
});
