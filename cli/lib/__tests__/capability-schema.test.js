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

  it('fails closed on duplicate capability IDs', () => {
    const frontmatter = {
      capabilities: [
        {
          id: 'communication.message',
          title: 'Messages',
          operations: ['send'],
          keywords: [],
          stability: 'stable',
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
        && /duplicate/i.test(error.message),
    );
  });

  it('fails closed on an escaping health entrypoint', () => {
    assert.throws(
      () => validator()({
        capabilities: [{
          id: 'communication.message',
          title: 'Messages',
          operations: ['send'],
          keywords: [],
          stability: 'stable',
          health: '../private.js',
        }],
      }, { skillDir: FIXTURES }),
      (error) => error?.code === 'capability_schema_invalid'
        && /health/i.test(error.message),
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

  it('accepts a runtime scope and rejects a name no runtime answers to', () => {
    // `runtimes` exists so a declaration that is only true on one runtime is
    // not advertised on the other. A typo must fail loudly: silently scoping a
    // capability to a runtime that does not exist would hide it everywhere,
    // which looks exactly like the capability not being there at all.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-capability-runtimes-'));
    tmpDirs.push(root);
    const base = {
      id: 'runtime.lifecycle',
      title: 'Runtime restart and upgrade',
      operations: ['restart'],
      stability: 'stable',
    };

    const scoped = validator()({ capabilities: [{ ...base, runtimes: ['claude'] }] }, { skillDir: root });
    assert.deepEqual(scoped.capabilities[0].runtimes, ['claude']);

    // Absent means every runtime, and must stay absent rather than defaulting
    // to a list — a default would silently become a claim.
    const unscoped = validator()({ capabilities: [base] }, { skillDir: root });
    assert.equal('runtimes' in unscoped.capabilities[0], false);

    for (const bad of [['clawed'], [], 'claude']) {
      assert.throws(
        () => validator()({ capabilities: [{ ...base, runtimes: bad }] }, { skillDir: root }),
        (error) => error?.code === 'capability_schema_invalid' && /runtime/i.test(error.message),
      );
    }
  });

  it('keeps its runtime list in step with the runtime registry', async () => {
    // capability-schema.js hardcodes the runtime names instead of importing
    // them, to stay a dependency-free validator. This is the price of that
    // choice: if a runtime is added to the registry and not here, declarations
    // cannot scope to it and this goes red.
    const { SUPPORTED_RUNTIMES } = await import('../runtime/index.js');

    assert.deepEqual([...schemaModule.KNOWN_RUNTIMES].sort(), [...SUPPORTED_RUNTIMES].sort());
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
