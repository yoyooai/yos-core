import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runComponentRepair } from '../component-repair.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function makeSkill(frontmatter, hookSource = '') {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-component-repair-'));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n`);
  if (hookSource) {
    fs.mkdirSync(path.join(skillDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'hooks', 'repair.js'), hookSource);
  }
  return skillDir;
}

test('same-version repair hook restores missing component files before success', () => {
  const skillDir = makeSkill('lifecycle:\n  hooks:\n    repair: hooks/repair.js', `
    import fs from 'node:fs';
    import path from 'node:path';
    fs.mkdirSync(path.join(process.env.YOS_SKILL_DIR, 'references', 'lark-doc'), { recursive: true });
    fs.writeFileSync(path.join(process.env.YOS_SKILL_DIR, 'references', 'lark-doc', 'SKILL.md'), 'repaired');
  `);

  const result = runComponentRepair({ componentName: 'feishu', skillDir, stdio: 'pipe' });

  assert.equal(result.declared, true);
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(path.join(skillDir, 'references/lark-doc/SKILL.md'), 'utf8'), 'repaired');
});

test('declared repair hook failure blocks the healthy same-version result', () => {
  const skillDir = makeSkill('lifecycle:\n  hooks:\n    repair: hooks/repair.js', 'process.exit(23);');

  const result = runComponentRepair({ componentName: 'feishu', skillDir, stdio: 'pipe' });

  assert.equal(result.declared, true);
  assert.equal(result.success, false);
  assert.equal(result.code, 'component_repair_failed');
  assert.equal(result.status, 23);
});

test('propagates a safe stage-specific repair error to JSON callers', () => {
  const skillDir = makeSkill('lifecycle:\n  hooks:\n    repair: hooks/repair.js', `
    console.error('[feishu_subskills_fetch_failed] GitHub did not provide all Feishu sub-skills.');
    console.error('Check outbound HTTPS access, then retry: yos upgrade feishu');
    process.exit(1);
  `);
  const result = runComponentRepair({ componentName: 'feishu', skillDir, stdio: 'pipe' });
  assert.equal(result.code, 'feishu_subskills_fetch_failed');
  assert.match(result.message, /GitHub/);
  assert.match(result.remediation, /yos upgrade feishu/);
});

test('components without an explicit repair hook preserve the old no-op behavior', () => {
  const skillDir = makeSkill('name: ordinary-component');
  assert.deepEqual(runComponentRepair({ componentName: 'ordinary', skillDir }), {
    declared: false,
    success: true,
  });
});

test('repair hook paths must remain inside the installed skill directory', () => {
  const skillDir = makeSkill('lifecycle:\n  hooks:\n    repair: ../outside.js');
  const result = runComponentRepair({ componentName: 'feishu', skillDir, stdio: 'pipe' });
  assert.equal(result.success, false);
  assert.equal(result.code, 'component_repair_invalid');
});

test('component upgrade runs repair before reporting a same-version component healthy', () => {
  const source = fs.readFileSync(path.join(ROOT, 'cli/commands/component.js'), 'utf8');
  const noUpdate = source.indexOf('if (!branch && check.success && !check.hasUpdate) {');
  const repair = source.indexOf('runComponentRepair(', noUpdate);
  const healthy = source.indexOf('is up to date', noUpdate);
  assert.ok(noUpdate >= 0, 'same-version branch is missing');
  assert.ok(repair > noUpdate, 'same-version branch does not run the declared repair hook');
  assert.ok(healthy > repair, 'component is reported healthy before its repair hook finishes');
});
