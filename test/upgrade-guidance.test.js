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
const HOOK_GUIDANCE = 'Post-upgrade hooks never report `failed`. Treat a `skipped` result with `no post-upgrade hook` as normal. Investigate every other `skipped` result, including `hook had issues`, `hook not found`, and `hook path escapes skill directory`, because the declared config migration did not complete.';

function makeSkillDir(frontmatter) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-upgrade-guidance-'));
  const skillDir = path.join(tempRoot, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: demo\n${frontmatter}---\n`,
  );
  return { tempRoot, skillDir };
}

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
    expect(guide.split(HOOK_GUIDANCE)).toHaveLength(4);
  });

  test('documents every skipped hook result returned by the product contract', () => {
    const fixtures = [
      makeSkillDir(''),
      makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n'),
      makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: ../outside.js\n'),
      makeSkillDir('lifecycle:\n  hooks:\n    post-upgrade: hooks/post-upgrade.js\n'),
    ];
    const failingHookPath = path.join(fixtures[3].skillDir, 'hooks', 'post-upgrade.js');
    fs.mkdirSync(path.dirname(failingHookPath), { recursive: true });
    fs.writeFileSync(failingHookPath, 'process.exit(1);\n');

    try {
      const results = [
        step7_runPostUpgradeHook({ component: 'demo', skillDir: fixtures[0].skillDir }),
        step7_runPostUpgradeHook({ component: 'demo', skillDir: fixtures[1].skillDir }),
        step7_runPostUpgradeHook({ component: 'demo', skillDir: fixtures[2].skillDir }),
        step7_runPostUpgradeHook(
          { component: 'demo', skillDir: fixtures[3].skillDir, jsonOutput: true },
          { spawnSync: () => ({ status: 1, stdout: '', stderr: 'migration failed\n' }) },
        ),
      ];
      const messages = results.map((result) => result.message);
      const guide = fs.readFileSync(UPGRADE_GUIDE, 'utf8');

      expect(results.every((result) => result.status === 'skipped')).toBe(true);
      expect(messages).toEqual([
        'no post-upgrade hook',
        'hook not found: hooks/post-upgrade.js',
        'hook path escapes skill directory: ../outside.js',
        expect.stringMatching(/^hook had issues \(non-fatal\):/),
      ]);
      expect(guide.split(HOOK_GUIDANCE)).toHaveLength(4);
      expect(HOOK_GUIDANCE).toContain('no post-upgrade hook` as normal');
      for (const prefix of ['hook had issues', 'hook not found', 'hook path escapes skill directory']) {
        expect(HOOK_GUIDANCE).toContain(`\`${prefix}\``);
      }
    } finally {
      for (const fixture of fixtures) {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
      }
    }
  });
});
