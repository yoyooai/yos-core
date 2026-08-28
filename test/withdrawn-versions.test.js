/**
 * Withdrawing a published version.
 *
 * 0.1.22 shipped, failed its own customer-path acceptance about 25 minutes
 * later, and was rolled back. Deleting its tag was not an option — every pinned
 * address that had ever been published would 404, and the build's own
 * droppedTags gate exists to stop exactly that. So the version stays on the
 * mirror and is marked instead.
 *
 * What these tests hold down is that the marking cannot quietly do nothing:
 * a declaration that matches no tag, or names a repo this build does not
 * publish, or withdraws the very version being shipped as newest, is a build
 * failure rather than a line that sits there looking meaningful.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from '@jest/globals';

import {
  loadWithdrawn,
  parseWithdrawn,
  withdrawnProblems,
  withdrawnTagsFor,
} from '../scripts/lib/withdrawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = path.join(ROOT, 'scripts', 'install.sh');

const ENTRY = {
  repo: 'yoyooai/yos-core',
  tag: 'v0.1.22',
  date: '2026-08-28',
  replacedBy: 'v0.1.23',
  reason: 'the health probes reported healthy stores as broken',
};

const doc = (...withdrawn) => JSON.stringify({ schemaVersion: 1, withdrawn });

const tmpDirs = [];
afterAll(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
const tmpDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

describe('the declaration is validated, not just read', () => {
  test('accepts a well-formed entry', () => {
    expect(parseWithdrawn(doc(ENTRY))).toEqual([ENTRY]);
  });

  test('replacedBy is optional', () => {
    const { replacedBy, ...withoutReplacement } = ENTRY;
    expect(parseWithdrawn(doc(withoutReplacement))).toEqual([withoutReplacement]);
  });

  test.each([
    ['not JSON at all', '{'],
    ['not an object', '[]'],
    ['no withdrawn array', '{"schemaVersion":1}'],
    ['entry is not an object', doc('v0.1.22')],
    ['missing reason', doc({ ...ENTRY, reason: undefined })],
    ['blank reason', doc({ ...ENTRY, reason: '   ' })],
    ['repo is not owner/name', doc({ ...ENTRY, repo: 'yos-core' })],
    ['date is not a date', doc({ ...ENTRY, date: '2026/08/28' })],
    ['blank replacedBy', doc({ ...ENTRY, replacedBy: '' })],
    ['the same version twice', doc(ENTRY, ENTRY)],
  ])('rejects: %s', (_label, raw) => {
    // A malformed entry means the page keeps recommending a version we pulled.
    // Silence is the outcome this file exists to prevent, so it must throw.
    expect(() => parseWithdrawn(raw)).toThrow(/withdrawn\.json/);
  });

  test('an absent file means nothing is withdrawn, which is not an error', () => {
    expect(loadWithdrawn(tmpDir('yos-withdrawn-none-'))).toEqual([]);
  });

  test('reads the file when it is there', () => {
    const dir = tmpDir('yos-withdrawn-some-');
    fs.writeFileSync(path.join(dir, 'withdrawn.json'), doc(ENTRY));
    expect(loadWithdrawn(dir)).toEqual([ENTRY]);
  });
});

describe('the declaration is cross-checked against what the build mirrored', () => {
  const repos = () => [{
    repo: 'yoyooai/yos-core',
    tags: ['v0.1.21', 'v0.1.22', 'v0.1.23'],
    droppedTags: ['v0.1.0'],
    newest: 'v0.1.23',
  }];

  test('a real withdrawal is consistent', () => {
    expect(withdrawnProblems([ENTRY], repos())).toEqual([]);
  });

  test('a tag that does not exist is a build failure, not a no-op', () => {
    // The failure being prevented: a typo that withdraws nothing while looking
    // like it withdrew something.
    const problems = withdrawnProblems([{ ...ENTRY, tag: 'v0.1.99' }], repos());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/a withdrawal that matches nothing/);
  });

  test('withdrawing the version this build publishes as newest is refused', () => {
    // Otherwise the default install path serves a version we say not to use.
    const problems = withdrawnProblems([{ ...ENTRY, tag: 'v0.1.23', replacedBy: undefined }], repos());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/cannot withdraw the version this build publishes as newest/);
  });

  test('a repo this build does not publish is refused', () => {
    const problems = withdrawnProblems([{ ...ENTRY, repo: 'yoyooai/yos-gateway' }], repos());
    expect(problems[0]).toMatch(/does not publish/);
  });

  test('pointing at a replacement that is not a tag here is refused', () => {
    const problems = withdrawnProblems([{ ...ENTRY, replacedBy: 'v9.9.9' }], repos());
    expect(problems[0]).toMatch(/replacedBy v9\.9\.9 is not a tag/);
  });

  test('a version already dropped from the mirror can still be withdrawn', () => {
    // Dropped and withdrawn are independent: one is about retention, the other
    // about whether we stand behind it.
    expect(withdrawnProblems([{ ...ENTRY, tag: 'v0.1.0', replacedBy: undefined }], repos())).toEqual([]);
  });

  test('tags are grouped per repo', () => {
    const entries = [ENTRY, { ...ENTRY, repo: 'yoyooai/yos-components', tag: 'feishu-v0.1.1', replacedBy: undefined }];
    expect(withdrawnTagsFor(entries, 'yoyooai/yos-core')).toEqual(new Set(['v0.1.22']));
    expect(withdrawnTagsFor(entries, 'yoyooai/yos-components')).toEqual(new Set(['feishu-v0.1.1']));
  });
});

/**
 * The installer's side. Advisory on purpose: the person named this tag, and an
 * install that dies because an advisory file was unreachable would be worse
 * than the thing it warns about.
 */
describe('the installer warns before installing a withdrawn version', () => {
  // Runs the real function out of install.sh rather than a copy of it — a copy
  // would keep passing after the original was changed.
  const source = fs.readFileSync(INSTALL_SH, 'utf8');
  const start = source.indexOf('warn_if_withdrawn() {');
  const end = source.indexOf('warn_if_withdrawn "$BRANCH"');
  const fn = source.slice(start, end);

  const run = (tag, { serve = true, entry = ENTRY } = {}) => {
    const dir = tmpDir('yos-installer-advisory-');
    if (serve) fs.writeFileSync(path.join(dir, 'withdrawn.json'), doc(entry));
    const script = [
      // Same shell options the installer really runs under. Without them the
      // interesting failure (grep exits 1 when nothing matches, pipefail turns
      // that into a dead install) cannot reproduce.
      'set -euo pipefail',
      'DOWNLOAD_CONNECT_TIMEOUT=5; DOWNLOAD_MAX_TIME=10',
      'warn() { printf "[yos] %s\\n" "$*"; }',
      `dist_url() { printf 'file://${dir}/%s\\n' "$1"; }`,
      fn,
      `warn_if_withdrawn ${tag}`,
      'echo INSTALL_CONTINUED',
    ].join('\n');
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  };

  test('found: it says so, why, and what to use instead — then continues', () => {
    const out = run('v0.1.22');
    expect(out).toMatch(/WITHDRAWN release/);
    expect(out).toContain('the health probes reported healthy stores as broken');
    expect(out).toContain('--branch v0.1.23');
    expect(out).toContain('INSTALL_CONTINUED');
  });

  test('a version that was not withdrawn produces no noise and does not abort', () => {
    // The ordinary case. grep exits 1 here; under `set -euo pipefail` an
    // unguarded pipeline would end the install at this line.
    const out = run('v0.1.21');
    expect(out).not.toMatch(/WITHDRAWN/);
    expect(out).toContain('INSTALL_CONTINUED');
  });

  test('an entry with no replacement still finishes the warning and continues', () => {
    // replacedBy is optional, so this path renders a different set of lines.
    // (Checked while writing this: a failing `[ ... ] && warn` mid-function is
    // exempt from `set -e`, so this does not pin that — what it pins is that a
    // withdrawal with no named replacement still says its piece and continues.)
    const { replacedBy, ...noReplacement } = ENTRY;
    const out = run('v0.1.22', { entry: noReplacement });
    expect(out).toMatch(/WITHDRAWN release/);
    expect(out).not.toContain('Use instead');
    expect(out).toContain('Continuing, because you asked for this version by name.');
    expect(out).toContain('INSTALL_CONTINUED');
  });

  test('an unreachable advisory fails open', () => {
    const out = run('v0.1.22', { serve: false });
    expect(out).not.toMatch(/WITHDRAWN/);
    expect(out).toContain('INSTALL_CONTINUED');
  });

  test('the advisory is actually wired into the install path', () => {
    // The function existing proves nothing if nobody calls it.
    expect(source).toContain('warn_if_withdrawn "$BRANCH"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });
});

/**
 * The wiring. Everything above tests the parts; this runs the real build and
 * checks that a bad declaration stops it and a good one reaches the shelf.
 * Without this, all of the above could pass while nothing called any of it.
 */
describe('the build enforces and publishes the declaration', () => {
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

  const coreFixture = (withdrawnDoc) => {
    const dir = tmpDir('yos-withdrawn-core-');
    git(dir, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    for (const tag of ['v0.1.1', 'v0.1.2', 'v0.1.3']) {
      fs.writeFileSync(path.join(dir, 'package.json'),
        `${JSON.stringify({ name: 'yos', version: tag.slice(1), private: false }, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'scripts', 'install.sh'), `#!/usr/bin/env bash\necho ${tag}\n`);
      fs.writeFileSync(path.join(dir, 'registry.json'), `${JSON.stringify({ components: {} }, null, 2)}\n`);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', `release ${tag}`]);
      git(dir, ['tag', tag]);
    }
    // Written to the working tree, uncommitted on purpose: the build reads the
    // tree it was pointed at, which during a release is main at the release
    // commit.
    if (withdrawnDoc !== null) fs.writeFileSync(path.join(dir, 'withdrawn.json'), withdrawnDoc);
    return dir;
  };

  const componentsFixture = () => {
    const dir = tmpDir('yos-withdrawn-components-');
    git(dir, ['init', '-q', '-b', 'main']);
    const feishu = path.join(dir, 'channels', '001_feishu');
    fs.mkdirSync(feishu, { recursive: true });
    fs.writeFileSync(path.join(feishu, 'SKILL.md'), `---
name: feishu
capabilities:
  - id: communication.message
    title: Messages
    operations: [send, receive]
    keywords: [feishu]
    stability: stable
---
`);
    fs.writeFileSync(path.join(feishu, 'package.json'), `${JSON.stringify({
      name: 'yos-feishu',
      version: '0.1.4',
      yos: { id: 'channel.feishu', core: '>=0.1.0-alpha.1 <0.2.0' },
      engines: { node: '>=20.20.0' },
    }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'release feishu']);
    git(dir, ['tag', 'feishu-v0.1.4']);
    return dir;
  };

  const build = (withdrawnDoc) => {
    const output = tmpDir('yos-withdrawn-out-');
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'build-dist.mjs'),
      '--test-only',
      '--output', output,
      '--repo', `yoyooai/yos-core=${coreFixture(withdrawnDoc)}`,
      '--repo', `yoyooai/yos-components=${componentsFixture()}`,
      '--tags', '5',
      '--skip-vendor',
      '--base-url', 'https://example.test/dist',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output;
  };

  const PULLED = {
    repo: 'yoyooai/yos-core',
    tag: 'v0.1.2',
    date: '2026-08-28',
    replacedBy: 'v0.1.3',
    reason: 'pulled during acceptance',
  };

  test('a declaration naming a tag this build has no idea about stops the build', () => {
    // The failure this guards: a typo that withdraws nothing, silently.
    expect(() => build(doc({ ...PULLED, tag: 'v9.9.9' })))
      .toThrow(/a withdrawal that matches nothing/);
  });

  test('withdrawing the version being published as newest stops the build', () => {
    expect(() => build(doc({ ...PULLED, tag: 'v0.1.3', replacedBy: undefined })))
      .toThrow(/cannot withdraw the version this build publishes as newest/);
  });

  test('a valid declaration reaches the shelf as its own file and inside the index', () => {
    const output = build(doc(PULLED));
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    expect(index.withdrawn).toEqual([PULLED]);

    const published = JSON.parse(fs.readFileSync(path.join(output, 'withdrawn.json'), 'utf8'));
    expect(published.withdrawn).toEqual([PULLED]);
    // Registered like every other mirrored file, or the shelf verifier would
    // not cover it and it could be swapped without anything noticing.
    expect(index.files.map(f => f.path)).toContain('withdrawn.json');
  });

  test('the published page stops offering the pulled version as the example', () => {
    const markdown = fs.readFileSync(path.join(build(doc(PULLED)), 'VERSIONS.md'), 'utf8');
    const pinSection = markdown.split('## 装指定的旧版本')[1].split('\n## ')[0];
    expect(pinSection).not.toContain('--branch v0.1.2');
    // It has another older version to offer, and offers that one instead.
    expect(pinSection).toContain('--branch v0.1.1');
    expect(markdown).toContain('## 已撤回的版本');
    expect(markdown).toContain('pulled during acceptance');
  });

  test('no declaration at all builds fine', () => {
    const index = JSON.parse(fs.readFileSync(path.join(build(null), 'index.json'), 'utf8'));
    expect(index.withdrawn).toEqual([]);
  });
});
