/**
 * Download utilities for component installation and upgrades.
 * Supports GitHub archive tarballs and local paths. No git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { getGitHubToken, sanitizeError, withRateLimitRetrySync, buildTagName } from './github.js';
import { distMirrorUrl, isDistOnly, noteMirrorFallback } from './dist-origin.js';
import { copyTree } from './fs-utils.js';
import { parseSkillMd } from './skill.js';

function getWritableTmpBase() {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, 'yos-download-probe-'));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

function createDownloadTmpDir() {
  const base = getWritableTmpBase();
  return fs.mkdtempSync(path.join(base, 'yos-download-'));
}

/**
 * Download a tarball from a URL using curl.
 * Origin order: our distribution mirror, then the public GitHub endpoint
 * (works for public repos without auth), then the authenticated GitHub API if
 * a token is available — which avoids 403 errors when a token lacks org access
 * for public repos. Retries with backoff on GitHub rate limiting.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} ref - Git ref (tag name or branch name)
 * @param {'tag'|'branch'} refType - Whether the ref is a tag or branch
 * @param {string} tarballPath - Destination file path for the tarball
 */
function curlDownload(repo, ref, refType, tarballPath) {
  withRateLimitRetrySync(
    () => curlDownloadOnce(repo, ref, refType, tarballPath),
    `${repo}@${ref}`
  );
}

function curlDownloadOnce(repo, ref, refType, tarballPath) {
  // 1. Our own distribution mirror — the only origin a customer machine is
  //    guaranteed to reach (see cli/lib/dist-origin.js). Anonymous static file.
  const mirrorUrl = distMirrorUrl('tarball', { repo, ref, refType });
  if (mirrorUrl) {
    try {
      execFileSync('curl', ['-fsSL', '-o', tarballPath, mirrorUrl], {
        timeout: 60000,
        stdio: 'pipe',
      });
      return;
    } catch (err) {
      if (isDistOnly()) {
        const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0];
        throw new Error(
          `Distribution mirror download failed and YOS_DIST_ONLY is set: ${mirrorUrl} — ${detail}`
        );
      }
      noteMirrorFallback('tarball', `${repo}@${ref}`, err);
    }
  }

  // 2. Try public GitHub endpoint (no auth needed for public repos)
  const publicUrl = refType === 'tag'
    ? `https://github.com/${repo}/archive/refs/tags/${ref}.tar.gz`
    : `https://github.com/${repo}/archive/refs/heads/${ref}.tar.gz`;
  let publicError;
  try {
    execFileSync('curl', ['-fsSL', '-o', tarballPath, publicUrl], {
      timeout: 60000,
      stdio: 'pipe',
    });
    return;
  } catch (err) {
    // Public download failed — repo may be private, try with auth
    publicError = err;
  }

  // 3. Fall back to authenticated GitHub API (for private repos)
  const token = getGitHubToken();
  if (!token) {
    // No token available — surface the original public error; retry semantics
    // belong exclusively to the outer withRateLimitRetrySync loop (#705)
    throw publicError;
  }

  const apiUrl = `https://api.github.com/repos/${repo}/tarball/${ref}`;
  execFileSync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, '-o', tarballPath, apiUrl], {
    timeout: 60000,
    stdio: 'pipe',
  });
}

/**
 * Download a GitHub archive tarball and extract it.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} version - Version tag (e.g. "1.0.0", will be prefixed with "v")
 * @param {string} destDir - Destination directory to extract into
 * @param {{ subdir?: string | null, tagPrefix?: string | null }} [options]
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
 */
export function downloadArchive(repo, version, destDir, { subdir = null, tagPrefix = null } = {}) {
  const tag = buildTagName(version, tagPrefix);
  let tmpDir;
  try {
    tmpDir = createDownloadTmpDir();
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to prepare temp dir: ${sanitizeError(err.message)}`,
    };
  }
  const tarballPath = path.join(tmpDir, 'archive.tar.gz');

  try {
    fs.mkdirSync(destDir, { recursive: true });
    curlDownload(repo, tag, 'tag', tarballPath);
    const result = extractTarball(tarballPath, destDir, { subdir });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      success: false,
      extractedDir: null,
      error: `Failed to download ${repo}@${tag}: ${sanitizeError(err.message)}`,
    };
  }
}

/**
 * Copy a component from a local path.
 *
 * @param {string} localPath - Absolute or relative path to component source
 * @param {string} destDir - Destination directory
 * @returns {{ success: boolean, error?: string }}
 */
export function copyLocal(localPath, destDir) {
  const srcPath = resolveLocalPath(localPath);

  if (!fs.existsSync(srcPath)) {
    return { success: false, error: `Source path not found: ${srcPath}` };
  }

  const stat = fs.statSync(srcPath);
  if (!stat.isDirectory()) {
    return { success: false, error: `Source path is not a directory: ${srcPath}` };
  }

  try {
    copyTree(srcPath, destDir, { excludes: ['.git', 'node_modules', '.yos', '.backup'] });
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to copy from ${srcPath}: ${err.message}` };
  }
}

/**
 * Inspect a local source without coupling target resolution to the add command.
 * Local tarballs are unpacked to a temporary directory for metadata discovery.
 *
 * @param {string} localPath
 * @returns {{ name: string, version: string | null, source: object }}
 */
export function inspectLocalSource(localPath) {
  const srcPath = resolveLocalPath(localPath);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Local source not found: ${srcPath}`);
  }

  const stat = fs.statSync(srcPath);
  if (stat.isDirectory()) {
    const metadata = readLocalMetadata(srcPath, path.basename(srcPath));
    return { ...metadata, source: { type: 'local-dir', path: srcPath } };
  }

  if (!stat.isFile() || !/\.(?:tar\.gz|tgz)$/i.test(srcPath)) {
    throw new Error(`Local source must be a directory or .tar.gz archive: ${srcPath}`);
  }

  const tmpDir = createDownloadTmpDir();
  try {
    const result = extractLocalTarball(srcPath, tmpDir);
    if (!result.success) throw new Error(result.error);
    const fallback = path.basename(srcPath).replace(/\.(?:tar\.gz|tgz)$/i, '');
    const metadata = readLocalMetadata(tmpDir, fallback);
    return { ...metadata, source: { type: 'local-tarball', path: srcPath } };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Acquire a normalized component source into its installation directory.
 * Resolver registration keeps source-specific behavior at the acquire boundary
 * and leaves manifest, registration, hooks, PM2, and Caddy flows source-agnostic.
 *
 * @param {object} source
 * @param {string} destDir
 * @returns {{ success: boolean, extractedDir?: string, error?: string }}
 */
export function acquireSource(source, destDir) {
  const resolver = SOURCE_RESOLVERS.get(source?.type);
  if (!resolver) {
    return { success: false, error: `Unsupported component source: ${source?.type || 'unknown'}` };
  }
  try {
    return resolver.acquire(source, destDir);
  } catch (err) {
    return { success: false, error: sanitizeError(err.message) };
  }
}

/**
 * Register an additional source resolver. This is the upgrade/mirror extension
 * seam; v1 ships only GitHub releases/branches and local filesystem sources.
 */
export function registerSourceResolver(type, resolver) {
  if (!type || typeof resolver?.acquire !== 'function') {
    throw new TypeError('A source resolver requires a type and acquire(source, destDir)');
  }
  SOURCE_RESOLVERS.set(type, resolver);
}

const SOURCE_RESOLVERS = new Map();

registerSourceResolver('github-release', {
  acquire(source, destDir) {
    if (source.refType === 'branch') {
      return downloadBranch(source.repo, source.ref, destDir, { subdir: source.path || null });
    }
    return downloadArchive(source.repo, source.ref, destDir, {
      subdir: source.path || null,
      tagPrefix: source.tagPrefix || null,
    });
  },
});

registerSourceResolver('local-dir', {
  acquire(source, destDir) {
    return copyLocal(source.path, destDir);
  },
});

registerSourceResolver('local-tarball', {
  acquire(source, destDir) {
    return extractLocalTarball(source.path, destDir);
  },
});

/**
 * Download a GitHub branch archive and extract it.
 * Used for versionless installs (no tagged release).
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} branch - Branch name (e.g. "main")
 * @param {string} destDir - Destination directory to extract into
 * @param {{ subdir?: string | null }} [options]
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
 */
export function downloadBranch(repo, branch, destDir, { subdir = null } = {}) {
  let tmpDir;
  try {
    tmpDir = createDownloadTmpDir();
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to prepare temp dir: ${sanitizeError(err.message)}`,
    };
  }
  const tarballPath = path.join(tmpDir, 'archive.tar.gz');

  try {
    fs.mkdirSync(destDir, { recursive: true });
    curlDownload(repo, branch, 'branch', tarballPath);
    const result = extractTarball(tarballPath, destDir, { subdir });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return result;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      success: false,
      extractedDir: null,
      error: `Failed to download ${repo}@${branch}: ${sanitizeError(err.message)}`,
    };
  }
}

/**
 * Extract a tarball to a destination directory.
 * GitHub archive tarballs contain a top-level directory (e.g. "repo-name-v1.0.0/"),
 * so we strip the first path component.
 *
 * When `subdir` is set the archive holds several components and only that
 * subtree is the component; it is staged in a temp directory and its contents
 * become the installation directory, so nothing downstream has to know that the
 * component shared a repository with its siblings.
 *
 * @param {string} tarballPath - Path to the .tar.gz file
 * @param {string} destDir - Directory to extract into
 * @param {{ subdir?: string | null }} [options]
 * @returns {{ success: boolean, extractedDir: string, error?: string }}
 */
export function extractTarball(tarballPath, destDir, { subdir = null } = {}) {
  try {
    fs.mkdirSync(destDir, { recursive: true });

    if (!subdir) {
      // Extract with strip-components to remove top-level directory
      execFileSync('tar', ['xzf', tarballPath, '-C', destDir, '--strip-components=1'], {
        timeout: 30000,
        stdio: 'pipe',
      });

      return { success: true, extractedDir: destDir };
    }

    const stageDir = fs.mkdtempSync(path.join(getWritableTmpBase(), 'yos-extract-'));
    try {
      execFileSync('tar', ['xzf', tarballPath, '-C', stageDir, '--strip-components=1'], {
        timeout: 30000,
        stdio: 'pipe',
      });

      const componentDir = resolveArchiveSubdir(stageDir, subdir);
      if (!fs.existsSync(componentDir)) {
        return {
          success: false,
          extractedDir: null,
          error: `Component path not found in archive: ${subdir}`,
        };
      }
      if (!fs.statSync(componentDir).isDirectory()) {
        return {
          success: false,
          extractedDir: null,
          error: `Component path is not a directory: ${subdir}`,
        };
      }

      copyTree(componentDir, destDir, { excludes: ['.git', 'node_modules', '.yos', '.backup'] });
      return { success: true, extractedDir: destDir };
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: describeExtractFailure(err, tarballPath),
    };
  }
}

/**
 * Say what a failed extraction means, instead of forwarding tar's stderr.
 *
 * The raw form of this was what a customer saw when a download was cut short:
 * "Command failed: tar xzf /tmp/... / gzip: stdin: unexpected end of file /
 * tar: Unexpected EOF in archive". Every word of that is about tar, and none of
 * it says the download was incomplete or that retrying is the fix.
 */
export function describeExtractFailure(err, tarballPath) {
  const raw = String(err?.message || err || '');
  const stderr = String(err?.stderr || '');
  const combined = `${raw}\n${stderr}`;
  const size = (() => {
    try { return fs.statSync(tarballPath).size; } catch { return null; }
  })();

  const truncated = /unexpected end of file|Unexpected EOF|unexpected end of input|not in gzip format|invalid compressed data/i.test(combined);
  if (truncated) {
    const sizeNote = size === null ? '' : ` (got ${size} bytes)`;
    return [
      `The downloaded archive is incomplete or corrupt${sizeNote}, so it could not be unpacked.`,
      'Nothing has been changed. This is almost always a download cut short —',
      'run the same command again; if it keeps happening, the network or the',
      'mirror is truncating the file.',
    ].join('\n');
  }

  if (/ETIMEDOUT|timed out|timeout/i.test(combined)) {
    return [
      'Unpacking the archive took too long and was stopped.',
      'Nothing has been changed. Try again on a less loaded machine.',
    ].join('\n');
  }

  if (/ENOSPC|no space left/i.test(combined)) {
    return 'Ran out of disk space while unpacking the archive. Nothing has been changed. Free some space and try again.';
  }

  return `Failed to extract tarball: ${raw}`;
}

/**
 * Resolve a component subdirectory inside an extracted archive.
 * Registry entries are data, so the path is confined to the archive root:
 * an absolute or `..` path must never let an install write outside it.
 */
function resolveArchiveSubdir(rootDir, subdir) {
  const normalized = String(subdir).replace(/^[/\\]+/, '');
  if (!normalized) throw new Error('Component path is empty');
  const root = path.resolve(rootDir);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Component path escapes the archive: ${subdir}`);
  }
  if (target === root) throw new Error(`Component path must name a subdirectory: ${subdir}`);
  return target;
}

export function resolveLocalPath(localPath) {
  if (localPath === '~') return fs.realpathSync(os.homedir());
  const expanded = localPath.startsWith('~/')
    ? path.join(os.homedir(), localPath.slice(2))
    : localPath;
  return path.resolve(expanded);
}

function readLocalMetadata(componentDir, fallbackName) {
  const frontmatter = parseSkillMd(componentDir)?.frontmatter || {};
  const name = normalizeLocalComponentName(frontmatter.name || fallbackName);
  let version = frontmatter.version == null ? null : String(frontmatter.version).trim();
  if (!version) {
    try {
      version = fs.readFileSync(path.join(componentDir, 'VERSION'), 'utf8').trim() || null;
    } catch {
      version = null;
    }
  }
  if (!version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(componentDir, 'package.json'), 'utf8'));
      version = pkg.version == null ? null : String(pkg.version).trim() || null;
    } catch {
      version = null;
    }
  }
  return { name, version };
}

function normalizeLocalComponentName(value) {
  const name = String(value).trim().replace(/^yos-/, '');
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid local component name: ${value}`);
  }
  return name;
}

function extractLocalTarball(tarballPath, destDir) {
  try {
    const srcPath = resolveLocalPath(tarballPath);
    if (!fs.existsSync(srcPath)) {
      return { success: false, extractedDir: null, error: `Local source not found: ${srcPath}` };
    }

    const listing = execFileSync('tar', ['tzf', srcPath], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = listing
      .split('\n')
      .map(entry => entry.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean);
    if (entries.length === 0) {
      return { success: false, extractedDir: null, error: 'Local tarball is empty' };
    }
    if (entries.some(isUnsafeArchivePath)) {
      return { success: false, extractedDir: null, error: 'Local tarball contains an unsafe path' };
    }

    const verboseListing = execFileSync('tar', ['tvzf', srcPath], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const linkEntry = verboseListing
      .split('\n')
      .find(line => line.startsWith('l') || line.startsWith('h'));
    if (linkEntry) {
      return {
        success: false,
        extractedDir: null,
        error: 'Local tarball contains a symbolic or hard link; links are not allowed',
      };
    }

    const firstParts = new Set(entries.map(entry => entry.split('/')[0]));
    const hasSingleWrapper = firstParts.size === 1 && entries.some(entry => entry.includes('/'));
    fs.mkdirSync(destDir, { recursive: true });
    const args = ['xzf', srcPath, '-C', destDir];
    if (hasSingleWrapper) args.push('--strip-components=1');
    execFileSync('tar', args, { timeout: 30000, stdio: 'pipe' });
    return { success: true, extractedDir: destDir };
  } catch (err) {
    return {
      success: false,
      extractedDir: null,
      error: `Failed to extract local tarball: ${sanitizeError(err.message)}`,
    };
  }
}

function isUnsafeArchivePath(entry) {
  if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) return true;
  return entry.split(/[\\/]+/).some(part => part === '..');
}
