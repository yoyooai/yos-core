import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runComponentRepair } from '../component-repair.js';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function makeSkill(frontmatter, hookSource = '') {
  const skillDir = makeTempDir('yos-component-repair-');
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
  // The bait has to sit outside the skill directory — that is the whole point —
  // but it must not sit loose in os.tmpdir(), or every run leaves one behind
  // (it did, until 2026-08-29). A managed parent gives it somewhere outside the
  // skill directory that still gets cleaned up.
  const outsideRoot = makeTempDir('yos-component-repair-outside-');
  const skillDir = path.join(outsideRoot, 'skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: repair-path-fixture\n---\n');

  const outsideHook = path.join(outsideRoot, 'outside.js');
  const marker = path.join(outsideRoot, 'outside-executed');
  fs.writeFileSync(outsideHook, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);

  const assertRejectedWithoutExecution = (repairRef) => {
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nlifecycle:\n  hooks:\n    repair: ${repairRef}\n---\n`,
    );
    const result = runComponentRepair({ componentName: 'feishu', skillDir, stdio: 'pipe' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'component_repair_invalid');
    assert.equal(fs.existsSync(marker), false, 'a component executed a repair script outside its directory');
  };

  assertRejectedWithoutExecution(`../${path.basename(outsideHook)}`);

  const linkedHook = path.join(skillDir, 'hooks', 'repair.js');
  fs.mkdirSync(path.dirname(linkedHook), { recursive: true });
  fs.symlinkSync(outsideHook, linkedHook);
  assertRejectedWithoutExecution('hooks/repair.js');

  const repairSource = fs.readFileSync(path.join(ROOT, 'cli/lib/component-repair.js'), 'utf8');
  assert.equal(
    repairSource.match(/!isInside\(root, /g)?.length,
    2,
    'both the lexical-path and resolved-symlink boundaries must remain explicit',
  );
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
