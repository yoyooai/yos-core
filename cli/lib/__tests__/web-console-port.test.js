import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { makeTempDir } from '../../../test/helpers/temp-dir.js';

import {
  DEFAULT_WEB_CONSOLE_PORT,
  probePort,
  readRecordedConsolePort,
  resolveWebConsolePort,
} from '../web-console-port.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function envFileWith(content) {
  const dir = makeTempDir('yos-console-port-');
  tmpDirs.push(dir);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('probing a port', () => {
  it('answers false while something is listening on it', async () => {
    // The check that was missing entirely: init printed a console URL for a port
    // it had never tried to bind.
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const { port } = server.address();
    try {
      assert.equal(await probePort(port, { host: '127.0.0.1' }), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(await probePort(port, { host: '127.0.0.1' }), true);
  });

  it('answers false instead of throwing for a port it may not bind', async () => {
    assert.equal(await probePort(1, { host: '127.0.0.1' }), process.getuid?.() === 0);
  });
});

describe('choosing the console port', () => {
  const takenProbe = (taken) => async (port) => !taken.includes(port);

  it('keeps the default when it is free', async () => {
    const outcome = await resolveWebConsolePort({ probe: async () => true });
    assert.deepEqual(outcome, {
      port: DEFAULT_WEB_CONSOLE_PORT,
      preferred: DEFAULT_WEB_CONSOLE_PORT,
      moved: false,
      exhausted: false,
    });
  });

  it('moves to the next free port when the default is taken', async () => {
    const outcome = await resolveWebConsolePort({ probe: takenProbe([3456, 3457]) });
    assert.equal(outcome.port, 3458);
    assert.equal(outcome.moved, true);
    assert.equal(outcome.preferred, 3456);
  });

  it('does not move a port the user configured on purpose', async () => {
    // Silently relocating a configured port breaks the URL someone bookmarked
    // and nothing would say why.
    const outcome = await resolveWebConsolePort({
      preferred: 9000,
      explicit: true,
      probe: takenProbe([9000]),
    });
    assert.equal(outcome.port, null);
    assert.equal(outcome.exhausted, true);
    assert.equal(outcome.preferred, 9000);
  });

  it('reports exhaustion rather than returning a port it never probed', async () => {
    const outcome = await resolveWebConsolePort({ probe: async () => false });
    assert.equal(outcome.port, null);
    assert.equal(outcome.exhausted, true);
  });

  it('falls back to the default for a nonsense preferred port', async () => {
    for (const preferred of ['abc', 0, -1, 70000, null]) {
      const outcome = await resolveWebConsolePort({ preferred, probe: async () => true });
      assert.equal(outcome.port, DEFAULT_WEB_CONSOLE_PORT, `preferred=${preferred}`);
    }
  });

  it('stops searching at the top of the port range', async () => {
    const outcome = await resolveWebConsolePort({ preferred: 65_534, probe: async () => false });
    assert.equal(outcome.port, null);
  });
});

describe('reading the port that was recorded', () => {
  it('prefers the process environment', () => {
    const file = envFileWith('WEB_CONSOLE_PORT=4000\n');
    assert.equal(readRecordedConsolePort({ envFile: file, env: { WEB_CONSOLE_PORT: '5000' } }), 5000);
  });

  it('reads the value init wrote to .env', () => {
    const file = envFileWith('# Web Console port\nWEB_CONSOLE_PORT=3457\nOTHER=1\n');
    assert.equal(readRecordedConsolePort({ envFile: file, env: {} }), 3457);
  });

  it('returns the default when nothing recorded a port', () => {
    const file = envFileWith('OTHER=1\n');
    assert.equal(readRecordedConsolePort({ envFile: file, env: {} }), DEFAULT_WEB_CONSOLE_PORT);
    assert.equal(
      readRecordedConsolePort({ envFile: path.join(os.tmpdir(), 'yos-absent-env'), env: {} }),
      DEFAULT_WEB_CONSOLE_PORT,
    );
  });

  it('ignores a value that is not a usable port', () => {
    for (const raw of ['abc', '0', '99999', '']) {
      const file = envFileWith(`WEB_CONSOLE_PORT=${raw}\n`);
      assert.equal(readRecordedConsolePort({ envFile: file, env: {} }), DEFAULT_WEB_CONSOLE_PORT, raw);
    }
  });
});
