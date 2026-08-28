/**
 * The version catalog must not be able to disagree with the shipped mirror.
 *
 * The question "what is the latest version and where do I get it?" used to be
 * answered from memory or from a table somebody kept by hand. Measured 2026-08-06:
 * a status generator confidently reported `0.3.7` as the live version — a line
 * that had been retired the day before — because it read a shelf nobody
 * published to anymore. Nothing failed; it just lied.
 *
 * So the catalog is rendered from index.json inside the build that writes it.
 * These tests lock the properties that make that worth anything:
 *
 *   1. the version it calls newest IS the newest tag the mirror carries;
 *   2. a version whose artifact is NOT on the mirror is called out, never
 *      presented as installable — silence here is the whole original defect;
 *   3. the copy-paste install command survives the markdown table (a raw pipe in
 *      `curl … | bash` ends the cell and shreds the row);
 *   4. a component the built-in registry does not name still appears, marked —
 *      an unregistered component is a state to show, not to hide;
 *   5. the published catalog is itself digest-covered in index.json, like every
 *      other mirrored file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from '@jest/globals';
import {
  catalogPaths,
  catalogRows,
  installCommand,
  missingCatalogAddresses,
  pinCommand,
  renderCatalogHtml,
  renderCatalogMarkdown,
} from '../scripts/lib/dist-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIST = path.join(ROOT, 'scripts', 'build-dist.mjs');
const BASE = 'https://example.test/dist';

const REGISTRY = {
  components: {
    feishu: { repo: 'yoyooai/yos-components', tagPrefix: 'feishu', displayName: '飞书渠道', description: 'Feishu channel' },
  },
};

/** An index.json-shaped object; `absent` names artifacts to leave unshipped. */
function fakeIndex({ absent = [] } = {}) {
  const files = [
    { path: 'install.sh' },
    { path: 'yoyooai/yos-core/package/yos-0.2.0.tgz' },
    { path: 'yoyooai/yos-core/package/yos-0.1.9.tgz' },
    { path: 'yoyooai/yos-components/tarball/tags/feishu-v0.1.1.tar.gz' },
    { path: 'yoyooai/yos-components/tarball/tags/dingtalk-v0.1.0.tar.gz' },
  ].filter(f => !absent.includes(f.path));
  return {
    repos: [
      { repo: 'yoyooai/yos-core', tags: ['v0.1.9', 'v0.2.0'], packages: [], droppedTags: [] },
      {
        repo: 'yoyooai/yos-components',
        tags: ['feishu-v0.1.1', 'dingtalk-v0.1.0', 'v0.1.0'],
        packages: [],
        droppedTags: [],
      },
    ],
    files,
  };
}

describe('version catalog (rendering)', () => {
  test('calls the newest tag newest, not whatever came last in the list', () => {
    const { rows } = catalogRows(fakeIndex(), REGISTRY);
    const core = rows.find(r => r.id === 'yos');
    // v0.2.0 is listed after v0.1.9 in the fixture on purpose.
    expect(core.latestVersion).toBe('0.2.0');
    const markdown = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toMatch(/\*\*YOS OS 主体\*\* \| `0\.2\.0`/);
  });

  test('a version whose artifact is missing is called out, not shown as installable', () => {
    const absent = ['yoyooai/yos-core/package/yos-0.1.9.tgz'];
    const { rows } = catalogRows(fakeIndex({ absent }), REGISTRY);
    const core = rows.find(r => r.id === 'yos');
    expect(core.versions.find(v => v.version === '0.1.9').onMirror).toBe(false);
    expect(core.versions.find(v => v.version === '0.2.0').onMirror).toBe(true);

    const markdown = renderCatalogMarkdown(fakeIndex({ absent }), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('装不回：v0.1.9');
    // And the missing one must not be offered as an address to fetch.
    expect(catalogPaths(catalogRows(fakeIndex({ absent }), REGISTRY))).not.toContain(absent[0]);
  });

  test('when everything is present it says so instead of staying silent', () => {
    const markdown = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('每个版本都能离线装回');
    expect(markdown).not.toContain('装不回');
  });

  test('the piped install command survives the table', () => {
    const markdown = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    const row = markdown.split('\n').find(line => line.includes('YOS OS 主体') && line.startsWith('|'));
    // Cells are split on unescaped pipes only; a raw pipe in `curl … | bash`
    // would make this four cells and cut the command in half.
    const cells = row.split(/(?<!\\)\|/).slice(1, -1);
    expect(cells).toHaveLength(3);
    expect(cells[2]).toContain('curl -fsSL https://example.test/dist/install.sh \\| bash');
  });

  test('pinning an older version is spelled with a real version, per kind', () => {
    const { rows } = catalogRows(fakeIndex(), REGISTRY);
    const core = rows.find(r => r.id === 'yos');
    const feishu = rows.find(r => r.id === 'feishu');
    expect(installCommand(core, BASE)).toBe('curl -fsSL https://example.test/dist/install.sh | bash');
    expect(pinCommand(core, BASE, 'v0.1.9')).toBe(
      'curl -fsSL https://example.test/dist/install.sh | bash -s -- --branch v0.1.9'
    );
    expect(installCommand(feishu, BASE)).toBe('yos add feishu');
    expect(pinCommand(feishu, BASE, 'feishu-v0.1.0')).toBe('yos add feishu@0.1.0');
  });

  test('a registered component is called what the registry calls it', () => {
    const markdown = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    // The name in the catalog and the name `yos add` resolves come from one file.
    expect(markdown).toContain('飞书渠道');
    expect(markdown).toContain('yos add feishu');
  });

  test('a component the registry does not name is shown, marked, not hidden', () => {
    const markdown = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('dingtalk（未登记）');
    expect(markdown).toContain('内置登记册没有登记这个组件');
  });

  test('repo-wide tags from before the split are history, not installable versions', () => {
    const { rows, legacyTags } = catalogRows(fakeIndex(), REGISTRY);
    expect(legacyTags).toContain('v0.1.0');
    expect(rows.some(r => r.id === 'v0.1.0')).toBe(false);
  });

  test('dropped tags are stated — a retention limit must not be met as a 404', () => {
    const index = fakeIndex();
    index.repos[0].droppedTags = ['v0.0.9'];
    const markdown = renderCatalogMarkdown(index, { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('yoyooai/yos-core v0.0.9');
  });

  /**
   * The gate the build runs before publishing. It exists as its own function
   * precisely so it can be tested: the first version consulted the same index
   * the rows were built from, which made it unable to fail — mutation-testing
   * removed it entirely and every test stayed green.
   */
  describe('the publish gate', () => {
    test('reports every promised address when none of them are there', () => {
      const rows = catalogRows(fakeIndex(), REGISTRY);
      const absent = missingCatalogAddresses(rows, () => false);
      expect(absent).toEqual(catalogPaths(rows));
      expect(absent).toContain('install.sh');
      expect(absent.length).toBeGreaterThan(1);
    });

    test('reports nothing when they are all there', () => {
      expect(missingCatalogAddresses(catalogRows(fakeIndex(), REGISTRY), () => true)).toEqual([]);
    });

    test('names the one address that is missing, not just "something is wrong"', () => {
      const gone = 'yoyooai/yos-core/package/yos-0.2.0.tgz';
      const absent = missingCatalogAddresses(catalogRows(fakeIndex(), REGISTRY), p => p !== gone);
      expect(absent).toEqual([gone]);
    });

    test('checks a source independent of the index — the build passes a disk check', () => {
      // A path present in index.files but absent from disk must still be caught;
      // that is the failure mode the same-source version could not see.
      const index = fakeIndex();
      const onDisk = new Set(index.files.map(f => f.path));
      onDisk.delete('install.sh');
      const absent = missingCatalogAddresses(catalogRows(index, REGISTRY), p => onDisk.has(p));
      expect(absent).toEqual(['install.sh']);
    });
  });

  test('the same tree renders the same bytes (no clock read inside)', () => {
    const once = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    const twice = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(once).toBe(twice);
  });

  test('labels the deterministic source timestamp honestly', () => {
    const markdown = renderCatalogMarkdown(fakeIndex(), {
      baseUrl: BASE,
      registry: REGISTRY,
      builtAt: '2026-08-10T08:00:00Z',
    });
    expect(markdown).toContain('_源码基准时间：2026-08-10T08:00:00Z_');
    expect(markdown).not.toContain('出货时间');
  });
});

describe('version catalog (published by the build)', () => {
  const TAGS = ['v0.1.0', 'v0.1.1'];
  let output;
  let secondOutput;
  let buildLog;

  function git(cwd, args) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  }

  beforeAll(() => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-catalog-fixture-'));
    git(fixture, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const tag of TAGS) {
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        `${JSON.stringify({ name: 'yos', version: tag.slice(1), private: false }, null, 2)}\n`
      );
      fs.writeFileSync(path.join(fixture, 'scripts', 'install.sh'), `#!/usr/bin/env bash\necho ${tag}\n`);
      fs.writeFileSync(
        path.join(fixture, 'registry.json'),
        `${JSON.stringify({ components: {} }, null, 2)}\n`
      );
      git(fixture, ['add', '-A']);
      git(fixture, ['commit', '-q', '-m', `release ${tag}`]);
      git(fixture, ['tag', tag]);
    }

    // Registry changes are shelf metadata, not a reason to release Core. The
    // matching component must still have a reviewed tag before it is emitted.
    fs.writeFileSync(
      path.join(fixture, 'registry.json'),
      `${JSON.stringify({
        components: {
          feishu: {
            repo: 'yoyooai/yos-components',
            path: 'channels/001_feishu',
            tagPrefix: 'feishu',
            official: true,
          },
        },
      }, null, 2)}\n`,
    );
    git(fixture, ['add', 'registry.json']);
    git(fixture, ['commit', '-q', '-m', 'register feishu after the core release']);

    const componentsFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-components-catalog-fixture-'));
    git(componentsFixture, ['init', '-q', '-b', 'main']);
    const feishuDir = path.join(componentsFixture, 'channels', '001_feishu');
    fs.mkdirSync(feishuDir, { recursive: true });
    fs.writeFileSync(path.join(feishuDir, 'SKILL.md'), `---
name: feishu
capabilities:
  - id: communication.message
    title: Messages
    operations: [send, receive]
    keywords: [feishu]
    stability: stable
---
`);
    fs.writeFileSync(path.join(feishuDir, 'package.json'), `${JSON.stringify({
      name: 'yos-feishu',
      version: '0.1.4',
      yos: { id: 'channel.feishu', core: '>=0.1.0-alpha.1 <0.2.0' },
      engines: { node: '>=20.20.0' },
    }, null, 2)}\n`);
    git(componentsFixture, ['add', '-A']);
    git(componentsFixture, ['commit', '-q', '-m', 'release feishu']);
    git(componentsFixture, ['tag', 'feishu-v0.1.4']);

    output = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-catalog-out-'));
    buildLog = execFileSync(process.execPath, [
      BUILD_DIST,
      '--test-only',
      '--output', output,
      '--repo', `yoyooai/yos-core=${fixture}`,
      '--repo', `yoyooai/yos-components=${componentsFixture}`,
      '--tags', '2',
      '--skip-vendor',
      '--base-url', BASE,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    secondOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-catalog-out-'));
    execFileSync(process.execPath, [
      BUILD_DIST,
      '--test-only',
      '--output', secondOutput,
      '--repo', `yoyooai/yos-core=${fixture}`,
      '--repo', `yoyooai/yos-components=${componentsFixture}`,
      '--tags', '2',
      '--skip-vendor',
      '--base-url', BASE,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }, 180000);

  test('both a readable page and a markdown table are published', () => {
    expect(fs.existsSync(path.join(output, 'VERSIONS.md'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'index.html'))).toBe(true);
  });

  test('the published table names the version the build actually shipped', () => {
    const markdown = fs.readFileSync(path.join(output, 'VERSIONS.md'), 'utf8');
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    const core = index.repos.find(r => r.repo === 'yoyooai/yos-core');
    expect(core.packages).toContain('yos-0.1.1.tgz');
    expect(markdown).toMatch(/\*\*YOS OS 主体\*\* \| `0\.1\.1`/);
    expect(markdown).toContain(`${BASE}/install.sh`);
  });

  test('the build states that every address in the table was checked present', () => {
    expect(buildLog).toMatch(/artifact address\(es\) verified present/);
  });

  test('the catalog is digest-covered in index.json like every other file', () => {
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    for (const name of ['VERSIONS.md', 'index.html']) {
      const entry = index.files.find(f => f.path === name);
      expect(entry).toBeDefined();
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('index.json and capabilities.json carry one build identity', () => {
    const index = JSON.parse(fs.readFileSync(path.join(output, 'index.json'), 'utf8'));
    const capabilities = JSON.parse(fs.readFileSync(path.join(output, 'capabilities.json'), 'utf8'));
    expect(index.buildId).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilities.buildId).toBe(index.buildId);
    const entry = index.files.find(file => file.path === 'capabilities.json');
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilities.capabilities[0].providers[0]).toMatchObject({
      id: 'channel.feishu',
      registryName: 'feishu',
      tag: 'feishu-v0.1.4',
      version: '0.1.4',
    });
  });

  test('two independent shelf builds produce byte-identical machine catalogs', () => {
    for (const name of ['index.json', 'capabilities.json']) {
      expect(fs.readFileSync(path.join(output, name)))
        .toEqual(fs.readFileSync(path.join(secondOutput, name)));
    }
  });

  test('the page carries the "single source of truth" wording, so nobody keeps a second table', () => {
    const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
    expect(html).toContain('唯一源头');
    expect(html).toContain('不是取货口'); // GitHub is the backup, not the counter
  });
});

/**
 * Withdrawn versions.
 *
 * 0.1.22 was published, failed its own customer-path acceptance about 25
 * minutes later, and was rolled back. The catalog then kept offering it as the
 * worked example of installing an older version — not because anything was
 * broken, but because "older" was computed as "the previous tag" and nothing in
 * the data said one of those tags was no longer something we stand behind.
 *
 * The fix is a data concept, not a special case in the renderer: hardcoding
 * "skip 0.1.22" would be the same defect this product spent two releases
 * removing — a fact written into code that nothing keeps current.
 */
describe('withdrawn versions', () => {
  const withdrawnIndex = () => ({
    ...fakeIndex(),
    withdrawn: [{
      repo: 'yoyooai/yos-core',
      tag: 'v0.1.9',
      date: '2026-08-28',
      replacedBy: 'v0.2.0',
      reason: 'the health probes reported healthy stores as broken',
    }],
  });

  test('a withdrawn version is never the worked example for pinning', () => {
    // Without the fix this is exactly what the page printed: the only older
    // version there is, which is the one we pulled.
    const before = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(before).toContain('--branch v0.1.9');

    const after = renderCatalogMarkdown(withdrawnIndex(), { baseUrl: BASE, registry: REGISTRY });
    const pinSection = after.split('## 装指定的旧版本')[1].split('\n## ')[0];
    expect(pinSection).not.toContain('--branch v0.1.9');
    // And it says so rather than printing a command with an empty version.
    expect(pinSection).toContain('没有可推荐的旧版本可钉');
  });

  test('the version is still listed and still on the mirror — withdrawn is not deleted', () => {
    // A pinned address that 404s is a worse failure than a version that
    // installs with a warning, so the artifact must stay.
    const { rows } = catalogRows(withdrawnIndex(), REGISTRY);
    const core = rows.find(r => r.id === 'yos');
    const pulled = core.versions.find(v => v.version === '0.1.9');
    expect(pulled.onMirror).toBe(true);
    expect(pulled.withdrawn).toBe(true);
    expect(core.versions.find(v => v.version === '0.2.0').withdrawn).toBe(false);

    const markdown = renderCatalogMarkdown(withdrawnIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('~~`0.1.9`~~（已撤回）');
  });

  test('the page says which version was withdrawn, when, why, and what to use', () => {
    const markdown = renderCatalogMarkdown(withdrawnIndex(), { baseUrl: BASE, registry: REGISTRY });
    const section = markdown.split('## 已撤回的版本')[1].split('\n## ')[0];
    expect(section).toContain('`0.1.9`');
    expect(section).toContain('2026-08-28');
    expect(section).toContain('the health probes reported healthy stores as broken');
    expect(section).toContain('`0.2.0`');
  });

  test('withdrawn and dropped are kept apart', () => {
    // Dropped means gone from the mirror (installing it 404s). Withdrawn means
    // still there on purpose. Merging the two sections would be false in both
    // directions.
    const markdown = renderCatalogMarkdown(withdrawnIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('## 已撤回的版本');
    expect(markdown).toContain('## 掉出镜像的版本');
    const dropped = markdown.split('## 掉出镜像的版本')[1];
    expect(dropped).toContain('没有 —— 目前每个打过的版本都还在镜像上');
  });

  test('a shelf with nothing withdrawn says so instead of omitting the section', () => {
    const markdown = renderCatalogMarkdown(fakeIndex(), { baseUrl: BASE, registry: REGISTRY });
    expect(markdown).toContain('## 已撤回的版本');
    expect(markdown).toContain('没有 —— 发布过的版本都还作数。');
  });
});

/**
 * The catalog reaches a browser as a laid-out page, not as its own source.
 *
 * For most of this file's life index.html was the markdown escaped into one
 * <pre>: right content, unreadable presentation. Rendering it put a parser
 * between the data and the reader, so these lock the two things that parser must
 * never do — pass raw syntax through to the shelf, and read data as markup.
 */
describe('version catalog (rendered for a browser)', () => {
  const page = () => renderCatalogHtml(withdrawnCatalogIndex(), { baseUrl: BASE, registry: REGISTRY });
  const withdrawnCatalogIndex = () => ({
    ...fakeIndex(),
    withdrawn: [{
      repo: 'yoyooai/yos-core',
      tag: 'v0.1.9',
      date: '2026-08-28',
      replacedBy: 'v0.2.0',
      reason: 'probes resolved against the package copy, which ships no node_modules',
    }],
  });

  test('the page is markup, not a wall of markdown source', () => {
    const html = page();
    expect(html).not.toContain('<pre>');
    expect(html).toContain('<h1>YOS 版本目录</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>组件</th>');
    expect(html).toContain('<title>YOS 版本目录</title>');
  });

  test('no leftover markdown syntax reaches the body', () => {
    const body = page().split('<body>')[1];
    expect(body).not.toMatch(/\*\*/);
    expect(body).not.toMatch(/~~/);
    expect(body).not.toMatch(/`/);
    expect(body).not.toMatch(/\|---/);
    expect(body).not.toMatch(/^#{1,6} /m);
    expect(body).not.toMatch(/^- /m);
    expect(body).not.toMatch(/\\/);
  });

  test('the install command survives the table with its pipe intact', () => {
    // The row-shredding defect, now checked on the rendered side too: the pipe
    // must be inside one cell, not a cell border.
    expect(page()).toContain(`<code>curl -fsSL ${BASE}/install.sh | bash</code>`);
  });

  /**
   * Measured the first time the renderer ran against the real mirror: the live
   * withdrawal reason says "ships no node_modules", and that underscore opened
   * an italic run. Free text is data — it must render as written.
   */
  test('markdown characters in free-text data render literally', () => {
    expect(page()).toContain('ships no node_modules');

    const loud = {
      ...withdrawnCatalogIndex(),
      withdrawn: [{
        repo: 'yoyooai/yos-core',
        tag: 'v0.1.9',
        date: '2026-08-28',
        reason: 'a **bold** claim, a | pipe, an _underscore_ and a [link](x)',
      }],
    };
    const html = renderCatalogHtml(loud, { baseUrl: BASE, registry: REGISTRY });
    expect(html).toContain('a **bold** claim, a | pipe, an _underscore_ and a [link](x)');
    expect(html).not.toContain('<strong>bold</strong>');
  });

  test('a component description carrying markdown cannot break the build', () => {
    const registry = {
      components: {
        feishu: {
          repo: 'yoyooai/yos-components',
          tagPrefix: 'feishu',
          displayName: '飞书渠道',
          description: 'DM *and* group messaging_with underscores | and a pipe',
        },
      },
    };
    const html = renderCatalogHtml(fakeIndex(), { baseUrl: BASE, registry });
    expect(html).toContain('DM *and* group messaging_with underscores | and a pipe');
  });
});
