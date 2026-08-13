/**
 * `docs/release.md` is the only step-by-step source for shipping to production,
 * and twice in 小C's 2026-08-11 review it shipped the same defect: a block of
 * commands whose variables only had values on a different machine. Both times
 * the prose one paragraph above said the step spanned two machines. Prose does
 * not run.
 *
 * So this file does two things the reviews had to do by hand:
 *
 *   1. checks that every command block declares its machine and reads only what
 *      that machine could have assigned, and — importantly — proves the checker
 *      itself would have caught the two defects that got through;
 *   2. actually executes the off-site backup step out of the document, against a
 *      fake COS and a fake STS, so "the manual works" stops being a claim.
 *
 * The execution test substitutes a small, fixed set of lines (the placeholders
 * a real operator fills in, plus the `ssh` a test cannot make). Every
 * substitution is asserted to have matched exactly once, because a substitution
 * that silently matches nothing turns this into a test that runs a different
 * script than the one in the repository and passes anyway.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from '@jest/globals';

import {
  assignmentsIn,
  checkVariableClosure,
  extractCommandBlocks,
  scanBlock,
  verifyReleaseDoc,
} from '../scripts/release-doc-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'release.md'), 'utf8');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let servers = [];
let tmpDirs = [];

function tmpDir(prefix = 'releasedoc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  servers = [];
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('every command block says where it runs', () => {
  test('the runbook itself is closed: nothing is read where it was never assigned', () => {
    const { blocks, problems } = verifyReleaseDoc(DOC);

    expect(blocks.length).toBeGreaterThan(8);
    expect(problems.map((p) => `L${p.line} ${p.kind} ${p.name ?? ''}`)).toEqual([]);
  });

  test('every block carries a machine, and the shelf/control split is real', () => {
    const blocks = extractCommandBlocks(DOC);
    expect(blocks.every((b) => b.machine)).toBe(true);

    const machines = new Set(blocks.map((b) => b.machine));
    // the two that the off-site step depends on being distinct
    expect(machines.has('控制机')).toBe(true);
    expect(machines.has('货架机')).toBe(true);
  });
});

describe('the checker catches what the reviews caught by hand', () => {
  /* This is 小C's finding, reduced: $BAK exists on the shelf machine, and the
   * control machine's block reaches for it. Real shells expand that to nothing
   * and hand `--root` an empty argument. */
  test('a variable borrowed from another machine is flagged', () => {
    const markdown = [
      '```bash',
      '# @machine 货架机',
      'BAK=/srv/yos-dist.bak-old',
      '```',
      '```bash',
      '# @machine 控制机',
      'node scripts/shelf-offsite.mjs upload --root $BAK',
      '```',
    ].join('\n');

    const problems = checkVariableClosure(extractCommandBlocks(markdown));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'unbound', name: 'BAK', machine: '控制机' });
  });

  test('a block with no machine tag is refused rather than skipped', () => {
    const markdown = ['```bash', 'node scripts/shelf-offsite.mjs upload --root $BAK', '```'].join('\n');

    const problems = checkVariableClosure(extractCommandBlocks(markdown));
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('untagged');
  });

  test('using a variable above its own assignment is flagged too', () => {
    const markdown = [
      '```bash',
      '# @machine 控制机',
      'echo $RUN',
      'RUN=rollback/x/',
      '```',
    ].join('\n');

    const problems = checkVariableClosure(extractCommandBlocks(markdown));
    expect(problems).toHaveLength(1);
    expect(problems[0].name).toBe('RUN');
  });

  test('a later block on the same machine may use an earlier block\'s variable', () => {
    const markdown = [
      '```bash',
      '# @machine 货架机',
      'STAMP=20260812',
      '```',
      '```bash',
      '# @machine 货架机',
      'echo $STAMP',
      '```',
    ].join('\n');

    expect(checkVariableClosure(extractCommandBlocks(markdown))).toEqual([]);
  });
});

describe('it reads the block the way the shell would', () => {
  /* Both of these were false positives on the checker's first draft. A checker
   * that flags correct lines gets its findings waved through, which costs more
   * than having no checker. */
  test('a $NAME inside a comment is not a read', () => {
    const markdown = ['```bash', '# @machine 控制机', '# 不要凭记忆重算 $STAMP', '```'].join('\n');
    expect(checkVariableClosure(extractCommandBlocks(markdown))).toEqual([]);
  });

  test('a ${...} inside single quotes is not a read — that is how it stays JavaScript', () => {
    const markdown = [
      '```bash',
      '# @machine 货架机',
      "node -e 'console.log(`${s.buildId}`)' file.json",
      '```',
    ].join('\n');
    expect(checkVariableClosure(extractCommandBlocks(markdown))).toEqual([]);
  });

  test('an escaped \\$NAME is a value for the far side of an ssh, not a read here', () => {
    const markdown = ['```bash', '# @machine 控制机', 'echo "\\$REMOTE_ONLY"', '```'].join('\n');
    expect(checkVariableClosure(extractCommandBlocks(markdown))).toEqual([]);
  });

  test('a $NAME inside double quotes IS a read', () => {
    const markdown = ['```bash', '# @machine 控制机', 'echo "prefix: $RUN"', '```'].join('\n');
    expect(checkVariableClosure(extractCommandBlocks(markdown))[0].name).toBe('RUN');
  });

  test('assignments are recognised in the forms the runbook uses', () => {
    expect(assignmentsIn('STAMP=$(date +%Y%m%d-%H%M)')).toEqual(['STAMP']);
    expect(assignmentsIn('export COS_BUCKET=<桶名>  COS_REGION=<地域>')).toEqual([
      'COS_BUCKET',
      'COS_REGION',
    ]);
    expect(assignmentsIn('  RUN="rollback/$OLD-$STAMP/"')).toEqual(['RUN']);
    expect(assignmentsIn('node scripts/x.mjs --expect-versions yos=1.2.3')).toEqual([]);
  });

  test('quote state carries across lines within a block', () => {
    const scanned = scanBlock([
      { text: "node -e 'const s = 1;", line: 1 },
      { text: "  console.log(`${s}`)' out.json", line: 2 },
      { text: 'echo $REAL', line: 3 },
    ]);
    expect(scanned[1].expansions).toEqual([]);
    expect(scanned[2].expansions).toEqual(['REAL']);
  });
});

/* ------------------------------------------------------- running the manual --
 * Everything above proves the document is self-consistent. It does not prove the
 * commands work. This does: it lifts the off-site block out of the file and runs
 * it, with a fake STS handing out a token and a fake COS receiving the objects.
 */

async function fakeStsAndCos() {
  const store = new Map();
  const stsRequests = [];

  const sts = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      stsRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          Response: {
            Credentials: { TmpSecretId: 'tmp-id', TmpSecretKey: 'tmp-key', Token: 'tmp-token' },
            Expiration: '2026-08-12T14:00:00Z',
            RequestId: 'req-1',
          },
        }),
      );
    });
  });

  const cos = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        store.set(key, body);
        res.setHeader('ETag', `"${md5(body)}"`);
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, v]) =>
            `<Contents><Key>${xmlEscape(k)}</Key><ETag>&quot;${md5(v)}&quot;</ETag>` +
            `<Size>${v.length}</Size></Contents>`,
        )
        .join('');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }
    if (req.method === 'GET' && store.has(key)) {
      res.writeHead(200);
      res.end(store.get(key));
      return;
    }
    res.writeHead(404);
    res.end('<Error><Code>NoSuchKey</Code></Error>');
  });

  servers.push(sts, cos);
  await new Promise((resolve) => sts.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => cos.listen(0, '127.0.0.1', resolve));
  return { store, stsRequests, stsPort: sts.address().port, cosPort: cos.address().port };
}

/**
 * Apply the operator's fill-ins to a lifted block. Each replacement must fire
 * exactly once — a pattern that stops matching (because the runbook was edited)
 * has to fail here, loudly, instead of leaving a test that quietly runs an
 * unsubstituted script.
 */
function fillIn(script, replacements) {
  let result = script;
  for (const [pattern, value] of replacements) {
    const matches = result.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `runbook substitution ${pattern} matched ${matches.length} times, expected exactly 1 — ` +
          'docs/release.md changed and this test is no longer running what it claims to run',
      );
    }
    result = result.replace(pattern, value);
  }
  return result;
}

function runScript(script, env) {
  const file = path.join(tmpDir(), 'lifted.sh');
  fs.writeFileSync(file, script);
  return new Promise((resolve) => {
    execFile(
      'bash',
      [file],
      { cwd: ROOT, timeout: 60_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe('the off-site backup step, executed out of the document', () => {
  test('one key covers both sub-prefixes, and the credential goes off-site with the shelf', async () => {
    const { store, stsRequests, stsPort, cosPort } = await fakeStsAndCos();

    // a shelf-shaped tree, and the credential file step ④ produces
    const bak = tmpDir('bak-');
    fs.mkdirSync(path.join(bak, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(bak, 'index.json'), '{"files":[]}');
    fs.writeFileSync(path.join(bak, 'sub', 'pkg.tgz'), crypto.randomBytes(512));
    const metadir = tmpDir('meta-');
    fs.writeFileSync(
      path.join(metadir, 'shelf.json'),
      JSON.stringify({ pass: true, buildId: 'bid-old', indexSha256: 'sha-old' }),
    );

    const controlBlock = extractCommandBlocks(DOC).find((b) => b.machine === '控制机');
    const lifted = fillIn(
      controlBlock.lines.map((l) => l.text).join('\n'),
      [
        [/^OLD=<抄自货架机>$/m, 'OLD=0.1.13'],
        [/^STAMP=<抄自货架机>$/m, 'STAMP=20260812-0000'],
        [/^BAK=\/srv\/yos-dist\.bak-\$OLD-\$STAMP.*$/m, `BAK=${bak}`],
        [/^METADIR=\/var\/backups\/yos-dist-\$OLD-\$STAMP\.meta.*$/m, `METADIR=${metadir}`],
        [/^SHELF=<货架机 ssh 目标>.*$/m, 'SHELF=not-used-in-test'],
        [/^REPO=<货架机上本仓库的目录>.*$/m, `REPO=${ROOT}`],
        [/^export COS_BUCKET=<桶名>\s+COS_REGION=<地域>$/m, 'export COS_BUCKET=b-1234567890 COS_REGION=ap-test'],
        // a test cannot ssh; everything else about the pipeline is kept
        [/\| ssh "\$SHELF" bash -s/, '| bash -s'],
      ],
    );

    const result = await runScript(lifted, {
      STS_ENDPOINT: `http://127.0.0.1:${stsPort}`,
      COS_ENDPOINT: `http://127.0.0.1:${cosPort}`,
      TENCENTCLOUD_SECRET_ID: 'long-lived-id',
      TENCENTCLOUD_SECRET_KEY: 'long-lived-key',
    });

    expect(`${result.stdout}${result.stderr}`).not.toMatch(/error|失败/i);
    expect(result.code).toBe(0);

    const RUN = 'rollback/0.1.13-20260812-0000/';

    // the shelf tree went up …
    expect([...store.keys()].sort()).toEqual([
      `${RUN}meta/shelf.json`,
      `${RUN}shelf/index.json`,
      `${RUN}shelf/sub/pkg.tgz`,
    ]);

    // … and the credential really is the one step ④ wrote, not a placeholder
    expect(JSON.parse(store.get(`${RUN}meta/shelf.json`).toString())).toMatchObject({
      buildId: 'bid-old',
      indexSha256: 'sha-old',
    });

    // one token, minted for the parent prefix, covering both children
    expect(stsRequests).toHaveLength(1);
    const policy = JSON.parse(stsRequests[0].Policy);
    const writes = policy.statement.find((s) => s.action.includes('name/cos:PutObject'));
    expect(writes.resource).toEqual([`qcs::cos:ap-test:uid/1234567890:b-1234567890/${RUN}*`]);

    expect(result.stdout).toContain(`off-site RUN prefix: ${RUN}`);
  });

  test('the run stops, and says so, when the shelf upload fails', async () => {
    const { stsPort, cosPort } = await fakeStsAndCos();
    const metadir = tmpDir('meta-');
    fs.writeFileSync(path.join(metadir, 'shelf.json'), '{"pass":true}');
    const credsFile = path.join(tmpDir('creds-'), 'cos-creds.sh');

    const controlBlock = extractCommandBlocks(DOC).find((b) => b.machine === '控制机');
    const lifted = fillIn(
      controlBlock.lines.map((l) => l.text).join('\n'),
      [
        [/^OLD=<抄自货架机>$/m, 'OLD=0.1.13'],
        [/^STAMP=<抄自货架机>$/m, 'STAMP=20260812-0000'],
        // a --root that does not exist: upload must fail, and the credential
        // must NOT be uploaded afterwards as though nothing happened
        [/^BAK=\/srv\/yos-dist\.bak-\$OLD-\$STAMP.*$/m, 'BAK=/nonexistent-shelf-dir'],
        [/^METADIR=\/var\/backups\/yos-dist-\$OLD-\$STAMP\.meta.*$/m, `METADIR=${metadir}`],
        [/^SHELF=<货架机 ssh 目标>.*$/m, 'SHELF=not-used-in-test'],
        [/^REPO=<货架机上本仓库的目录>.*$/m, `REPO=${ROOT}`],
        [/^export COS_BUCKET=<桶名>\s+COS_REGION=<地域>$/m, 'export COS_BUCKET=b-1234567890 COS_REGION=ap-test'],
        [/\| ssh "\$SHELF" bash -s/, '| bash -s'],
      ],
    );

    const result = await runScript(lifted, {
      STS_ENDPOINT: `http://127.0.0.1:${stsPort}`,
      COS_ENDPOINT: `http://127.0.0.1:${cosPort}`,
      TENCENTCLOUD_SECRET_ID: 'long-lived-id',
      TENCENTCLOUD_SECRET_KEY: 'long-lived-key',
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/站外备份失败|停止发布/);
  });
});

/*
 * 小C's third round: the minted credential was redirected into
 * `/tmp/cos-creds.sh`, which a default umask makes 0644 — readable by every
 * account on the control machine — at a fixed name in a world-writable sticky
 * directory, where someone can plant a symlink first and receive the token.
 *
 * The fix was not to chmod it. A credential that is never a file has no mode to
 * get wrong, no name to squat, and no cleanup path to miss. These tests pin that
 * property against the document, because "we removed the file" is exactly the
 * kind of thing a later edit restores for convenience.
 */
describe('the minted credential never becomes a file', () => {
  /** Joins `\`-continued lines so a redirect split across lines is still seen. */
  function logicalLines(block) {
    return block.lines
      .map((l) => l.text)
      .join('\n')
      .replace(/\\\n\s*/g, ' ')
      .split('\n');
  }

  test('no command block redirects cos-sts-token.mjs into a file', () => {
    for (const block of extractCommandBlocks(DOC)) {
      for (const line of logicalLines(block)) {
        if (!line.includes('cos-sts-token.mjs')) continue;
        expect(line).not.toMatch(/>\s*\S/);
        expect(line).not.toMatch(/\btee\b/);
      }
    }
  });

  test('the runbook mentions no credential file path at all', () => {
    expect(DOC).not.toMatch(/cos-creds/);
  });

  test('every control-machine block that mints a credential clears it on both paths', () => {
    const credentialBlocks = extractCommandBlocks(DOC).filter((block) => {
      if (block.machine !== '控制机') return false;
      return block.lines.some((line) => line.text.includes('cos-sts-token.mjs'));
    });
    expect(credentialBlocks).toHaveLength(2);
    for (const block of credentialBlocks) {
      const text = block.lines.map((l) => l.text).join('\n');
      // once on the failure path inside `|| { … }`, once after success
      expect(text.match(/unset CREDS/g)?.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('control-machine blocks without credential minting need no fake cleanup', () => {
    const timerBlock = extractCommandBlocks(DOC).find((block) =>
      block.lines.some((line) => line.text.includes('install-shelf-auto-backup.mjs')),
    );
    expect(timerBlock?.machine).toBe('控制机');
    expect(timerBlock?.lines.map((line) => line.text).join('\n')).not.toContain('unset CREDS');
  });
});

describe('the one legacy shelf exception stays narrow in the runbook', () => {
  test('backup self-audit pins the exact legacy index only for 0.1.13', () => {
    expect(DOC).toMatch(
      /test "\$OLD" = "0\.1\.13"[\s\S]*?LEGACY_MODE="--allow-legacy-0\.1\.13 --expect-index-sha256 ea64d43821e814c12a7e83e90269dfc7b67e9ab6b1f8ef5d7dd838095b04f9c1"[\s\S]*?--local "\$BAK" --full \$LEGACY_MODE --json/,
    );
  });

  test('rollback sign-off omits buildId only inside the exact legacy branch', () => {
    expect(DOC).toMatch(
      /if test "\$OLD" = "0\.1\.13"; then[\s\S]*?LEGACY_MODE=--allow-legacy-0\.1\.13[\s\S]*?EXPECTED_VERSIONS="yos=0\.1\.13"[\s\S]*?test "\$OLDSHA" = "ea64d43821e814c12a7e83e90269dfc7b67e9ab6b1f8ef5d7dd838095b04f9c1"[\s\S]*?else[\s\S]*?BUILD_MODE="--expect-build-id \$OLDID"[\s\S]*?EXPECTED_VERSIONS="yos=\$OLD,feishu=<旧版本>,weixin=<旧版本>"[\s\S]*?--signoff --full/,
    );
  });

  test('the runbook records all three fields absent from the real legacy shelf', () => {
    expect(DOC).toMatch(/没有 buildId、publicationMode 和 capabilities\.json/);
    expect(DOC).not.toMatch(/有 `buildId` 和完整文件哈希/);
  });
});
