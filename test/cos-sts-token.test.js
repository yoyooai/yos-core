/**
 * This script's whole job is to make the credential that reaches the shelf
 * machine weaker than the one that stays behind. A bug here does not look like
 * a failure — it looks like a token that works, and happens to be able to do
 * more than it should. So what is asserted is mostly the *shape of the policy*
 * that gets sent to STS: what it grants, and what it must not.
 *
 * 小C's 2026-08-11 review: the first version asked for PutObject on the whole
 * bucket, so a token minted to back up one release could overwrite every other
 * release's backup in it. Scoping is pinned here.
 *
 * The TC3 signature is not asserted against a known-good vector — a fake server
 * cannot prove Tencent accepts it. That it is accepted was established against
 * the real service on 2026-08-11.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from '@jest/globals';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'cos-sts-token.mjs',
);

let server = null;
let lastRequest = null;

async function fakeSts({ respondWith = null, status = 200 } = {}) {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastRequest = {
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          respondWith ?? {
            Response: {
              Credentials: {
                TmpSecretId: 'tmp-id',
                TmpSecretKey: 'tmp-key',
                Token: 'tmp-token',
              },
              Expiration: '2026-08-11T14:00:00Z',
              ExpiredTime: 1_770_000_000,
              RequestId: 'req-1',
            },
          },
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function run(args, { port, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          STS_ENDPOINT: port ? `http://127.0.0.1:${port}` : undefined,
          TENCENTCLOUD_SECRET_ID: 'long-lived-id',
          TENCENTCLOUD_SECRET_KEY: 'long-lived-key',
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const BASE = ['--bucket', 'backups-1234567890', '--region', 'ap-test'];

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  lastRequest = null;
});

describe('the policy it asks for', () => {
  test('object access is scoped to the prefix, not the whole bucket', async () => {
    const port = await fakeSts();
    const result = await run([...BASE, '--prefix', 'rollback/run-1/'], { port });

    expect(result.code).toBe(0);
    const policy = JSON.parse(lastRequest.body.Policy);
    const objectStatement = policy.statement.find((s) => s.action.includes('name/cos:PutObject'));

    expect(objectStatement.resource).toEqual([
      'qcs::cos:ap-test:uid/1234567890:backups-1234567890/rollback/run-1/*',
    ]);
    // the bucket-wide form is exactly what must not be there
    for (const resource of objectStatement.resource) {
      expect(resource).not.toBe('qcs::cos:ap-test:uid/1234567890:backups-1234567890/*');
    }
  });

  test('it never asks for delete', async () => {
    const port = await fakeSts();
    await run([...BASE, '--prefix', 'p/'], { port });

    const policy = JSON.parse(lastRequest.body.Policy);
    const actions = policy.statement.flatMap((s) => s.action);
    expect(actions.join(' ')).not.toMatch(/Delete/i);
    expect(actions).toEqual(
      expect.arrayContaining(['name/cos:PutObject', 'name/cos:GetObject', 'name/cos:GetBucket']),
    );
  });

  test('a prefix without a trailing slash is still scoped as a prefix', async () => {
    const port = await fakeSts();
    await run([...BASE, '--prefix', 'shelf/0.1.14'], { port });

    const policy = JSON.parse(lastRequest.body.Policy);
    const objectStatement = policy.statement.find((s) => s.action.includes('name/cos:PutObject'));
    expect(objectStatement.resource[0]).toMatch(/:backups-1234567890\/shelf\/0\.1\.14\/\*$/);
  });

  /*
   * Measured against the real service on 2026-08-11: scoping GetBucket to
   * `<bucket>/` returns 403 on the list, so `restore` cannot even see what to
   * fetch. It has to be `<bucket>/*`. That looks like the broad form and invites
   * being "tightened" back by anyone reading the policy without running it —
   * which is why the distinction is pinned here rather than only explained in a
   * comment. The narrowing that protects other backups is on the writes.
   */
  test('listing is bucket-wide on purpose, while writing stays prefix-scoped', async () => {
    const port = await fakeSts();
    await run([...BASE, '--prefix', 'rollback/run-1/'], { port });

    const policy = JSON.parse(lastRequest.body.Policy);
    const listStatement = policy.statement.find((s) => s.action.includes('name/cos:GetBucket'));
    const writeStatement = policy.statement.find((s) => s.action.includes('name/cos:PutObject'));

    expect(listStatement.resource).toEqual([
      'qcs::cos:ap-test:uid/1234567890:backups-1234567890/*',
    ]);
    expect(listStatement.action).not.toContain('name/cos:PutObject');
    expect(writeStatement.resource[0]).toContain('/rollback/run-1/');
  });

  test('the requested lifetime is passed through', async () => {
    const port = await fakeSts();
    await run([...BASE, '--prefix', 'p/', '--duration', '900'], { port });
    expect(lastRequest.body.DurationSeconds).toBe(900);
  });
});

describe('refusals', () => {
  test('no --prefix means no credential', async () => {
    const port = await fakeSts();
    const result = await run([...BASE], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--prefix is required/);
    expect(lastRequest).toBeNull();
  });

  test('a bucket name with no APPID is refused before anything is sent', async () => {
    const port = await fakeSts();
    const result = await run(['--bucket', 'backups', '--region', 'ap-test', '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/APPID/);
    expect(lastRequest).toBeNull();
  });

  test('an out-of-range lifetime is refused', async () => {
    const port = await fakeSts();
    const result = await run([...BASE, '--prefix', 'p/', '--duration', '99999'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/between 900 and 43200/);
    expect(lastRequest).toBeNull();
  });

  test('missing long-lived credentials stop the run', async () => {
    const port = await fakeSts();
    const result = await run([...BASE, '--prefix', 'p/'], {
      port,
      env: { TENCENTCLOUD_SECRET_ID: '', TENCENTCLOUD_SECRET_KEY: '' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/TENCENTCLOUD_SECRET_ID/);
  });

  test('an STS error is surfaced, not turned into an empty credential', async () => {
    const port = await fakeSts({
      respondWith: { Response: { Error: { Code: 'AuthFailure', Message: 'nope' }, RequestId: 'r' } },
    });
    const result = await run([...BASE, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/AuthFailure/);
    expect(result.stdout).not.toMatch(/export COS_SECRET_ID/);
  });

  test('a response with no credentials does not produce empty exports', async () => {
    const port = await fakeSts({ respondWith: { Response: { RequestId: 'r' } } });
    const result = await run([...BASE, '--prefix', 'p/'], { port });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toMatch(/export COS_SECRET_ID/);
  });

  test('the test-only endpoint hook refuses to point anywhere but loopback', async () => {
    const result = await run([...BASE, '--prefix', 'p/'], {
      env: { STS_ENDPOINT: 'http://sts.evil.example.com' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/test-only hook/);
  });
});

describe('output', () => {
  test('default output is shell-eval-able and carries the token', async () => {
    const port = await fakeSts();
    const result = await run([...BASE, '--prefix', 'p/'], { port });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^export COS_SECRET_ID='tmp-id'$/m);
    expect(result.stdout).toMatch(/^export COS_SECRET_KEY='tmp-key'$/m);
    expect(result.stdout).toMatch(/^export COS_SESSION_TOKEN='tmp-token'$/m);
  });

  test('--json carries the same values plus the expiry', async () => {
    const port = await fakeSts();
    const result = await run([...BASE, '--prefix', 'p/', '--json'], { port });

    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      secretId: 'tmp-id',
      secretKey: 'tmp-key',
      token: 'tmp-token',
      bucket: 'backups-1234567890',
      region: 'ap-test',
    });
    expect(parsed.expiration).toBe('2026-08-11T14:00:00Z');
  });
});
