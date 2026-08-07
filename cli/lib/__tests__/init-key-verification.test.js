/**
 * `yos init` credential probes, exercised against a real local endpoint.
 *
 * Three rules are locked down here:
 *   1. The probe goes to the endpoint the install is configured for. It used to
 *      go to the vendor's host unconditionally, so a gateway customer behind a
 *      firewall was told their perfectly good key was invalid.
 *   2. "Could not reach the endpoint" is not "the key is bad". Only an explicit
 *      rejection (401/403) may condemn a key; everything else leaves the verdict
 *      open so the caller saves the key instead of discarding it.
 *   3. A status that proves nothing (404 from a misrouted path, 502 from a down
 *      gateway) is inconclusive — never reported as verified.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import http from 'node:http';

const { verifyApiKey, verifyCodexApiKey, decideCredentialOutcome } = await import('../../commands/init.js');

const openServers = [];

/** Start a local endpoint that answers every request with `status`. */
async function endpointReturning(status) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const handle = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
  openServers.push(handle);
  return handle;
}

after(async () => {
  for (const s of openServers) await s.close();
});

describe('verifyApiKey', () => {
  test('probes the configured gateway, not the vendor host', async () => {
    const gw = await endpointReturning(400);

    const result = await verifyApiKey('sk-ant-test', gw.baseUrl);

    assert.equal(result.ok, true, 'a gateway that accepts the key means valid');
    assert.equal(result.reason, 'valid');
    assert.equal(gw.received.length, 1, 'the probe must actually hit the configured gateway');
    assert.equal(gw.received[0].url, '/v1/messages');
    assert.equal(gw.received[0].method, 'POST');
    assert.equal(gw.received[0].headers['x-api-key'], 'sk-ant-test');
  });

  test('reports the endpoint it contacted, for the error message', async () => {
    const gw = await endpointReturning(401);
    const result = await verifyApiKey('sk-ant-bad', gw.baseUrl);
    assert.equal(result.target, new URL(gw.baseUrl).host);
  });

  test('appends /v1/messages under a gateway path prefix', async () => {
    const gw = await endpointReturning(400);
    await verifyApiKey('sk-ant-test', `${gw.baseUrl}/anthropic`);
    assert.equal(gw.received[0].url, '/anthropic/v1/messages');
  });

  test('tolerates a trailing slash without doubling it', async () => {
    const gw = await endpointReturning(400);
    await verifyApiKey('sk-ant-test', `${gw.baseUrl}/`);
    assert.equal(gw.received[0].url, '/v1/messages');
  });

  test('401 is a rejected key', async () => {
    const gw = await endpointReturning(401);
    const r = await verifyApiKey('sk-ant-bad', gw.baseUrl);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rejected');
  });

  test('403 is a rejected key', async () => {
    const gw = await endpointReturning(403);
    assert.equal((await verifyApiKey('sk-ant-bad', gw.baseUrl)).reason, 'rejected');
  });

  test('200 means the endpoint accepted the key', async () => {
    const gw = await endpointReturning(200);
    assert.equal((await verifyApiKey('sk-ant-test', gw.baseUrl)).reason, 'valid');
  });

  test('404 is inconclusive, not a bad key — the request was misrouted', async () => {
    const gw = await endpointReturning(404);
    const r = await verifyApiKey('sk-ant-test', gw.baseUrl);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'inconclusive');
    assert.equal(r.status, 404);
  });

  test('502 from a gateway is inconclusive, not a bad key', async () => {
    const gw = await endpointReturning(502);
    assert.equal((await verifyApiKey('sk-ant-test', gw.baseUrl)).reason, 'inconclusive');
  });

  test('an unreachable endpoint is inconclusive — never a verdict on the key', async () => {
    // Port 1 on loopback refuses instantly: the firewalled-gateway case.
    const r = await verifyApiKey('sk-ant-test', 'http://127.0.0.1:1');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unreachable');
  });

  test('an unusable base URL is reported as config error, not a bad key', async () => {
    const r = await verifyApiKey('sk-ant-test', 'not-a-url');
    assert.equal(r.reason, 'bad-base-url');
  });
});

describe('decideCredentialOutcome', () => {
  test('only an explicit rejection throws the key away', () => {
    assert.equal(decideCredentialOutcome({ ok: false, reason: 'rejected' }), 'refuse');
  });

  test('an unusable base URL is refused — there is nothing to check against', () => {
    assert.equal(decideCredentialOutcome({ ok: false, reason: 'bad-base-url' }), 'refuse');
  });

  test('an unreachable endpoint KEEPS the key', () => {
    // The regression: init discarded a good key because the network was down,
    // leaving the machine with no credential at all.
    assert.equal(decideCredentialOutcome({ ok: false, reason: 'unreachable' }), 'save-unverified');
  });

  test('an inconclusive status KEEPS the key', () => {
    assert.equal(decideCredentialOutcome({ ok: false, reason: 'inconclusive' }), 'save-unverified');
  });

  test('a confirmed key is verified', () => {
    assert.equal(decideCredentialOutcome({ ok: true, reason: 'valid' }), 'verified');
  });

  test('saved-but-unverified is never the same as verified', () => {
    // Guards the honesty rule: if these two ever collapse into one outcome, the
    // install summary is free to report an unchecked key as authenticated.
    const unchecked = decideCredentialOutcome({ ok: false, reason: 'unreachable' });
    const checked = decideCredentialOutcome({ ok: true, reason: 'valid' });
    assert.notEqual(unchecked, checked);
  });
});

describe('verifyCodexApiKey', () => {
  test('probes the configured gateway at /models', async () => {
    const gw = await endpointReturning(200);

    const result = await verifyCodexApiKey('sk-test', `${gw.baseUrl}/v1`);

    assert.equal(result.ok, true);
    assert.equal(gw.received[0].url, '/v1/models');
    assert.equal(gw.received[0].headers.authorization, 'Bearer sk-test');
  });

  test('401 is a rejected key', async () => {
    const gw = await endpointReturning(401);
    assert.equal((await verifyCodexApiKey('sk-bad', `${gw.baseUrl}/v1`)).reason, 'rejected');
  });

  test('500 is inconclusive, not a bad key', async () => {
    const gw = await endpointReturning(500);
    assert.equal((await verifyCodexApiKey('sk-test', `${gw.baseUrl}/v1`)).reason, 'inconclusive');
  });

  test('an unreachable endpoint is inconclusive', async () => {
    assert.equal((await verifyCodexApiKey('sk-test', 'http://127.0.0.1:1/v1')).reason, 'unreachable');
  });
});
