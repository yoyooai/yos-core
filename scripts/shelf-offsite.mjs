#!/usr/bin/env node
/**
 * Push a shelf off the machine that serves it, and prove the copy is whole.
 *
 * Until 2026-08-11 every "backup" this project had was a `cp -a` sitting on the
 * shelf machine itself. That is a rollback convenience, not a backup: the one
 * failure it does not survive is the machine. This script is the off-site half —
 * it copies a shelf directory into an S3-compatible object store (Tencent COS)
 * and checks every object it wrote.
 *
 * What it refuses to do, because each one is a way a backup silently isn't one:
 *
 *   1. **Skip symlinks quietly.** The first version of this uploader (in
 *      python, same day) did `if islink: continue`. Had the shelf contained a
 *      single symlinked file, the backup would have been short by exactly that
 *      file and still reported success. Symlinks now stop the run unless
 *      `--follow-symlinks` says otherwise, and following one uploads the bytes
 *      it points at, never the link.
 *   2. **Trust its own upload.** Every object's returned ETag is compared to the
 *      MD5 computed locally before the PUT. An ETag that is not a plain 32-hex
 *      MD5 (which is what a multipart upload returns) is treated as a failure
 *      rather than parsed, because this uploader only ever does single PUTs and
 *      anything else means an assumption broke.
 *   3. **Report a pass with files missing.** The object count in the store is
 *      compared to the file count walked on disk. Object stores have no
 *      directories, so an empty directory cannot round-trip; `upload` names any
 *      it found instead of letting `restore` come back quietly short.
 *
 * `restore` is the half that makes the backup real. A backup nobody has restored
 * is a hypothesis — so restore writes the tree back out and hashes every file it
 * pulled, and the restored directory is meant to be handed straight to
 * `verify-public-shelf.mjs --local <dir> --full`, which checks it against the
 * shelf's own index.json.
 *
 * Usage:
 *   node scripts/shelf-offsite.mjs upload  --root <dir>  --bucket B --region R --prefix P/
 *   node scripts/shelf-offsite.mjs restore --dest <dir>  --bucket B --region R --prefix P/
 *   node scripts/shelf-offsite.mjs verify  --root <dir>  --bucket B --region R --prefix P/
 *
 *   --concurrency N   parallel transfers (default 8)
 *   --follow-symlinks upload the target's bytes instead of stopping
 *   --json            machine-readable report on stdout
 *
 * Credentials come from the environment, never from flags (a flag lands in the
 * shell history and in `ps`):
 *
 *   COS_SECRET_ID, COS_SECRET_KEY, and optionally COS_SESSION_TOKEN.
 *
 * Prefer temporary STS credentials scoped to the one bucket — see
 * `scripts/cos-sts-token.mjs`. The shelf machine is production; a long-lived
 * key does not need to be there for a copy to happen.
 *
 * `COS_ENDPOINT` is a test-only hook (see `test/shelf-offsite.test.js`) and is
 * restricted to loopback http, so no typo in it can send a real backup
 * somewhere else.
 *
 * Exit code is 0 only when every file was transferred and verified. There is no
 * partial pass.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const COMMANDS = new Set(['upload', 'restore', 'verify']);

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    'usage: node scripts/shelf-offsite.mjs <upload|restore|verify> \\\n' +
      '         --bucket <name> --region <region> --prefix <prefix/> \\\n' +
      '         (--root <dir> | --dest <dir>) [--concurrency N] [--follow-symlinks] [--json]\n\n' +
      'credentials: COS_SECRET_ID, COS_SECRET_KEY, [COS_SESSION_TOKEN]',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) usage(`unknown command ${JSON.stringify(command ?? '')}`);
  const options = { command, concurrency: 8, followSymlinks: false, json: false };
  for (let i = 1; i < argv.length; i += 1) {
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
      case '--root': options.root = next(); break;
      case '--dest': options.dest = next(); break;
      case '--concurrency': options.concurrency = Number(next()); break;
      case '--follow-symlinks': options.followSymlinks = true; break;
      case '--json': options.json = true; break;
      default: usage(`unknown flag ${arg}`);
    }
  }
  for (const required of ['bucket', 'region', 'prefix']) {
    if (!options[required]) usage(`--${required} is required`);
  }
  if (!options.prefix.endsWith('/')) options.prefix += '/';
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    usage('--concurrency must be a positive integer');
  }
  if (command === 'restore') {
    if (!options.dest) usage('restore needs --dest');
  } else if (!options.root) {
    usage(`${command} needs --root`);
  }
  return options;
}

function credentials() {
  const secretId = process.env.COS_SECRET_ID;
  const secretKey = process.env.COS_SECRET_KEY;
  if (!secretId || !secretKey) {
    console.error('error: COS_SECRET_ID and COS_SECRET_KEY must be set in the environment');
    process.exit(1);
  }
  return { secretId, secretKey, token: process.env.COS_SESSION_TOKEN || '' };
}

/* ---------------------------------------------------------------- signing --
 * COS signature v5. The session token deliberately does not participate in the
 * signature (COS validates it separately); only `host` is signed, which is the
 * minimum the service requires and keeps proxies from invalidating a request.
 */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildAuthorization({ secretId, secretKey }, method, uri, params, headers, expire = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + expire}`;
  const signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex');

  const canonical = (obj) => {
    const pairs = Object.entries(obj)
      .map(([k, v]) => [k.toLowerCase(), v])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      list: pairs.map(([k]) => k).join(';'),
      str: pairs.map(([k, v]) => `${k}=${encodeRfc3986(String(v))}`).join('&'),
    };
  };
  const p = canonical(params);
  const h = canonical(headers);

  const httpString = `${method.toLowerCase()}\n${uri}\n${p.str}\n${h.str}\n`;
  const stringToSign =
    `sha1\n${keyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');

  return (
    `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
    `&q-header-list=${h.list}&q-url-param-list=${p.list}&q-signature=${signature}`
  );
}

/** Object keys are path segments; `/` stays a separator, everything else escapes. */
function encodeKey(key) {
  return `/${key.split('/').map(encodeRfc3986).join('/')}`;
}

function request(creds, { method, endpoint, uri, params = {}, body = null, expectStatus = 200 }) {
  const { transport, host } = endpoint;
  const headers = { Host: host };
  const authorization = buildAuthorization(creds, method, uri, params, headers);
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(String(v))}`)
    .join('&');

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method,
        host: endpoint.hostname,
        port: endpoint.port,
        path: uri + (query ? `?${query}` : ''),
        headers: {
          Host: host,
          Authorization: authorization,
          ...(creds.token ? { 'x-cos-security-token': creds.token } : {}),
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
        timeout: 180_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode !== expectStatus) {
            reject(
              new Error(
                `HTTP ${res.statusCode} for ${method} ${uri} :: ${buffer.toString('utf8').slice(0, 300)}`,
              ),
            );
            return;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: buffer });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withRetries(label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw new Error(`${label}: ${lastError.message}`);
}

const md5 = (buffer) => crypto.createHash('md5').update(buffer).digest('hex');

/**
 * Where the requests go. `COS_ENDPOINT` exists so the tests can point this at a
 * fake COS and exercise the failure paths for real — and it is restricted to
 * loopback http, so it can never quietly redirect an actual backup somewhere
 * else. A test-only hook that a typo could aim at production is not a hook worth
 * having.
 */
function endpointFor(options) {
  const override = process.env.COS_ENDPOINT;
  if (!override) {
    const host = `${options.bucket}.cos.${options.region}.myqcloud.com`;
    return { transport: https, host, hostname: host, port: undefined };
  }
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`COS_ENDPOINT is not a URL: ${override}`);
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(
      'COS_ENDPOINT is a test-only hook and must be http://127.0.0.1[:port] or ' +
        `http://localhost[:port] — got ${override}`,
    );
  }
  return {
    transport: http,
    host: url.port ? `${url.hostname}:${url.port}` : url.hostname,
    hostname: url.hostname,
    port: url.port || undefined,
  };
}

/* ------------------------------------------------------------------ walk --
 * Returns files plus anything that would make the copy quietly incomplete:
 * symlinks (skipped by the earlier python uploader) and empty directories
 * (which an object store cannot represent at all).
 */
async function walk(root, followSymlinks) {
  const files = [];
  const symlinks = [];
  const emptyDirs = [];

  async function visit(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    if (entries.length === 0) emptyDirs.push(path.relative(root, dir) || '.');
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(path.relative(root, full));
        if (!followSymlinks) continue;
        const stat = await fsp.stat(full).catch(() => null);
        if (stat?.isDirectory()) await visit(full);
        else if (stat?.isFile()) files.push(full);
        continue;
      }
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }

  await visit(root);
  files.sort();
  return { files, symlinks, emptyDirs };
}

/** Run `worker` over `items` with a fixed number of parallel slots. */
async function pool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/* ---------------------------------------------------------------- listing -- */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function listObjects(creds, options) {
  const endpoint = endpointFor(options);
  const found = [];
  let marker = '';
  for (;;) {
    const params = { prefix: options.prefix, 'max-keys': '1000' };
    if (marker) params.marker = marker;
    const res = await withRetries('list objects', () =>
      request(creds, { method: 'GET', endpoint, uri: '/', params }),
    );
    const xml = res.body.toString('utf8');
    for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = unescapeXml(/<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '');
      const etag = (/<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] ?? '').replace(/(^"|&quot;)/g, '')
        .replace(/("$|&quot;$)/g, '');
      const size = Number(/<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1] ?? '0');
      if (key) found.push({ key, etag, size });
    }
    const truncated = /<IsTruncated>([\s\S]*?)<\/IsTruncated>/.exec(xml)?.[1] === 'true';
    if (!truncated) break;
    const nextMarker = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1];
    marker = nextMarker ? unescapeXml(nextMarker) : found[found.length - 1]?.key;
    if (!marker) break;
  }
  return found;
}

/* ----------------------------------------------------------------- upload -- */
async function upload(creds, options) {
  const realRoot = await fsp.realpath(options.root);
  const rootStat = await fsp.lstat(realRoot);
  if (!rootStat.isDirectory()) throw new Error(`--root is not a directory: ${realRoot}`);

  const { files, symlinks, emptyDirs } = await walk(realRoot, options.followSymlinks);
  if (symlinks.length && !options.followSymlinks) {
    console.error(
      `error: ${symlinks.length} symlink(s) under --root; a silent skip is how a backup ends up ` +
        `short by exactly those files. Re-run with --follow-symlinks to upload what they point at.\n` +
        symlinks.slice(0, 10).map((s) => `  ${s}`).join('\n'),
    );
    process.exit(1);
  }

  const endpoint = endpointFor(options);
  const verified = [];
  const problems = [];

  await pool(files, options.concurrency, async (file) => {
    const key = options.prefix + path.relative(realRoot, file).split(path.sep).join('/');
    try {
      const body = await fsp.readFile(file);
      const local = md5(body);
      const res = await withRetries(`put ${key}`, () =>
        request(creds, { method: 'PUT', endpoint, uri: encodeKey(key), body }),
      );
      const etag = String(res.headers.etag || '').replace(/"/g, '');
      if (!/^[0-9a-f]{32}$/.test(etag)) {
        problems.push({ key, error: `ETag is not a single-PUT MD5: ${etag || '(absent)'}` });
      } else if (etag !== local) {
        problems.push({ key, error: `ETag ${etag} != local md5 ${local}` });
      } else {
        verified.push(key);
      }
    } catch (error) {
      problems.push({ key, error: error.message });
    }
  });

  return {
    command: 'upload',
    root: realRoot,
    prefix: options.prefix,
    filesWalked: files.length,
    uploadedVerified: verified.length,
    symlinks,
    emptyDirs,
    problems,
  };
}

/* ----------------------------------------------------------------- verify --
 * Compares what is in the store against the tree on disk, in both directions:
 * a backup missing a file and a backup carrying a file the shelf no longer has
 * are both wrong, and only one of them shows up in a count.
 */
async function verify(creds, options) {
  const realRoot = await fsp.realpath(options.root);
  const { files, symlinks } = await walk(realRoot, options.followSymlinks);
  const objects = await listObjects(creds, options);
  const byKey = new Map(objects.map((o) => [o.key, o]));

  const problems = [];
  let matched = 0;
  await pool(files, options.concurrency, async (file) => {
    const key = options.prefix + path.relative(realRoot, file).split(path.sep).join('/');
    const object = byKey.get(key);
    if (!object) {
      problems.push({ key, error: 'missing from the backup' });
      return;
    }
    byKey.delete(key);
    const local = md5(await fsp.readFile(file));
    if (object.etag !== local) problems.push({ key, error: `etag ${object.etag} != local ${local}` });
    else matched += 1;
  });
  for (const key of byKey.keys()) problems.push({ key, error: 'in the backup but not on the shelf' });

  return {
    command: 'verify',
    root: realRoot,
    prefix: options.prefix,
    filesWalked: files.length,
    objectsFound: objects.length,
    matched,
    symlinks,
    problems,
  };
}

/* ---------------------------------------------------------------- restore -- */
async function restore(creds, options) {
  const objects = await listObjects(creds, options);
  if (objects.length === 0) {
    return {
      command: 'restore',
      prefix: options.prefix,
      dest: options.dest,
      objectsFound: 0,
      restoredVerified: 0,
      problems: [{ key: options.prefix, error: 'no objects under this prefix — nothing to restore' }],
    };
  }

  const endpoint = endpointFor(options);
  const dest = path.resolve(options.dest);
  await fsp.mkdir(dest, { recursive: true });
  const problems = [];
  let restored = 0;

  await pool(objects, options.concurrency, async (object) => {
    const relative = object.key.slice(options.prefix.length);
    if (!relative || relative.endsWith('/')) return;
    const target = path.join(dest, ...relative.split('/'));
    if (!target.startsWith(dest + path.sep)) {
      problems.push({ key: object.key, error: 'key escapes --dest' });
      return;
    }
    try {
      const res = await withRetries(`get ${object.key}`, () =>
        request(creds, { method: 'GET', endpoint, uri: encodeKey(object.key) }),
      );
      const got = md5(res.body);
      if (/^[0-9a-f]{32}$/.test(object.etag) && got !== object.etag) {
        problems.push({ key: object.key, error: `downloaded md5 ${got} != stored etag ${object.etag}` });
        return;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, res.body);
      restored += 1;
    } catch (error) {
      problems.push({ key: object.key, error: error.message });
    }
  });

  return {
    command: 'restore',
    prefix: options.prefix,
    dest,
    objectsFound: objects.length,
    restoredVerified: restored,
    problems,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const creds = credentials();
  const runner = { upload, verify, restore }[options.command];
  const report = await runner(creds, options);
  const failed = report.problems.length > 0;

  if (options.json) {
    console.log(JSON.stringify({ ...report, pass: !failed }, null, 2));
  } else {
    console.log(`${report.command} ${report.prefix} @ ${options.bucket} (${options.region})`);
    if (report.command === 'restore') {
      console.log(`  objects in store : ${report.objectsFound}`);
      console.log(`  restored+hashed  : ${report.restoredVerified}`);
      console.log(`  destination      : ${report.dest}`);
    } else {
      console.log(`  files on disk    : ${report.filesWalked}`);
      if (report.command === 'upload') console.log(`  uploaded+hashed  : ${report.uploadedVerified}`);
      else console.log(`  matched          : ${report.matched} (objects: ${report.objectsFound})`);
    }
    if (report.symlinks?.length) console.log(`  symlinks followed: ${report.symlinks.length}`);
    if (report.emptyDirs?.length) {
      console.log(
        `  ⚠ empty dirs     : ${report.emptyDirs.length} — object stores drop these; ` +
          `restore will come back without them:\n${report.emptyDirs.map((d) => `      ${d}`).join('\n')}`,
      );
    }
    if (failed) {
      console.error(`\n${report.problems.length} problem(s):`);
      for (const problem of report.problems.slice(0, 20)) {
        console.error(`  ${problem.key}: ${problem.error}`);
      }
      if (report.problems.length > 20) console.error(`  … ${report.problems.length - 20} more`);
    } else {
      console.log('\nOK — every file transferred and hash-checked.');
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
