import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { parseSkillMd } from '../skill.js';

const schemaModule = await import('../capability-schema.js').catch((loadError) => ({ loadError }));
const CLI = path.join(import.meta.dirname, '..', '..', 'yos.js');
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'capabilities', 'legacy-component');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('legacy component capability compatibility', () => {
  it('keeps a component without capabilities installable and reports it as undeclared', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-legacy-capability-'));
    tmpDirs.push(root);
    const yosDir = path.join(root, 'yos-home');
    fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
    fs.writeFileSync(path.join(yosDir, '.yos', 'components.json'), '{}\n');
    fs.cpSync(FIXTURE, path.join(root, 'legacy-component'), { recursive: true });

    const result = spawnSync(process.execPath, [CLI, 'add', './legacy-component', '--json'], {
      cwd: root,
      env: { ...process.env, YOS_DIR: yosDir },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, 0, `legacy install failed\n${result.stdout}\n${result.stderr}`);

    const installed = path.join(yosDir, '.claude', 'skills', 'legacy-capability-fixture');
    const parsed = parseSkillMd(installed);
    assert.equal(typeof schemaModule.validateCapabilityDeclarations, 'function');
    const declaration = schemaModule.validateCapabilityDeclarations(parsed.frontmatter, { skillDir: installed });
    assert.deepEqual(declaration, { declarationStatus: 'undeclared', capabilities: [] });
  });
});
