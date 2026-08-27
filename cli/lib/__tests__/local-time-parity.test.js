import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const SOURCE_OF_TRUTH = path.join(REPO_ROOT, 'cli', 'lib', 'local-time.js');

// Skills are deployed to ~/yos/.claude/skills/ as standalone units and cannot
// import from the CLI package, so each carries its own copy — the same
// arrangement RESTART_FLOOR lives with. Copies rot silently unless something
// fails red, which is this file's only job.
const COPIES = [
  'skills/activity-monitor/scripts/local-time.js',
  'skills/comm-bridge/scripts/local-time.js',
  'skills/upgrade-claude/scripts/local-time.js',
].map((rel) => path.join(REPO_ROOT, rel));

function functionBodyOf(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const marker = 'export function formatLocalTimestamp';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${filePath} must export formatLocalTimestamp`);
  // Comments legitimately differ (each copy says it is a copy); the code must not.
  return source.slice(start).replace(/\s+/g, ' ').trim();
}

describe('local-time copies stay in parity with cli/lib/local-time.js', () => {
  const expected = functionBodyOf(SOURCE_OF_TRUTH);

  for (const copy of COPIES) {
    const label = path.relative(REPO_ROOT, copy);

    it(`${label} is byte-identical in its implementation`, () => {
      assert.equal(
        functionBodyOf(copy), expected,
        `${label} has drifted from cli/lib/local-time.js — update both or neither`
      );
    });

    it(`${label} actually behaves like the original`, () => {
      // Behaviour, not just text: a copy could be edited into something that
      // still parses. Pin a fixed instant in a fixed zone across both.
      const run = (modulePath) => {
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', `
            import { formatLocalTimestamp } from ${JSON.stringify(modulePath)};
            process.stdout.write(formatLocalTimestamp(1787802097000));
          `],
          { env: { ...process.env, TZ: 'Asia/Shanghai' }, encoding: 'utf8', cwd: REPO_ROOT }
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      assert.equal(run(copy), run(SOURCE_OF_TRUTH));
    });
  }

  it('no shipped code formats a human timestamp as UTC any more', () => {
    // The exact pattern this whole change removes. If it reappears anywhere in
    // shipped code, it is another clock that lies to whoever reads it.
    const result = spawnSync(
      'git',
      ['grep', '-n', "toISOString().replace('T', ' ')", '--', 'cli', 'skills'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const offenders = (result.stdout || '')
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes('__tests__'))
      .filter((line) => !line.includes('local-time.js'));

    assert.deepEqual(
      offenders, [],
      `UTC rendered as a local timestamp:\n${offenders.join('\n')}`
    );
  });
});
