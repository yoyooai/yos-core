/**
 * Render the human-readable side of the distribution mirror.
 *
 * The mirror already states exactly what it carries — index.json, generated at
 * publish time from real tags, real archives and real packages. What was missing
 * was a page a person can read, so "what is the latest version and where do I
 * get it?" got answered from memory, from chat history, or from a table somebody
 * kept by hand.
 *
 * Hand-kept tables do not fail loudly. They go stale in silence while everyone
 * still treats them as the source of truth. Measured the day this was written: a
 * status generator kept reporting a version line that had been retired weeks
 * earlier, because it read a shelf nobody published to anymore — and it looked
 * exactly as confident as when it was right.
 *
 * So this renders FROM the index, inside the same build that writes it. There is
 * no second place to update, therefore no second place to forget. Every install
 * command printed here points at a file the build actually shipped, and
 * `catalogPaths()` exists so the build can prove that before publishing.
 *
 * Component names and descriptions come from the same registry.json the CLI
 * resolves `yos add <name>` against — not from a copy typed into this file.
 */

import { withdrawnTagsFor } from './withdrawn.mjs';

/** Latest first. Mirrors compareVersionsDesc in build-dist.mjs. */
function compareVersionsDesc(a, b) {
  const [aBase, aPre] = String(a).split(/-(.+)/);
  const [bBase, bPre] = String(b).split(/-(.+)/);
  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (bParts[i] || 0) - (aParts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (!aPre && bPre) return -1;
  if (aPre && !bPre) return 1;
  if (!aPre && !bPre) return 0;
  return bPre.localeCompare(aPre, 'en');
}

function versionOf(tag) {
  const match = String(tag).match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match ? match[1] : null;
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * A markdown table cell. Install commands are piped shell — an unescaped pipe
 * ends the cell and silently shreds the row, which on a page whose whole job is
 * "copy this command" turns the answer into garbage.
 */
function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

/**
 * The core is installed from its npm package; a component is installed from the
 * source archive of its tag. Naming the artifact per kind is the point: "is this
 * version on the mirror" has a different answer per install path, and a table
 * that blurs them would promise an offline install the mirror cannot do.
 */
function coreArtifact(repo, tag) {
  const version = versionOf(tag);
  return version ? `${repo}/package/yos-${version}.tgz` : null;
}

function archiveArtifact(repo, tag) {
  return `${repo}/tarball/tags/${tag}.tar.gz`;
}

/**
 * One row per thing a customer can install, newest version first.
 *
 * @param {object} index      the object written to index.json
 * @param {object} [registry] parsed registry.json ({components: {...}})
 * @returns {{rows: object[], legacyTags: string[]}}
 */
export function catalogRows(index, registry = { components: {} }) {
  const repos = Array.isArray(index?.repos) ? index.repos : [];
  const shipped = new Set((index?.files || []).map(f => f.path));
  const withdrawnEntries = Array.isArray(index?.withdrawn) ? index.withdrawn : [];
  const rows = [];
  const legacyTags = [];

  const core = repos.find(r => /\/yos-core$/.test(r.repo || ''));
  if (core) {
    const tags = [...(core.tags || [])].sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b)));
    rows.push({
      id: 'yos',
      kind: 'core',
      label: 'YOS OS 主体',
      description: 'YOS 本体（CLI、服务、技能）',
      repo: core.repo,
      latestTag: tags[0] || null,
      latestVersion: versionOf(tags[0]) || null,
      versions: withMarks(tags, tag => ({
        tag,
        version: versionOf(tag),
        artifact: coreArtifact(core.repo, tag),
        onMirror: shipped.has(coreArtifact(core.repo, tag) || ''),
      }), withdrawnTagsFor(withdrawnEntries, core.repo)),
      // install.sh is republished every build from the newest tag.
      installPaths: ['install.sh'],
    });
  }

  for (const repo of repos) {
    if (!/\/yos-components$/.test(repo.repo || '')) continue;
    const byPrefix = new Map();
    for (const tag of repo.tags || []) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)-v(.+)$/.exec(tag);
      if (!match) {
        // Repo-wide tags from before components were split out. Listed as
        // history rather than dropped: a reader who finds one on GitHub should
        // be able to tell why it is not an installable version here.
        legacyTags.push(tag);
        continue;
      }
      const prefix = match[1];
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(tag);
    }

    const components = registry?.components || {};
    // Registry order first (that is the official set), then anything the mirror
    // carries that the registry does not name — an unregistered component is
    // exactly the state worth showing, not hiding.
    const prefixes = [
      ...Object.entries(components)
        .map(([name, meta]) => [name, meta, meta?.tagPrefix || name])
        .filter(([, , prefix]) => byPrefix.has(prefix)),
      ...[...byPrefix.keys()]
        .filter(prefix => !Object.entries(components).some(([name, meta]) => (meta?.tagPrefix || name) === prefix))
        .map(prefix => [prefix, null, prefix]),
    ];

    for (const [name, meta, prefix] of prefixes) {
      const tags = byPrefix.get(prefix).sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b)));
      rows.push({
        id: name,
        kind: 'component',
        // displayName comes from the registry so the catalog and `yos add` call
        // a component by the same name; falling back to the id keeps an
        // unregistered component visible instead of unnamed.
        label: meta ? (meta.displayName || name) : `${name}（未登记）`,
        description: meta?.description || '镜像里有它的版本，但内置登记册没有登记 —— `yos add ' + name + '` 认不出这个名字',
        registered: Boolean(meta),
        repo: repo.repo,
        latestTag: tags[0] || null,
        latestVersion: versionOf(tags[0]) || null,
        versions: withMarks(tags, tag => ({
          tag,
          version: versionOf(tag),
          artifact: archiveArtifact(repo.repo, tag),
          onMirror: shipped.has(archiveArtifact(repo.repo, tag)),
        }), withdrawnTagsFor(withdrawnEntries, repo.repo)),
        installPaths: [],
      });
    }
  }

  return { rows, legacyTags: legacyTags.sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b))) };
}

/**
 * A withdrawn version stays in the list — it is still on the mirror and someone
 * may have pinned it — but it is marked, so nothing downstream has to remember
 * which ones they were.
 */
function withMarks(tags, build, withdrawnTags) {
  return tags.map(tag => ({ ...build(tag), withdrawn: withdrawnTags.has(tag) }));
}

/** The install command a customer copies, per kind. */
export function installCommand(row, baseUrl) {
  const base = trimSlash(baseUrl);
  if (row.kind === 'core') return `curl -fsSL ${base}/install.sh | bash`;
  return `yos add ${row.id}`;
}

/** How to pin an older version — spelled with a real older version, not <tag>. */
export function pinCommand(row, baseUrl, tag) {
  const base = trimSlash(baseUrl);
  if (!tag) return null;
  if (row.kind === 'core') return `curl -fsSL ${base}/install.sh | bash -s -- --branch ${tag}`;
  const version = versionOf(tag);
  return version ? `yos add ${row.id}@${version}` : null;
}

/**
 * Every mirror-relative path the rendered table points at.
 */
export function catalogPaths({ rows }) {
  const paths = new Set();
  for (const row of rows) {
    for (const p of row.installPaths) paths.add(p);
    for (const version of row.versions) {
      if (version.onMirror && version.artifact) paths.add(version.artifact);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Which addresses the table promises that are not actually there.
 *
 * `exists` must be an INDEPENDENT oracle — the build passes a filesystem check,
 * not a lookup into the same index the rows were derived from. That distinction
 * is the entire value: a check that consults the same source as the thing it
 * checks cannot ever fail, and an assertion that cannot fail is decoration.
 * Caught while mutation-testing this file: removing the original same-source
 * check left every test green.
 *
 * @param {{rows: object[]}} rows   from catalogRows()
 * @param {(path: string) => boolean} exists
 */
export function missingCatalogAddresses(rows, exists) {
  return catalogPaths(rows).filter(p => !exists(p));
}

function mirrorNote(row) {
  const missing = row.versions.filter(v => !v.onMirror).map(v => v.tag);
  if (missing.length === 0) return '每个版本都能离线装回';
  return `⚠️ 这些版本镜像里没有件，装不回：${missing.join('、')}`;
}

/**
 * @param {object}  index
 * @param {object}  opts
 * @param {string}  opts.baseUrl     public address of the mirror
 * @param {object}  [opts.registry]  parsed registry.json
 * @param {string}  [opts.builtAt]   ISO timestamp, passed in rather than read
 *                                   from the clock so a rebuild of the same
 *                                   tree renders the same bytes
 */
export function renderCatalogMarkdown(index, { baseUrl, registry, builtAt } = {}) {
  const base = trimSlash(baseUrl || '');
  const { rows, legacyTags } = catalogRows(index, registry);
  const out = [];

  out.push('# YOS 版本目录');
  out.push('');
  out.push(`**这里是唯一源头。** 版本要看哪个是最新的、去哪里取，看这一张表。`);
  out.push('');
  out.push('这张表不是手写的 —— 它和货是同一次生成的，数据来自镜像自己的 `index.json`（真实 tag、真实制品）。');
  out.push('所以它不可能和实际货架说的不一样。GitHub 上的仓是源码正本和备胎，**不是取货口**。');
  out.push('');
  if (builtAt) out.push(`_源码基准时间：${builtAt}_`);
  out.push('');

  out.push('## 最新版本');
  out.push('');
  out.push('| 组件 | 最新版本 | 怎么装 |');
  out.push('|---|---|---|');
  for (const row of rows) {
    const version = row.latestVersion ? `\`${row.latestVersion}\`` : '❓无版本 tag';
    out.push(`| **${cell(row.label)}** | ${version} | \`${cell(installCommand(row, base))}\` |`);
  }
  out.push('');

  out.push('## 装指定的旧版本');
  out.push('');
  for (const row of rows) {
    // Never work the example with a version we pulled. Falling back to
    // `versions[1]` regardless was how a withdrawn release ended up printed
    // here as the thing to install.
    const usable = row.versions.filter(v => v.tag !== row.latestTag && !v.withdrawn);
    const older = usable.find(v => v.onMirror) || usable[0];
    const example = pinCommand(row, base, older?.tag);
    out.push(`- **${row.label}**：${example ? `\`${example}\`（示例：装 \`${older.version}\`）` : '镜像里没有可推荐的旧版本可钉'}`);
  }
  out.push('');
  out.push('⚠️ `install-v<tag>.sh` 这类地址是**那个 tag 时点的安装器**，直接跑它仍然会装最新版。');
  out.push('要钉版本只有上面这一种写法。');
  out.push('');

  out.push('## 镜像里有哪些版本');
  out.push('');
  for (const row of rows) {
    out.push(`### ${row.label}`);
    out.push('');
    out.push(`${row.description}`);
    out.push('');
    if (!row.registered && row.kind === 'component') {
      out.push('⚠️ **内置登记册没有登记这个组件** —— 按名字装不出来。');
      out.push('');
    }
    out.push(`- 源码正本（备胎）：\`${row.repo}\``);
    out.push(`- 镜像留存 ${row.versions.length} 个版本：${row.versions.map(v => (v.withdrawn ? `~~\`${v.version}\`~~（已撤回）` : `\`${v.version}\``)).join(' ')}`);
    out.push(`- ${mirrorNote(row)}`);
    out.push('');
  }

  if (legacyTags.length > 0) {
    out.push('## 历史标签（不是可装的版本）');
    out.push('');
    out.push('渠道拆分成独立组件之前打的整仓标签，留着只为对得上历史，**不对应任何一个可装的组件**：');
    out.push('');
    out.push(legacyTags.map(t => `\`${t}\``).join(' '));
    out.push('');
  }

  // Withdrawn is not the same as dropped, and conflating them would be a lie in
  // both directions: a dropped version is gone from the mirror, a withdrawn one
  // is still here on purpose so that pinned addresses keep working.
  const withdrawn = Array.isArray(index?.withdrawn) ? index.withdrawn : [];
  out.push('## 已撤回的版本');
  out.push('');
  if (withdrawn.length === 0) {
    out.push('没有 —— 发布过的版本都还作数。');
  } else {
    out.push('这些版本发布过，后来被我们撤回了。**件还在镜像上**（已经钉了它的地址不会 404），');
    out.push('但目录不再拿它举例，装它的时候安装器会当场说明。');
    out.push('');
    for (const entry of withdrawn) {
      const replaced = entry.replacedBy ? `，改用 \`${versionOf(entry.replacedBy) || entry.replacedBy}\`` : '';
      out.push(`- \`${entry.repo}\` \`${versionOf(entry.tag) || entry.tag}\`（${entry.date} 撤回${replaced}）：${entry.reason}`);
    }
  }
  out.push('');

  const dropped = (index?.repos || []).flatMap(r => (r.droppedTags || []).map(t => `${r.repo} ${t}`));
  out.push('## 掉出镜像的版本');
  out.push('');
  if (dropped.length === 0) {
    out.push('没有 —— 目前每个打过的版本都还在镜像上。');
  } else {
    // Retention is a real limit. What is not acceptable is meeting it as a 404.
    out.push('留存上限用满后，这些版本已经不在镜像上了（装它们会 404）：');
    out.push('');
    for (const entry of dropped) out.push(`- \`${entry}\``);
  }
  out.push('');

  return `${out.join('\n')}\n`;
}

/** Same content as the markdown, for a browser. Self-contained, no assets. */
export function renderCatalogHtml(index, options = {}) {
  const markdown = renderCatalogMarkdown(index, options);
  const escape = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Deliberately not a markdown engine: the page must render with no
  // dependency reachable from a machine that cannot reach the internet.
  const body = escape(markdown);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YOS 版本目录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 52rem;
         font: 15px/1.65 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0;
        font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<pre>${body}</pre>
</body>
</html>
`;
}
