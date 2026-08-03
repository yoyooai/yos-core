import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { step7_runPostUpgradeHook } from '../cli/lib/upgrade.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADE_GUIDE = path.join(
  ROOT,
  'skills/component-management/references/upgrade.md',
);

describe('component upgrade guidance', () => {
  test('treats lifecycle hooks and service restart as CLI-owned steps', () => {
    const guide = fs.readFileSync(UPGRADE_GUIDE, 'utf8');

    expect(guide).toMatch(/The CLI executes the post-upgrade hook/);
    expect(guide).toMatch(/read the `post_upgrade_hook` step/);
    expect(guide).toMatch(/read the `start_service` step/);
    expect(guide).not.toMatch(/Execute Pre-Upgrade Hook/);
    expect(guide).not.toMatch(/Execute Post-Upgrade Hook/);
    expect(guide).not.toMatch(/Restart the service: `pm2 restart/);
    expect(guide).not.toMatch(/Run post-upgrade hook if/);
    expect(guide).not.toMatch(/If it reports failure, investigate/);
    expect(guide.match(/hook had issues/g) ?? []).toHaveLength(3);
  });

  test('documents the actual non-fatal hook failure result', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-upgrade-guidance-'));
    const skillDir = path.join(tempRoot, 'demo');
    const hookPath = path.join(skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo\nlifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n---\n',
    );
    fs.writeFileSync(hookPath, 'process.exit(1);\n');

    try {
      const result = step7_runPostUpgradeHook(
        { component: 'demo', skillDir, jsonOutput: true },
        { spawnSync: () => ({ status: 1, stdout: '', stderr: 'migration failed\n' }) },
      );
      const guide = fs.readFileSync(UPGRADE_GUIDE, 'utf8');

      expect(result.status).toBe('skipped');
      expect(result.message).toMatch(/hook had issues/);
      expect(guide).toMatch(/status is `skipped` and its message contains `hook had issues`/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
