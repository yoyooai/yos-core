import fs from 'node:fs';
import path from 'node:path';

import { makeTempDir } from './helpers/temp-dir.js';

import {
  findBlockedPackageEntries,
  packageContentDigest,
} from '../scripts/package-policy.js';

describe('release package policy', () => {
  test('rejects internal, generated, local, and untracked files', () => {
    const tracked = new Set(['package.json', 'templates/.env.example']);
    const entries = [
      'package.json',
      'templates/.env.example',
      'docs/internal.md',
      'skills/demo/node_modules/pkg/index.js',
      'test/integration/runtime/acceptance-probe.local.env',
      'test/integration/runtime/acceptance-probe.local.json',
      '.yos/runtime-env.manifest',
      '.claude/worktrees/probe/file.txt',
      'unexpected-local-file.txt',
    ];

    expect(findBlockedPackageEntries(entries, tracked)).toEqual([
      'docs/internal.md',
      'skills/demo/node_modules/pkg/index.js',
      'test/integration/runtime/acceptance-probe.local.env',
      'test/integration/runtime/acceptance-probe.local.json',
      '.yos/runtime-env.manifest',
      '.claude/worktrees/probe/file.txt',
      'unexpected-local-file.txt',
    ]);
  });

  test('content digest is order-independent and changes with file bytes', () => {
    const root = makeTempDir('yos-package-policy-');
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(root, 'b.txt'), 'beta');

    try {
      const first = packageContentDigest(root, ['a.txt', 'b.txt']);
      const reordered = packageContentDigest(root, ['b.txt', 'a.txt']);
      expect(reordered).toBe(first);

      fs.writeFileSync(path.join(root, 'b.txt'), 'changed');
      expect(packageContentDigest(root, ['a.txt', 'b.txt'])).not.toBe(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
