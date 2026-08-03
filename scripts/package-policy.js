import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function usesBlockedLocalPath(file) {
  const normalized = file.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const basename = segments.at(-1) || '';

  return normalized.startsWith('docs/')
    || segments.includes('node_modules')
    || normalized === '.yos'
    || normalized.startsWith('.yos/')
    || normalized === '.claude/worktrees'
    || normalized.startsWith('.claude/worktrees/')
    || basename === '.env'
    || basename.endsWith('.local.env')
    || basename.endsWith('.local.json');
}

export function findBlockedPackageEntries(files, trackedFiles) {
  return files.filter((file) => usesBlockedLocalPath(file) || !trackedFiles.has(file));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function packageContentDigest(root, files) {
  const rows = [...files]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((file) => `${file}\t${sha256(fs.readFileSync(path.join(root, file)))}\n`)
    .join('');
  return sha256(rows);
}
