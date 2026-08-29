import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

const CLI = path.join(import.meta.dirname, '..', '..', 'yos.js');
const root = makeTempDir('yos-capability-shelf-e2e-');
const yosDir = path.join(root, 'yos');
let published = true;
let server;
let baseUrl;

function documents() {
  const buildId = (published ? 'f' : 'e').repeat(64);
  const capabilityDocument = {
    schemaVersion: 1,
    buildId,
    capabilities: published ? [{
      id: 'communication.message',
      title: 'Messages',
      keywords: ['feishu'],
      operations: ['receive', 'send'],
      providers: [{
        id: 'channel.feishu',
        registryName: 'feishu',
        repo: 'yoyooai/yos-components',
        tag: 'feishu-v0.1.4',
        path: 'channels/001_feishu',
        version: '0.1.4',
        source: 'component',
        provenance: 'official',
        stability: 'stable',
        operations: ['receive', 'send'],
        coreRange: '>=0.1.0-alpha.1 <0.2.0',
        nodeRange: '>=20.20.0',
      }],
    }] : [],
  };
  const capabilityText = `${JSON.stringify(capabilityDocument)}\n`;
  return {
    '/index.json': {
      schemaVersion: 1,
      buildId,
      repos: [{ repo: 'yoyooai/yos-components', tags: ['feishu-v0.1.4'] }],
      files: [{
        path: 'capabilities.json',
        bytes: Buffer.byteLength(capabilityText),
        sha256: crypto.createHash('sha256').update(capabilityText).digest('hex'),
      }],
    },
    '/capabilities.json': capabilityText,
  };
}

function runCapability() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'capability', 'search', 'feishu', '--json'], {
      env: { ...process.env, YOS_DIR: yosDir, YOS_DIST_BASE: baseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

before(async () => {
  fs.mkdirSync(path.join(yosDir, '.yos'), { recursive: true });
  fs.writeFileSync(path.join(yosDir, '.yos', 'components.json'), '{}\n');
  server = http.createServer((request, response) => {
    const document = documents()[request.url];
    if (!document) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(typeof document === 'string' ? document : `${JSON.stringify(document)}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('capability discovery from an isolated shelf', () => {
  it('finds a newly published provider without upgrading the CLI and removes it when unpublished', async () => {
    const available = await runCapability();
    assert.equal(available.code, 0, available.stderr);
    const first = JSON.parse(available.stdout);
    assert.deepEqual(first.capabilities[0].providers
      .filter(({ id }) => id === 'channel.feishu')
      .map(({ id, status }) => ({ id, status })), [{ id: 'channel.feishu', status: 'available' }]);

    published = false;
    const removed = await runCapability();
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(JSON.parse(removed.stdout).capabilities, []);
  });
});
