import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const commandModule = await import('../../commands/capability.js').catch((loadError) => ({ loadError }));

function fixtureCatalog() {
  return {
    schemaVersion: 1,
    capabilities: [{
      id: 'communication.message',
      title: 'Messages',
      keywords: ['chat', 'message'],
      operations: ['receive', 'send'],
      providers: [
        { id: 'comm-bridge', source: 'core', provenance: 'official', status: 'installed', operations: ['send', 'receive'], stability: 'stable' },
        { id: 'channel.feishu', source: 'component', provenance: 'official', status: 'installed', operations: ['send', 'receive'], stability: 'stable' },
      ],
    }],
    providers: [{ id: 'legacy', declarationStatus: 'undeclared', status: 'installed' }],
    remote: { status: 'available', source: 'shelf', errorCode: null },
  };
}

function runner() {
  assert.equal(typeof commandModule.capabilityCommand, 'function', commandModule.loadError?.message);
  return commandModule.capabilityCommand;
}

async function run(args) {
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  const forbidden = () => { throw new Error('query attempted a side effect'); };
  await runner()(args, {
    loadCatalog: async () => fixtureCatalog(),
    runHealth: forbidden,
    installComponent: forbidden,
    writeFile: forbidden,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    setExitCode: (code) => { exitCode = code; },
  });
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

describe('yos capability read-only CLI', () => {
  it('uses one JSON read model for list, search, show, and providers', async () => {
    const list = await run(['list', '--json']);
    assert.equal(list.exitCode, 0);
    assert.deepEqual(JSON.parse(list.stdout).capabilities, fixtureCatalog().capabilities);
    assert.match((await run(['list'])).stdout, /Undeclared capabilities: legacy/);

    const search = await run(['search', 'chat', '--json']);
    assert.equal(JSON.parse(search.stdout).capabilities.length, 1);

    const show = await run(['show', 'communication.message', '--json']);
    assert.equal(JSON.parse(show.stdout).capability.id, 'communication.message');

    const providers = await run(['providers', 'communication.message', '--json']);
    assert.deepEqual(JSON.parse(providers.stdout).providers.map(({ id }) => id), ['comm-bridge', 'channel.feishu']);
  });

  it('fails clearly for unknown commands, missing arguments, and missing capabilities', async () => {
    for (const args of [
      ['unknown'],
      ['search'],
      ['show', 'missing.capability'],
      ['providers', 'missing.capability'],
    ]) {
      const result = await run(args);
      assert.equal(result.exitCode, 1, args.join(' '));
      assert.ok(result.stderr, args.join(' '));
    }
  });

  it('fails closed without leaking provider paths when the local catalog is invalid', async () => {
    const stdout = [];
    let exitCode = 0;
    await runner()(['list', '--json'], {
      loadCatalog: async () => { throw new Error('bad provider at /Users/private/.env'); },
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      setExitCode: (code) => { exitCode = code; },
    });
    assert.equal(exitCode, 1);
    const output = JSON.parse(stdout.join('\n'));
    assert.equal(output.error, 'capability_catalog_invalid');
    assert.doesNotMatch(JSON.stringify(output), /Users|private|\.env/);
  });

  it('keeps capability routing independent from install and write modules', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'commands', 'capability.js'), 'utf8');
    assert.doesNotMatch(source, /commands\/add|commands\/upgrade|saveComponents|writeFileSync|appendFileSync|mkdirSync/);
    const cli = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'yos.js'), 'utf8');
    assert.match(cli, /capability:\s*capabilityCommand/);
  });

  it('labels components.json type as installation mode instead of capability type', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'commands', 'component.js'), 'utf8');
    const listBody = source.slice(source.indexOf('export async function listComponents'), source.indexOf('export async function searchComponents'));
    assert.match(listBody, /Installation mode:/);
    assert.doesNotMatch(listBody, /\bType:/);
  });
});
