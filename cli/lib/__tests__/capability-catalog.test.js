import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const catalogModule = await import('../capability-catalog.js').catch((loadError) => ({ loadError }));
const CORE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function catalogBuilder() {
  assert.equal(
    typeof catalogModule.buildLocalCapabilityCatalog,
    'function',
    `capability-catalog.js must export buildLocalCapabilityCatalog (${catalogModule.loadError?.code ?? 'missing export'})`,
  );
  return catalogModule.buildLocalCapabilityCatalog;
}

function writeProvider(root, relativeDir, { name, capabilityId, selfReportedSource }) {
  const dir = path.join(root, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\ndescription: fixture\nsource: ${selfReportedSource}\ncapabilities:\n  - id: ${capabilityId}\n    title: Messages\n    operations: [send, receive]\n    keywords: [message]\n    stability: stable\n---\n\n# Fixture\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    yos: { id: `fixture.${name}`, core: '>=0.1.0-alpha.1 <0.2.0' },
    engines: { node: '>=20.20.0' },
  }, null, 2));
  return dir;
}

describe('local capability catalog', () => {
  it('groups core and component providers without trusting their self-reported source', () => {
    const root = makeTempDir('yos-capability-catalog-');
    tmpDirs.push(root);
    const coreDir = writeProvider(root, 'core/message', {
      name: 'core-message',
      capabilityId: 'communication.message',
      selfReportedSource: 'component',
    });
    const componentDir = writeProvider(root, 'components/feishu', {
      name: 'feishu',
      capabilityId: 'communication.message',
      selfReportedSource: 'core',
    });

    const result = catalogBuilder()({
      coreProviders: [{ id: 'core-message', dir: coreDir }],
      componentProviders: [{ id: 'channel.feishu', dir: componentDir, provenance: 'official' }],
      coreVersion: '0.1.13',
      nodeVersion: process.version,
    });

    const capability = result.capabilities.find(({ id }) => id === 'communication.message');
    assert.ok(capability);
    assert.deepEqual(
      capability.providers.map(({ id, source }) => ({ id, source })),
      [
        { id: 'core-message', source: 'core' },
        { id: 'channel.feishu', source: 'component' },
      ],
    );
  });

  it('does not open component credentials or user data while building the catalog', () => {
    const opened = [];
    const result = catalogBuilder()({
      coreProviders: [],
      componentProviders: [],
      coreVersion: '0.1.13',
      nodeVersion: process.version,
      readFile(file) {
        opened.push(String(file));
        throw new Error('no provider files should be opened for an empty catalog');
      },
    });

    assert.deepEqual(result.capabilities, []);
    assert.deepEqual(opened, []);
  });

  it('derives provenance and compatibility instead of trusting component self-reporting', () => {
    const root = makeTempDir('yos-capability-provenance-');
    tmpDirs.push(root);
    const dir = writeProvider(root, 'components/untrusted', {
      name: 'untrusted',
      capabilityId: 'communication.message',
      selfReportedSource: 'core',
    });
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
      .replace('source: core', 'source: core\nofficial: true');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.yos.core = '>=9.0.0';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));

    const result = catalogBuilder()({
      componentProviders: [{ id: 'channel.untrusted', dir }],
      coreVersion: '0.1.13',
      nodeVersion: process.version,
    });
    const provider = result.capabilities[0].providers[0];
    assert.equal(provider.source, 'component');
    assert.equal(provider.provenance, 'third-party');
    assert.equal(provider.status, 'incompatible');
    assert.equal(provider.compatibility.core.satisfied, false);
  });

  it('discovers only package core skills and recorded component directories', () => {
    assert.equal(typeof catalogModule.discoverLocalCapabilityProviders, 'function');
    const root = makeTempDir('yos-capability-discovery-');
    tmpDirs.push(root);
    const coreSkillsDir = path.join(root, 'package-skills');
    const installedSkillsDir = path.join(root, 'installed-skills');
    const coreDir = writeProvider(coreSkillsDir, 'scheduler', {
      name: 'scheduler', capabilityId: 'task.schedule', selfReportedSource: 'component',
    });
    const componentDir = writeProvider(installedSkillsDir, 'feishu', {
      name: 'feishu', capabilityId: 'communication.message', selfReportedSource: 'core',
    });
    writeProvider(installedSkillsDir, 'unrecorded-user-skill', {
      name: 'private', capabilityId: 'private.unknown', selfReportedSource: 'core',
    });

    const discovered = catalogModule.discoverLocalCapabilityProviders({
      coreSkillsDir,
      installedSkillsDir,
      components: {
        feishu: { skillDir: componentDir, source: { type: 'registry-artifact' } },
      },
      registry: { feishu: { official: true } },
    });
    // runDir is where a health probe is executed from. This core skill has no
    // installed copy here, so it falls back to the package copy.
    assert.deepEqual(discovered.coreProviders, [{ id: 'scheduler', dir: coreDir, runDir: coreDir }]);
    assert.deepEqual(discovered.componentProviders, [{
      id: 'feishu', dir: componentDir, provenance: 'official', installMode: 'declarative',
    }]);
  });

  it('reads only SKILL.md and package.json from provider roots', () => {
    const root = makeTempDir('yos-capability-read-boundary-');
    tmpDirs.push(root);
    const dir = writeProvider(root, 'component', {
      name: 'bounded', capabilityId: 'communication.message', selfReportedSource: 'component',
    });
    for (const forbidden of ['.env', 'config.json', 'credentials.json', 'user-message.txt']) {
      fs.writeFileSync(path.join(dir, forbidden), 'PRIVATE');
    }
    const opened = [];
    const readFile = (file, encoding) => {
      opened.push(path.basename(file));
      assert.ok(['SKILL.md', 'package.json'].includes(path.basename(file)), `forbidden read: ${file}`);
      return fs.readFileSync(file, encoding);
    };
    catalogBuilder()({
      componentProviders: [{ id: 'bounded', dir }],
      coreVersion: '0.1.13',
      nodeVersion: process.version,
      readFile,
    });
    assert.deepEqual(new Set(opened), new Set(['SKILL.md', 'package.json']));
  });

  it('declares the real built-in messaging providers as core capabilities', () => {
    const providerNames = [
      'activity-monitor', 'comm-bridge', 'component-management', 'create-skill',
      'health-check', 'http', 'scheduler', 'shell', 'web-console', 'yos-memory',
    ];
    const result = catalogBuilder()({
      coreProviders: providerNames.map((id) => ({ id, dir: path.join(CORE_ROOT, 'skills', id) })),
      coreVersion: '0.1.13',
      nodeVersion: process.version,
    });
    const messages = result.capabilities.find(({ id }) => id === 'communication.message');
    assert.ok(messages, 'core messaging capability is not declared');
    assert.deepEqual(messages.providers.map(({ id, source }) => ({ id, source })), [
      { id: 'comm-bridge', source: 'core' },
      { id: 'shell', source: 'core' },
      { id: 'web-console', source: 'core' },
    ]);
    assert.deepEqual(messages.operations, ['receive', 'send']);
    assert.deepEqual(
      result.capabilities.map(({ id }) => id),
      [
        'communication.message', 'component.manage', 'memory.persist', 'runtime.monitor',
        'skill.author', 'system.health', 'task.schedule', 'web.publish',
      ],
    );
    assert.ok(result.capabilities.every(({ providers }) => providers.every(({ source }) => source === 'core')));
  });
});
