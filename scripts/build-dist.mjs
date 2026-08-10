#!/usr/bin/env node
/**
 * Build the YOS distribution mirror: a directory of static files that serves
 * everything an install needs, so a customer machine never has to reach GitHub.
 *
 * The JSON documents deliberately copy GitHub's response shape (`tags.json`
 * mirrors /repos/:repo/tags, `releases/latest.json` mirrors
 * /repos/:repo/releases/latest) so the client parses one format no matter which
 * origin answered. See cli/lib/dist-origin.js for the consuming side.
 *
 * Usage:
 *   node scripts/build-dist.mjs --output <dir> \
 *     (--production | --test-only) \
 *     --repo yoyooai/yos-core=. \
 *     --repo yoyooai/yos-components=../yos-components \
 *     [--tags 50] [--default-branch main] [--vendor-cache <dir>]
 *     [--skip-vendor] [--allow-missing-vendor] [--allow-tag-drop]
 *
 * Output layout (under <dir>):
 *   install.sh                                   installer from the newest core release
 *   install-<tag>.sh                             the same installer, pinned — one
 *                                                per mirrored tag, each taken
 *                                                from that tag
 *   index.json                                  what this build contains, with sha256 per file
 *   <owner>/<repo>/tags.json                     every mirrored tag
 *   <owner>/<repo>/releases/latest.json          newest tag, for the installer
 *   <owner>/<repo>/tarball/tags/<tag>.tar.gz     source archive (GitHub archive shape)
 *   <owner>/<repo>/raw/<ref>/<path>              small metadata files read at runtime
 *   <owner>/<repo>/package/<name>-<version>.tgz  npm package (core only)
 *   vendor/...                                   re-hosted third-party artifacts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  catalogPaths,
  catalogRows,
  missingCatalogAddresses,
  renderCatalogHtml,
  renderCatalogMarkdown,
} from './lib/dist-catalog.mjs';
import { deriveCapabilityIndex } from './lib/capability-index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Small files the CLI reads at runtime (see fetchRawFile call sites). */
const RAW_FILE_NAMES = new Set(['registry.json', 'package.json', 'SKILL.md', 'CHANGELOG.md', 'VERSION']);
const RAW_MAX_DEPTH = 3;

function parseArgs(argv) {
  const options = {
    // Retention per version line. Was 5, then 20; both let a previously public
    // pinned installer disappear under rsync --delete. Fifty is breathing room,
    // not a promise of forever. The actual safety property is the preflight
    // below: dropping any tag now requires an explicit --allow-tag-drop.
    output: null, repos: [], tags: 50, defaultBranch: 'main', mode: null,
    skipVendor: false, allowMissingVendor: false, vendorCache: null,
    allowTagDrop: false,
    // Public address the catalog prints in its copy-paste install commands.
    // A default is deliberate: a catalog whose commands point at nothing is
    // worse than no catalog, and the mirror has exactly one public home.
    baseUrl: 'https://yoyooai.com/dist',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--output') options.output = path.resolve(value());
    else if (arg === '--repo') {
      const raw = value();
      const split = raw.indexOf('=');
      if (split < 1) throw new Error(`--repo expects owner/name=path (got "${raw}")`);
      const repo = raw.slice(0, split);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) {
        throw new Error(`--repo expects owner/name (got "${repo}")`);
      }
      options.repos.push({ repo, dir: path.resolve(raw.slice(split + 1)) });
    } else if (arg === '--tags') options.tags = Number(value());
    else if (arg === '--default-branch') options.defaultBranch = value();
    else if (arg === '--production') options.mode = options.mode ? 'conflict' : 'production';
    else if (arg === '--test-only') options.mode = options.mode ? 'conflict' : 'test-only';
    else if (arg === '--skip-vendor') options.skipVendor = true;
    else if (arg === '--allow-missing-vendor') options.allowMissingVendor = true;
    else if (arg === '--allow-tag-drop') options.allowTagDrop = true;
    else if (arg === '--vendor-cache') options.vendorCache = path.resolve(value());
    else if (arg === '--base-url') options.baseUrl = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.output) throw new Error('--output is required');
  if (options.repos.length === 0) throw new Error('at least one --repo is required');
  if (!Number.isInteger(options.tags) || options.tags < 1) throw new Error('--tags must be a positive integer');
  if (!options.mode || options.mode === 'conflict') {
    throw new Error('choose exactly one build mode: --production or --test-only');
  }
  if (options.mode === 'production' && options.skipVendor) {
    throw new Error('production builds cannot skip vendor artifacts');
  }
  if (options.mode === 'production' && options.allowMissingVendor) {
    throw new Error('production builds cannot allow missing vendor artifacts');
  }
  return options;
}

function git(dir, args, { encoding = 'utf8' } = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Newest first: 1.0.0 beats 1.0.0-alpha.1 beats 0.9.9. */
function compareVersionsDesc(a, b) {
  const [aBase, aPre] = a.split(/-(.+)/);
  const [bBase, bPre] = b.split(/-(.+)/);
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

/** Tags of a repository, newest first, keeping any component prefix intact. */
/**
 * Which tags this build mirrors, and which it leaves behind.
 *
 * Retention is a real limit with a real consequence: publishing uses
 * `rsync --delete`, so a tag that falls out of this list disappears from the
 * mirror — its archive, its raw files and its pinned installer. Measured on
 * 2026-08-06 with a retention of 5: install-v0.1.0.sh and install-v0.1.1.sh were
 * already 404 while install-v0.1.2.sh answered.
 *
 * So the dropped list is returned rather than discarded, and main() prints it. A
 * cap nobody is told about reads as "everything is here" right up to the 404.
 */
function listTags(dir, limit) {
  const all = git(dir, ['tag', '--list'])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(tag => versionOf(tag) !== null);

  // Group by prefix ("", "feishu", "weixin"): each component line gets its own
  // most-recent releases, so mirroring N tags never starves a sibling channel.
  const byPrefix = new Map();
  for (const tag of all) {
    const version = versionOf(tag);
    const prefix = tag.slice(0, tag.length - version.length).replace(/[-v]+$/, '');
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(tag);
  }
  const kept = [];
  const dropped = [];
  for (const tags of byPrefix.values()) {
    tags.sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b)));
    kept.push(...tags.slice(0, limit));
    dropped.push(...tags.slice(limit));
  }
  return { kept, dropped };
}

function writeFileWithDirs(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeJson(filePath, value) {
  writeFileWithDirs(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Raw metadata files at a ref, mirroring only the names the CLI actually reads. */
function mirrorRawFiles(dir, ref, outDir, record) {
  const listing = git(dir, ['ls-tree', '-r', '--name-only', ref])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(entry => {
      const parts = entry.split('/');
      return parts.length <= RAW_MAX_DEPTH && RAW_FILE_NAMES.has(parts[parts.length - 1]);
    });

  for (const entry of listing) {
    const contents = git(dir, ['show', `${ref}:${entry}`], { encoding: 'buffer' });
    const target = path.join(outDir, 'raw', ref, entry);
    writeFileWithDirs(target, contents);
    record(target);
  }
  return listing.length;
}

function buildRepo({ repo, dir }, options, record) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    throw new Error(`${dir} is not a git checkout (needed for ${repo})`);
  }
  const outDir = path.join(options.output, repo);
  const { kept: tags, dropped } = listTags(dir, options.tags);
  if (tags.length === 0) throw new Error(`${repo} has no version tags to mirror`);

  const summary = {
    repo,
    tags: [],
    rawFiles: 0,
    packages: [],
    tagRetention: options.tags,
    // Stated so a reader — or a script — can tell what is reachable without
    // discovering it as a 404.
    droppedTags: dropped,
  };

  // tags.json — GitHub's /tags shape; only `name` is consumed, `commit.sha`
  // is kept so a human can tell what a mirrored tag actually points at.
  const tagEntries = tags.map(tag => ({
    name: tag,
    commit: { sha: git(dir, ['rev-parse', `${tag}^{commit}`]).trim() },
  }));
  summary.releases = tagEntries;
  const releaseDates = tagEntries.map(({ commit }) => (
    git(dir, ['show', '-s', '--format=%cI', commit.sha]).trim()
  ));
  const tagsFile = path.join(outDir, 'tags.json');
  writeJson(tagsFile, tagEntries);
  record(tagsFile);

  // releases/latest.json — what the installer resolves when no --branch is given.
  const newest = [...tags].sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b)))[0];
  const latestFile = path.join(outDir, 'releases', 'latest.json');
  writeJson(latestFile, {
    tag_name: newest,
    name: newest,
    prerelease: /-(?:alpha|beta|rc)/i.test(newest),
    commit: git(dir, ['rev-parse', `${newest}^{commit}`]).trim(),
  });
  record(latestFile);

  for (const tag of tags) {
    // Source archive, same shape as a GitHub archive: one top-level directory,
    // so the client's `tar --strip-components=1` keeps working unchanged.
    const archive = path.join(outDir, 'tarball', 'tags', `${tag}.tar.gz`);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const prefix = `${repo.split('/')[1]}-${versionOf(tag)}/`;
    execFileSync('git', ['-C', dir, 'archive', `--format=tar.gz`, `--prefix=${prefix}`, '-o', archive, tag], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    record(archive);
    summary.rawFiles += mirrorRawFiles(dir, tag, outDir, record);
    summary.tags.push(tag);
  }

  // The default branch is mirrored too: component upgrade reads SKILL.md from
  // it and self-upgrade reads package.json from it. Named explicitly rather
  // than taken from HEAD — a release must never mirror whatever branch the
  // build machine happened to have checked out.
  const defaultBranch = options.defaultBranch;
  try {
    git(dir, ['rev-parse', '--verify', `${defaultBranch}^{commit}`]);
  } catch {
    throw new Error(`${repo} has no branch "${defaultBranch}" (pass --default-branch)`);
  }
  summary.rawFiles += mirrorRawFiles(dir, defaultBranch, outDir, record);
  summary.defaultBranch = defaultBranch;
  summary.defaultBranchCommit = git(dir, ['rev-parse', `${defaultBranch}^{commit}`]).trim();
  summary.sourceTimestamp = [
    ...releaseDates,
    git(dir, ['show', '-s', '--format=%cI', summary.defaultBranchCommit]).trim(),
  ].sort().at(-1);

  return { summary, outDir, tags, newest };
}

/**
 * Publish the installers: `install.sh` for the newest release, plus a pinned
 * `install-<tag>.sh` for every tag the mirror carries.
 *
 * Each pinned copy comes from its own tag, which is the entire point — a pinned
 * address that serves a different version's installer is worse than no pinned
 * address at all.
 *
 * Only the newest tag used to get one, so a pinned URL stopped working at the
 * very next release: measured 2026-08-06, install-v0.1.0.sh and
 * install-v0.1.1.sh were 404 while install-v0.1.2.sh answered. Any pinned
 * address written into a document or a script rotted within one release.
 *
 * A tag from before install.sh moved to its current path simply has no installer
 * to publish; that is reported and skipped rather than failing the build.
 */
function publishInstallers({ repo, dir }, tags, newest, options, record) {
  const readInstaller = (tag) => {
    try {
      return git(dir, ['show', `${tag}:scripts/install.sh`], { encoding: 'buffer' });
    } catch {
      return null;
    }
  };

  const newestContents = readInstaller(newest);
  if (!newestContents) {
    throw new Error(`${repo}@${newest} has no scripts/install.sh to publish as install.sh`);
  }

  const write = (name, contents) => {
    const target = path.join(options.output, name);
    writeFileWithDirs(target, contents);
    fs.chmodSync(target, 0o644);
    record(target);
  };

  write('install.sh', newestContents);

  const published = [];
  const missing = [];
  for (const tag of tags) {
    const contents = tag === newest ? newestContents : readInstaller(tag);
    if (!contents) {
      missing.push(tag);
      continue;
    }
    write(`install-${tag}.sh`, contents);
    published.push(`install-${tag}.sh`);
  }

  for (const tag of missing) {
    console.error(`[dist] ${repo}@${tag}: no scripts/install.sh at that tag — no pinned installer published`);
  }

  return { latest: `install-${newest}.sh`, pinned: published };
}

/**
 * Pack the npm artifact for a tag from a throwaway worktree, so the package is
 * built from exactly the released tree and never from local edits.
 *
 * Called for every mirrored tag. The installer prefers this package and only
 * falls back to git, which needs GitHub — so a version without one cannot be
 * installed on the machines the mirror exists for.
 *
 * @returns {string|null} the package file name, or null when the tag has nothing
 *   to pack (an old tag from before the package existed)
 */
function packRelease({ repo, dir }, tag, outDir, record) {
  const worktree = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'yos-dist-pack-'));
  const stage = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'yos-dist-out-'));
  try {
    git(dir, ['worktree', 'add', '--detach', worktree, tag]);
    if (!fs.existsSync(path.join(worktree, 'package.json'))) {
      // A tag from before the package existed has nothing to pack. Say so and
      // carry on: one unpackable old tag must not stop the release.
      console.error(`[dist] ${repo}@${tag}: no package.json at that tag — no npm package mirrored`);
      return null;
    }
    const output = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', stage], {
      cwd: worktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fileName = output.trim().split('\n').at(-1);
    const target = path.join(outDir, 'package', fileName);
    writeFileWithDirs(target, fs.readFileSync(path.join(stage, fileName)));
    record(target);
    return fileName;
  } finally {
    try { git(dir, ['worktree', 'remove', '--force', worktree]); } catch { /* best effort */ }
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function download(url, target, cacheDir) {
  const cached = cacheDir ? path.join(cacheDir, crypto.createHash('sha256').update(url).digest('hex').slice(0, 16) + '-' + path.basename(url)) : null;
  if (cached && fs.existsSync(cached)) {
    writeFileWithDirs(target, fs.readFileSync(cached));
    return true;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    execFileSync('curl', ['-fsSL', '--max-time', '300', '-o', target, url], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return false;
  }
  if (cached) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(target, cached);
  }
  return true;
}

function expand(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

/**
 * Re-host third-party artifacts. Runs where GitHub *is* reachable (our build
 * machine) precisely so that the install machine never needs it.
 */
function buildVendor(options, record) {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'dist-vendor.json'), 'utf8'));
  const vendorDir = path.join(options.output, 'vendor');
  const summary = { caddy: [], prebuilds: [], sources: [], missing: [] };
  const recordSource = (target, url) => {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('vendor sources must be uncredentialed HTTPS URLs without query strings or fragments');
    }
    summary.sources.push({
      path: path.relative(options.output, target).split(path.sep).join('/'),
      url,
      bytes: fs.statSync(target).size,
      sha256: sha256(target),
    });
  };

  const caddy = spec.caddy;
  writeJson(path.join(vendorDir, 'caddy', 'latest.json'), { tag_name: `v${caddy.version}` });
  record(path.join(vendorDir, 'caddy', 'latest.json'));
  for (const fileTemplate of caddy.files) {
    const file = expand(fileTemplate, { version: caddy.version });
    const url = expand(caddy.source, { version: caddy.version, file });
    const target = path.join(vendorDir, 'caddy', `v${caddy.version}`, file);
    if (download(url, target, options.vendorCache)) {
      record(target);
      summary.caddy.push(file);
      recordSource(target, url);
    } else {
      summary.missing.push(url);
    }
  }

  for (const prebuild of spec.prebuilds) {
    for (const abi of prebuild.abis) {
      for (const target of prebuild.targets) {
        const file = expand(prebuild.file, { version: prebuild.version, abi, ...target });
        const url = expand(prebuild.source, { version: prebuild.version, file });
        // prebuild-install expands <host>/v<version>/<file>, so the version
        // directory here is part of the contract, not decoration.
        const outFile = path.join(vendorDir, prebuild.package, `v${prebuild.version}`, file);
        if (download(url, outFile, options.vendorCache)) {
          record(outFile);
          summary.prebuilds.push(file);
          recordSource(outFile, url);
        } else {
          summary.missing.push(url);
        }
      }
    }
  }
  return summary;
}

/**
 * The registry the CLI resolves `yos add <name>` against, read from the released
 * core rather than from this build machine's working tree — the catalog must
 * describe what customers can actually install, not what is checked out here.
 */
function releasedRegistry(options) {
  const core = options.repos.find(entry => entry.repo.endsWith('/yos-core'));
  if (!core) return { components: {} };
  const { kept } = listTags(core.dir, options.tags);
  const newest = [...kept].sort((a, b) => compareVersionsDesc(versionOf(a), versionOf(b)))[0];
  // The shelf build locks the default-branch commit into buildId and only emits
  // providers backed by mirrored release tags. Reading that locked registry
  // first lets a newly tagged component become discoverable without waiting for
  // another Core release, while untagged candidates still cannot appear.
  for (const ref of [options.defaultBranch, newest]) {
    if (!ref) continue;
    try {
      return JSON.parse(git(core.dir, ['show', `${ref}:registry.json`]));
    } catch {
      // Try the next ref. A core without a registry is possible (an old tag),
      // and the catalog says "unregistered" rather than inventing names.
    }
  }
  return { components: {} };
}

/**
 * Write the human-readable catalog, and refuse to publish one that promises a
 * file that is not on the mirror.
 *
 * The existence check reads the OUTPUT DIRECTORY, deliberately not the index the
 * rows came from: index.json is what the build believes it wrote, and the point
 * of the gate is to catch the case where that belief is wrong. Checking a claim
 * against its own source is how you get a green light that means nothing.
 */
function publishCatalog(index, options, record) {
  const registry = releasedRegistry(options);
  const rows = catalogRows(index, registry);
  const promised = catalogPaths(rows);
  const onMirror = p => fs.existsSync(path.join(options.output, p));
  // Canary: prove the oracle actually answers "no" to something before trusting
  // it to answer "yes". Without this, replacing the check with `() => true`
  // passes every test — the gate would report success without looking.
  if (onMirror('__catalog-gate-canary-never-published__')) {
    throw new Error('the version catalog gate is not checking anything — its existence oracle answers yes to everything');
  }
  const absent = missingCatalogAddresses(rows, onMirror);
  if (absent.length > 0) {
    throw new Error(
      `the version catalog names ${absent.length} address(es) that are not on the mirror: ${absent.join(', ')}`
    );
  }

  const builtAt = index.repos.map((repo) => repo.sourceTimestamp).filter(Boolean).sort().at(-1);
  const renderOptions = { baseUrl: options.baseUrl, registry, builtAt };
  const markdownPath = path.join(options.output, 'VERSIONS.md');
  writeFileWithDirs(markdownPath, renderCatalogMarkdown(index, renderOptions));
  record(markdownPath);
  const htmlPath = path.join(options.output, 'index.html');
  writeFileWithDirs(htmlPath, renderCatalogHtml(index, renderOptions));
  record(htmlPath);

  const named = rows.rows.map(row => `${row.id} ${row.latestVersion || '?'}`).join(', ');
  console.log(`[dist] catalog: ${rows.rows.length} component(s) — ${named}`);
  console.log(`[dist] catalog: ${promised.length} artifact address(es) verified present on the mirror`);
}

function buildIdentity(repos) {
  const source = repos
    .map((repo) => ({
      repo: repo.repo,
      defaultBranch: repo.defaultBranch,
      defaultBranchCommit: repo.defaultBranchCommit,
      releases: [...(repo.releases ?? [])]
        .map(({ name, commit }) => ({ name, commit: commit.sha }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo, 'en'));
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.allowTagDrop) {
    const evictions = options.repos.flatMap(({ repo, dir }) => (
      listTags(dir, options.tags).dropped.map((tag) => `${repo}@${tag}`)
    ));
    if (evictions.length > 0) {
      throw new Error(
        `retention ${options.tags} would drop published tag(s): ${evictions.join(', ')}; `
        + 'increase --tags or explicitly pass --allow-tag-drop'
      );
    }
  }

  fs.mkdirSync(options.output, { recursive: true });

  const files = [];
  const record = filePath => {
    files.push({
      path: path.relative(options.output, filePath).split(path.sep).join('/'),
      bytes: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    });
  };

  const repos = [];
  for (const entry of options.repos) {
    const built = buildRepo(entry, options, record);
    // Only the core package is installed by npm; components are installed from
    // their source subdirectory, so packing them would be dead weight.
    if (entry.repo.endsWith('/yos-core')) {
      // A package per mirrored tag, not just the newest. The installer prefers
      // the npm package and only falls back to git — which needs GitHub — so
      // mirroring one package meant only the newest version was installable
      // without GitHub. Measured 2026-08-06 with GitHub blackholed:
      // `install.sh --branch v0.1.2` printed "No release package for v0.1.2 on
      // the distribution mirror — installing from git" and died on ssh to
      // github.com. Pinning an older version was impossible for exactly the
      // machines the mirror exists for.
      for (const tag of built.summary.tags) {
        const packed = packRelease(entry, tag, built.outDir, record);
        if (packed) built.summary.packages.push(packed);
      }
      const installers = publishInstallers(entry, built.summary.tags, built.newest, options, record);
      built.summary.installer = installers.latest;
      built.summary.pinnedInstallers = installers.pinned;
    }
    repos.push(built.summary);
    console.log(`[dist] ${entry.repo}: ${built.summary.tags.length} tag(s), newest ${built.newest}`);
    // Say what fell outside the window. Silence here reads as "everything is
    // mirrored", and the first sign otherwise is a 404 on somebody's machine.
    if (built.summary.droppedTags.length > 0) {
      console.log(
        `[dist] ${entry.repo}: NOT mirrored (retention ${options.tags}): `
        + built.summary.droppedTags.join(', ')
      );
    }
  }

  let vendor = null;
  if (!options.skipVendor) {
    vendor = buildVendor(options, record);
    console.log(`[dist] vendor: ${vendor.caddy.length} caddy, ${vendor.prebuilds.length} prebuild(s)`);
    for (const missing of vendor.missing) console.error(`[dist] not mirrored: ${missing}`);
    // A half-populated vendor tree is worse than none: prebuild-install accepts
    // a single host, so one missing file sends that install to node-gyp, which
    // needs a compiler and Python and fails on a stock server.
    if (vendor.missing.length > 0 && !options.allowMissingVendor) {
      throw new Error(
        `${vendor.missing.length} vendor artifact(s) could not be mirrored — fix the source or pass --allow-missing-vendor`
      );
    }
  } else {
    console.log('[dist] vendor: skipped');
  }

  const index = {
    schemaVersion: 1,
    generator: 'scripts/build-dist.mjs',
    publicationMode: options.mode,
    buildId: buildIdentity(repos),
    repos,
    vendor,
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
  };

  const capabilityPath = path.join(options.output, 'capabilities.json');
  writeJson(capabilityPath, deriveCapabilityIndex({
    index,
    registry: releasedRegistry(options),
    outputRoot: options.output,
  }));
  record(capabilityPath);

  publishCatalog(index, options, record);

  const indexPath = path.join(options.output, 'index.json');
  // Re-sorted because the catalog files were recorded after the first sort.
  index.files = files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  writeJson(indexPath, index);
  console.log(`[dist] ${files.length} file(s) → ${options.output}`);
  console.log(`[dist] index: ${indexPath}`);
}

try {
  main();
} catch (error) {
  console.error(`Distribution build failed: ${error.message}`);
  process.exit(1);
}
