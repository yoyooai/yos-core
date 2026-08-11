#!/usr/bin/env node
/**
 * Mint a short-lived, single-bucket credential for the off-site backup.
 *
 * The shelf machine is production. Copying a shelf off it does not require a
 * long-lived account key to ever be present there — and a key that is present
 * is a key that can be read out of a shell history, an environment dump, or a
 * process listing. This exchanges the long-lived key (which stays on the
 * machine that runs the release) for an STS token that can only write into one
 * bucket and expires on its own.
 *
 * The policy grants exactly what `shelf-offsite.mjs` calls: single PUTs, the
 * GETs that `restore` and `verify` need, and listing the bucket. No delete —
 * a credential that reaches production should not be able to erase the backup
 * it is there to create.
 *
 * `--prefix` is required, and object access is scoped to it. A credential that
 * could write anywhere in the bucket could overwrite every previous release's
 * backup, which is most of what the bucket is for; scoping it to the one prefix
 * this run is about means the worst a leaked token can do is damage the copy it
 * was minted to create. Listing stays bucket-wide because `GetBucket` is a read
 * and `shelf-offsite.mjs` passes the prefix on every list it makes.
 *
 * Usage:
 *   node scripts/cos-sts-token.mjs --bucket <name> --region <region> \
 *     --prefix <prefix/> [--duration 7200] [--json]
 *
 * Reads TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY from the environment.
 * Default output is shell-eval-able, so the token never has to be pasted:
 *
 *   eval "$(node scripts/cos-sts-token.mjs --bucket B --region R)"
 *
 * The APPID is taken from the bucket name, which on COS always ends in `-<appid>`.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const ENDPOINT = 'sts.tencentcloudapi.com';
const SERVICE = 'sts';
const VERSION = '2018-08-13';
const ACTION = 'GetFederationToken';

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    'usage: node scripts/cos-sts-token.mjs --bucket <name> --region <region> ' +
      '--prefix <prefix/> [--duration 7200] [--name label] [--json]\n\n' +
      'credentials: TENCENTCLOUD_SECRET_ID, TENCENTCLOUD_SECRET_KEY',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const options = { duration: 7200, name: 'shelf-offsite-backup', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) usage(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--bucket': options.bucket = next(); break;
      case '--region': options.region = next(); break;
      case '--prefix': options.prefix = next(); break;
      case '--duration': options.duration = Number(next()); break;
      case '--name': options.name = next(); break;
      case '--json': options.json = true; break;
      default: usage(`unknown flag ${arg}`);
    }
  }
  if (!options.bucket) usage('--bucket is required');
  if (!options.region) usage('--region is required');
  if (!options.prefix) usage('--prefix is required — an unscoped credential can overwrite every other backup in the bucket');
  if (options.prefix.startsWith('/')) usage('--prefix must not start with /');
  if (!options.prefix.endsWith('/')) options.prefix += '/';
  if (!Number.isInteger(options.duration) || options.duration < 900 || options.duration > 43200) {
    usage('--duration must be an integer between 900 and 43200 seconds');
  }
  const appid = /-(\d+)$/.exec(options.bucket)?.[1];
  if (!appid) usage(`cannot read an APPID off the bucket name ${JSON.stringify(options.bucket)}`);
  options.appid = appid;
  return options;
}

const sha256hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

/** Tencent Cloud API v3 signature (TC3-HMAC-SHA256). */
function sign(secretId, secretKey, payload, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8\nhost:${ENDPOINT}\n`,
    'content-type;host',
    sha256hex(payload),
  ].join('\n');
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');
  const signature = hmac(
    hmac(hmac(hmac(`TC3${secretKey}`, date), SERVICE), 'tc3_request'),
    stringToSign,
  ).toString('hex');
  return (
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=content-type;host, Signature=${signature}`
  );
}

/**
 * `STS_ENDPOINT` lets the tests answer as STS. Like the one in shelf-offsite.mjs
 * it is restricted to loopback http, so it cannot become a way to send a real
 * account key somewhere else — the restriction is enforced, not documented.
 */
function transportFor() {
  const override = process.env.STS_ENDPOINT;
  if (!override) return { transport: https, hostname: ENDPOINT, port: undefined };
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`STS_ENDPOINT is not a URL: ${override}`);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(
      'STS_ENDPOINT is a test-only hook and must be http://127.0.0.1[:port] or ' +
        `http://localhost[:port] — got ${override}`,
    );
  }
  return { transport: http, hostname: url.hostname, port: url.port || undefined };
}

function post(secretId, secretKey, payload, region) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const { transport, hostname, port } = transportFor();
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method: 'POST',
        host: hostname,
        port,
        path: '/',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Host: ENDPOINT,
          'X-TC-Action': ACTION,
          'X-TC-Version': VERSION,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': region,
          Authorization: sign(secretId, secretKey, body, timestamp),
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(new Error(`unparseable STS response: ${error.message}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('STS request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    console.error('error: TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY must be set');
    process.exit(1);
  }

  const qcsBase = `qcs::cos:${options.region}:uid/${options.appid}:${options.bucket}`;
  const policy = {
    version: '2.0',
    statement: [
      {
        // Objects: only under this run's prefix.
        effect: 'allow',
        action: ['name/cos:PutObject', 'name/cos:GetObject', 'name/cos:HeadObject'],
        resource: [`${qcsBase}/${options.prefix}*`],
      },
      {
        // Listing is a read, and shelf-offsite.mjs always lists with a prefix.
        // COS resolves GetBucket against the object namespace, so this has to be
        // `/*`, not `/` — with `/` it returns 403 on the list and `restore` cannot
        // even see what to fetch (measured against the real service 2026-08-11).
        // The narrowing that matters is on the writes above.
        effect: 'allow',
        action: ['name/cos:GetBucket'],
        resource: [`${qcsBase}/*`],
      },
    ],
  };

  const response = await post(
    secretId,
    secretKey,
    { Name: options.name, Policy: JSON.stringify(policy), DurationSeconds: options.duration },
    options.region,
  );

  const error = response?.Response?.Error;
  if (error) {
    console.error(`error: STS refused (${error.Code}): ${error.Message}`);
    process.exit(1);
  }
  const credentials = response?.Response?.Credentials;
  if (!credentials?.TmpSecretId) {
    console.error(`error: STS returned no credentials: ${JSON.stringify(response).slice(0, 300)}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          secretId: credentials.TmpSecretId,
          secretKey: credentials.TmpSecretKey,
          token: credentials.Token,
          expiration: response.Response.Expiration,
          bucket: options.bucket,
          region: options.region,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`export COS_SECRET_ID='${credentials.TmpSecretId}'`);
    console.log(`export COS_SECRET_KEY='${credentials.TmpSecretKey}'`);
    console.log(`export COS_SESSION_TOKEN='${credentials.Token}'`);
    console.log(
      `# expires ${response.Response.Expiration} — ${options.prefix} in ${options.bucket} only, no delete`,
    );
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
