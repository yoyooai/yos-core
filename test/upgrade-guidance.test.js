import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  });
});
