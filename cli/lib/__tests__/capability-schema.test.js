import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import { afterEach } from 'node:test';

import { parseSkillMd } from '../skill.js';

const schemaModule = await import('../capability-schema.js').catch((loadError) => ({ loadError }));
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'capabilities');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function validator() {
  assert.equal(
    typeof schemaModule.validateCapabilityDeclarations,
    'function',
    `capability-schema.js must export validateCapabilityDeclarations (${schemaModule.loadError?.code ?? 'missing export'})`,
  );
  return schemaModule.validateCapabilityDeclarations;
}

describe('capability declaration schema', () => {
  it('normalizes a valid declaration into the V1 contract', () => {
    const parsed = parseSkillMd(path.join(FIXTURES, 'valid-component'));
    const result = validator()(parsed.frontmatter, {
      skillDir: path.join(FIXTURES, 'valid-component'),
    });

    assert.equal(result.declarationStatus, 'declared');
    assert.deepEqual(result.capabilities, [{
      id: 'communication.message',
      title: 'Send and receive messages',
      operations: ['send', 'receive'],
      keywords: ['message', 'chat'],
      stability: 'stable',
      health: 'hooks/health.js',
    }]);
  });

  it('fails closed when a declared capability contains an unknown field', () => {
    const parsed = parseSkillMd(path.join(FIXTURES, 'invalid-unknown-field'));
    assert.throws(
      () => validator()(parsed.frontmatter, {
        skillDir: path.join(FIXTURES, 'invalid-unknown-field'),
      }),
      (error) => error?.code === 'capability_schema_invalid'
        && /invented-field/.test(error.message),
    );
  });

  it('fails closed on duplicate IDs and an escaping health entrypoint', () => {
    const frontmatter = {
      capabilities: [
        {
          id: 'communication.message',
          title: 'Messages',
          operations: ['send'],
          keywords: [],
          stability: 'stable',
          health: '../private.js',
        },
        {
          id: 'communication.message',
          title: 'Messages again',
          operations: ['receive'],
          keywords: [],
          stability: 'stable',
        },
      ],
    };

    assert.throws(
      () => validator()(frontmatter, { skillDir: FIXTURES }),
      (error) => error?.code === 'capability_schema_invalid'
        && /health|duplicate/i.test(error.message),
    );
  });

  it('rejects invalid operations, stability values, and health symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-capability-schema-'));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, 'outside.js'), 'process.exit(0);\n');
    fs.symlinkSync(path.join(root, 'outside.js'), path.join(root, 'health.js'));

    const base = {
      id: 'communication.message',
      title: 'Messages',
      operations: ['send'],
      keywords: [],
      stability: 'stable',
    };
    assert.throws(
      () => validator()({ capabilities: [{ ...base, operations: ['Send now'] }] }, { skillDir: root }),
      (error) => error?.code === 'capability_schema_invalid' && /operation/i.test(error.message),
    );
    assert.throws(
      () => validator()({ capabilities: [{ ...base, stability: 'candidate' }] }, { skillDir: root }),
      (error) => error?.code === 'capability_schema_invalid' && /stability/i.test(error.message),
    );
    assert.throws(
      () => validator()({ capabilities: [{ ...base, health: 'health.js' }] }, { skillDir: root }),
      (error) => error?.code === 'capability_schema_invalid' && /symbolic/i.test(error.message),
    );
  });

  it('uses a strict YAML entrypoint instead of turning malformed frontmatter into undeclared', () => {
    assert.equal(typeof schemaModule.parseCapabilitySkill, 'function');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-capability-yaml-'));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, 'SKILL.md'), '---\ncapabilities: [unterminated\n---\n');
    assert.throws(
      () => schemaModule.parseCapabilitySkill(root),
      (error) => error?.code === 'capability_schema_invalid' && /YAML/.test(error.message),
    );
  });
});
