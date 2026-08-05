import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { extractTarball } from '../download.js';
import { buildTagName, matchTagVersion, selectInstallVersion } from '../github.js';
import { resolveTarget } from '../components.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-subdir-test-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Build a fixture that mirrors a GitHub archive of a repository holding two
 * components: a single top-level wrapper directory, component subdirectories
 * below it, plus repo-level files that must never reach an install.
 */
function makeMultiComponentArchive() {
  const root = makeTmpDir();
  const wrapper = path.join(root, 'YOS-Channels-v0.1.0');
  const feishu = path.join(wrapper, 'channels', '001_feishu');
  const weixin = path.join(wrapper, 'channels', '002_weixin');

  fs.mkdirSync(feishu, { recursive: true });
  fs.mkdirSync(weixin, { recursive: true });
  fs.writeFileSync(path.join(feishu, 'SKILL.md'), '---\nname: feishu\nversion: 0.1.0\n---\n');
  fs.writeFileSync(path.join(feishu, 'feishu.js'), 'export const which = "feishu";\n');
  fs.writeFileSync(path.join(weixin, 'SKILL.md'), '---\nname: weixin\nversion: 0.2.0\n---\n');
  fs.writeFileSync(path.join(wrapper, 'DEV-PLAN.md'), 'repo-level development notes\n');
  fs.mkdirSync(path.join(wrapper, 'test'), { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'test', 'root.test.js'), '// repo-level test\n');

  const tarballPath = path.join(root, 'archive.tar.gz');
  execFileSync('tar', ['czf', tarballPath, '-C', root, 'YOS-Channels-v0.1.0'], { stdio: 'pipe' });
  return tarballPath;
}

describe('component subdirectory extraction', () => {
  it('installs only the requested component subtree', () => {
    const tarballPath = makeMultiComponentArchive();
    const destDir = path.join(makeTmpDir(), 'feishu');

    const result = extractTarball(tarballPath, destDir, { subdir: 'channels/001_feishu' });

    assert.equal(result.success, true, result.error);
    // The component's own files land at the root of the install directory,
    // which is where detectComponentType/parseSkillMd look for them.
    assert.equal(fs.existsSync(path.join(destDir, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(destDir, 'feishu.js')), true);
    // Siblings and repo-level material must not follow it in.
    assert.equal(fs.existsSync(path.join(destDir, 'channels')), false);
    assert.equal(fs.existsSync(path.join(destDir, 'DEV-PLAN.md')), false);
    assert.equal(fs.existsSync(path.join(destDir, 'test')), false);
  });

  it('installs each sibling component independently from the same archive', () => {
    const tarballPath = makeMultiComponentArchive();
    const root = makeTmpDir();
    const feishuDir = path.join(root, 'feishu');
    const weixinDir = path.join(root, 'weixin');

    assert.equal(extractTarball(tarballPath, feishuDir, { subdir: 'channels/001_feishu' }).success, true);
    assert.equal(extractTarball(tarballPath, weixinDir, { subdir: 'channels/002_weixin' }).success, true);

    assert.match(fs.readFileSync(path.join(feishuDir, 'SKILL.md'), 'utf8'), /name: feishu/);
    assert.match(fs.readFileSync(path.join(weixinDir, 'SKILL.md'), 'utf8'), /name: weixin/);
  });

  it('extracts the whole archive when no subdirectory is requested', () => {
    const tarballPath = makeMultiComponentArchive();
    const destDir = path.join(makeTmpDir(), 'whole');

    const result = extractTarball(tarballPath, destDir);

    assert.equal(result.success, true, result.error);
    assert.equal(fs.existsSync(path.join(destDir, 'channels', '001_feishu', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(destDir, 'DEV-PLAN.md')), true);
  });

  it('reports a missing component path instead of installing the repository root', () => {
    const tarballPath = makeMultiComponentArchive();
    const destDir = path.join(makeTmpDir(), 'absent');

    const result = extractTarball(tarballPath, destDir, { subdir: 'channels/003_absent' });

    assert.equal(result.success, false);
    assert.match(result.error, /channels\/003_absent/);
    assert.equal(fs.existsSync(path.join(destDir, 'DEV-PLAN.md')), false);
  });

  it('refuses a component path that escapes the archive', () => {
    const tarballPath = makeMultiComponentArchive();
    const outside = makeTmpDir();
    const destDir = path.join(outside, 'escape');

    const result = extractTarball(tarballPath, destDir, { subdir: '../../etc' });

    assert.equal(result.success, false);
    assert.match(result.error, /escapes the archive/);
  });
});

describe('per-component version lines', () => {
  it('builds prefixed tags for components that share a repository', () => {
    assert.equal(buildTagName('0.1.0', 'feishu'), 'feishu-v0.1.0');
    assert.equal(buildTagName('v0.1.0', 'feishu'), 'feishu-v0.1.0');
    assert.equal(buildTagName('0.1.0'), 'v0.1.0');
    assert.equal(buildTagName('v0.1.0'), 'v0.1.0');
  });

  it('reads a version only from its own tag line', () => {
    assert.equal(matchTagVersion('feishu-v0.1.0', 'feishu'), '0.1.0');
    assert.equal(matchTagVersion('feishu-v0.1.0-alpha.1', 'feishu'), '0.1.0-alpha.1');
    // A sibling's tag must be invisible, otherwise one component would report
    // the other's version as its own update.
    assert.equal(matchTagVersion('weixin-v9.9.9', 'feishu'), null);
    // Repository-wide tags are not a component's version either.
    assert.equal(matchTagVersion('v9.9.9', 'feishu'), null);
  });

  it('keeps single-component repositories on bare tags', () => {
    assert.equal(matchTagVersion('v1.2.3', null), '1.2.3');
    assert.equal(matchTagVersion('1.2.3', null), '1.2.3');
    // Prefixed tags belong to a component line and must not leak into the
    // repository-wide line.
    assert.equal(matchTagVersion('feishu-v9.9.9', null), null);
    assert.equal(matchTagVersion('not-a-version', null), null);
  });
});

describe('registry entries for components inside a repository', () => {
  it('carries path and tag prefix into the install source', async () => {
    // An explicit version keeps resolution offline.
    const resolved = await resolveTarget('feishu@0.1.0');

    assert.equal(resolved.repo, 'Qingjingyu/YOS-Channels');
    assert.equal(resolved.source.type, 'github-release');
    assert.equal(resolved.source.path, 'channels/001_feishu');
    assert.equal(resolved.source.tagPrefix, 'feishu');
    // Registered components are ours; the third-party warning would misinform.
    assert.equal(resolved.isThirdParty, false);
    // Two components share one repo, so the label has to say which is which.
    assert.match(resolved.sourceLabel, /channels\/001_feishu/);
  });

  it('leaves whole-repository components without a path', async () => {
    const resolved = await resolveTarget('some-org/some-component@1.0.0');

    assert.equal(resolved.source.type, 'github-release');
    assert.equal(resolved.source.path, undefined);
    assert.equal(resolved.source.tagPrefix, undefined);
  });
});

describe('upgrade scoping for components inside a repository', () => {
  it('reads the component path and tag line from its recorded install source', async () => {
    const yosDir = makeTmpDir();
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    fs.writeFileSync(
      path.join(yosDir, '.yos', 'components.json'),
      JSON.stringify({
        feishu: {
          version: '0.1.0',
          repo: 'some-org/channels',
          source: {
            type: 'github-release',
            repo: 'some-org/channels',
            ref: '0.1.0',
            refType: 'tag',
            path: 'channels/001_feishu',
            tagPrefix: 'feishu',
          },
        },
        solo: {
          version: '1.0.0',
          repo: 'some-org/solo',
          source: { type: 'github-release', repo: 'some-org/solo', ref: '1.0.0', refType: 'tag' },
        },
      }),
      'utf8'
    );

    // config.js reads YOS_DIR at import time, so the override precedes the import.
    const previous = process.env.YOS_DIR;
    process.env.YOS_DIR = yosDir;
    try {
      const { getComponentSourceMeta } = await import(
        `../upgrade.js?subdir-upgrade-scope=${encodeURIComponent(yosDir)}`
      );

      // Without this an upgrade would download the whole repository over a
      // component and compare against a sibling's version line.
      assert.deepEqual(getComponentSourceMeta('feishu'), {
        subdir: 'channels/001_feishu',
        tagPrefix: 'feishu',
      });
      assert.deepEqual(getComponentSourceMeta('solo'), { subdir: null, tagPrefix: null });
    } finally {
      if (previous === undefined) delete process.env.YOS_DIR;
      else process.env.YOS_DIR = previous;
    }
  });
});

describe('choosing the version an install resolves to', () => {
  it('prefers a stable release over any prerelease', () => {
    const picked = selectInstallVersion(['v1.0.0', 'v1.1.0-alpha.1', 'v0.9.0']);
    assert.deepEqual(picked, { version: '1.0.0', prerelease: false });
  });

  it('falls back to the newest prerelease when no stable release exists', () => {
    // Without this a component whose whole line is still alpha resolves to no
    // version, and the documented `yos add <name>` fails outright.
    const picked = selectInstallVersion(['v0.1.0-alpha.1', 'v0.1.0-alpha.2']);
    assert.deepEqual(picked, { version: '0.1.0-alpha.2', prerelease: true });
  });

  it('reports no version when the tag line is empty', () => {
    assert.deepEqual(selectInstallVersion([]), { version: null, prerelease: false });
    assert.deepEqual(selectInstallVersion(['not-a-version']), { version: null, prerelease: false });
  });

  it('chooses within one component tag line only', () => {
    const tags = [
      'feishu-v0.1.0-alpha.1',
      'weixin-v2.0.0',        // a sibling's stable release
      'v3.0.0',               // a repository-wide release
    ];
    // The sibling's stable tag must not satisfy feishu, or feishu would resolve
    // to a version that was never published for it.
    assert.deepEqual(
      selectInstallVersion(tags, { tagPrefix: 'feishu' }),
      { version: '0.1.0-alpha.1', prerelease: true }
    );
    assert.deepEqual(
      selectInstallVersion(tags, { tagPrefix: 'weixin' }),
      { version: '2.0.0', prerelease: false }
    );
  });
});
