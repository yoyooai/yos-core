import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { CodexContextMonitor } from '../codex-context-monitor.js';

import { makeTempDir } from '../../../../test/helpers/temp-dir.js';

/**
 * Why this file exists.
 *
 * On a Codex machine this class is the sole source of "how full is the context".
 * If it hands back a wrong number, or a number the base class has to throw away,
 * the session is never rotated and the agent grinds into its own context wall.
 * Until 2026-08-27 nothing tested it, and it had no seam to test through.
 *
 * The one behaviour change here: a `token_count` event whose `input_tokens` is
 * missing or unusable used to be returned anyway (`!= null` let through strings,
 * and nothing rejected a negative). The base class then had to discard it, so
 * the monitor stayed blind for as long as that event sat in the tail — even
 * though a perfectly good reading was one line further up.
 */

let dir;
let sessionsDay;

beforeEach(() => {
  dir = makeTempDir('codex-ctx-');
  sessionsDay = path.join(dir, 'sessions', '2026', '08', '27');
  fs.mkdirSync(sessionsDay, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = 1_787_802_097_000; // fixed instant; _startTime derives from it

/** A token_count rollout event. */
function tokenCount({ used, ceiling } = {}) {
  const info = {};
  if (used !== undefined) info.last_token_usage = { input_tokens: used };
  if (ceiling !== undefined) info.model_context_window = ceiling;
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info } });
}

/** Write a rollout file and return its path, stamped as active. */
function writeRollout(lines, { name = 'rollout-2026-08-27T10-00-00.jsonl' } = {}) {
  const file = path.join(sessionsDay, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  // Mtime must be at or after the monitor's start time to count as active.
  const after = new Date(NOW_MS + 5_000);
  fs.utimesSync(file, after, after);
  return file;
}

function writeModelsCache(models) {
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ models }));
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.sqlite] - stands in for the sqlite3 CLI; throws by default
 */
function monitor({ sqlite, ...rest } = {}) {
  return new CodexContextMonitor({
    codexDir: dir,
    now: () => NOW_MS,
    execFileSyncImpl: sqlite ?? (() => { throw new Error('sqlite3: not found'); }),
    ...rest,
  });
}

describe('CodexContextMonitor — reading the rollout tail', () => {
  it('reports the most recent turn and the ceiling that came with it', async () => {
    writeRollout([
      tokenCount({ used: 10_000, ceiling: 272_000 }),
      tokenCount({ used: 91_000, ceiling: 272_000 }),
    ]);
    assert.deepEqual(await monitor().getUsage(), { used: 91_000, ceiling: 272_000 });
  });

  it('ignores non-token_count events between turns', async () => {
    writeRollout([
      tokenCount({ used: 91_000, ceiling: 272_000 }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    ]);
    assert.deepEqual(await monitor().getUsage(), { used: 91_000, ceiling: 272_000 });
  });

  it('survives the half line the 64KB tail read starts on', async () => {
    writeRollout([
      '{"type":"event_msg","payload":{"type":"token_c',
      tokenCount({ used: 42_000, ceiling: 272_000 }),
    ]);
    assert.deepEqual(await monitor().getUsage(), { used: 42_000, ceiling: 272_000 });
  });

  it('keeps scanning past a token_count event with no usable count', async () => {
    writeRollout([
      tokenCount({ used: 88_000, ceiling: 272_000 }),
      tokenCount({ ceiling: 272_000 }),            // info present, count absent
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
    ]);
    assert.deepEqual(
      await monitor().getUsage(), { used: 88_000, ceiling: 272_000 },
      'one turn stale and true beats blind'
    );
  });

  for (const bad of ['91000', null, -1, {}]) {
    it(`refuses ${JSON.stringify(bad)} as a token count and keeps looking`, async () => {
      writeRollout([
        tokenCount({ used: 70_000, ceiling: 272_000 }),
        tokenCount({ used: bad, ceiling: 272_000 }),
      ]);
      assert.deepEqual(await monitor().getUsage(), { used: 70_000, ceiling: 272_000 });
    });
  }

  it('falls back to the model cache when the event carries no ceiling', async () => {
    writeModelsCache([{ slug: 'gpt-5-codex', context_window: 400_000, effective_context_window_percent: 90 }]);
    writeRollout([tokenCount({ used: 50_000 })]);
    assert.deepEqual(await monitor().getUsage(), { used: 50_000, ceiling: 360_000 });
  });

  it('falls back when the event ceiling is zero rather than dividing by it', async () => {
    writeModelsCache([{ slug: 'gpt-5-codex', context_window: 272_000 }]);
    writeRollout([tokenCount({ used: 50_000, ceiling: 0 })]);
    assert.deepEqual(await monitor().getUsage(), { used: 50_000, ceiling: 272_000 });
  });

  it('accepts a zero-token turn as a real reading', async () => {
    writeRollout([tokenCount({ used: 0, ceiling: 272_000 })]);
    assert.deepEqual(await monitor().getUsage(), { used: 0, ceiling: 272_000 });
  });

  it('returns null for an empty rollout file', async () => {
    writeRollout(['']);
    assert.equal(await monitor().getUsage(), null);
  });

  it('ignores rollout files left behind by an earlier run', async () => {
    const file = writeRollout([tokenCount({ used: 91_000, ceiling: 272_000 })]);
    const before = new Date(NOW_MS - 3_600_000);
    fs.utimesSync(file, before, before);
    assert.equal(
      await monitor().getUsage(), null,
      'a previous session\'s fill is not this session\'s fill'
    );
  });

  it('returns null when there is no sessions directory at all', async () => {
    fs.rmSync(path.join(dir, 'sessions'), { recursive: true, force: true });
    assert.equal(await monitor().getUsage(), null);
  });
});

describe('CodexContextMonitor — sqlite3 path', () => {
  it('prefers the rollout path sqlite3 reports over the filesystem scan', async () => {
    const chosen = writeRollout([tokenCount({ used: 5_000, ceiling: 272_000 })], { name: 'rollout-a.jsonl' });
    writeRollout([tokenCount({ used: 99_000, ceiling: 272_000 })], { name: 'rollout-b.jsonl' });

    const usage = await monitor({ sqlite: () => `${chosen}\n` }).getUsage();
    assert.deepEqual(usage, { used: 5_000, ceiling: 272_000 });
  });

  it('falls back to tokens_used when no rollout file can be read', async () => {
    writeModelsCache([{ slug: 'gpt-5-codex', context_window: 272_000 }]);
    fs.rmSync(path.join(dir, 'sessions'), { recursive: true, force: true });

    const usage = await monitor({ sqlite: () => '123456\n' }).getUsage();
    assert.deepEqual(usage, { used: 123_456, ceiling: 272_000 });
  });

  it('returns null rather than NaN when tokens_used is not a number', async () => {
    fs.rmSync(path.join(dir, 'sessions'), { recursive: true, force: true });
    assert.equal(await monitor({ sqlite: () => 'null\n' }).getUsage(), null);
  });

  it('returns null when sqlite3 answers with nothing', async () => {
    fs.rmSync(path.join(dir, 'sessions'), { recursive: true, force: true });
    assert.equal(await monitor({ sqlite: () => '\n' }).getUsage(), null);
  });

  it('works with no sqlite3 installed at all', async () => {
    writeRollout([tokenCount({ used: 7_000, ceiling: 272_000 })]);
    assert.deepEqual(await monitor().getUsage(), { used: 7_000, ceiling: 272_000 });
  });

  it('asks only about threads touched since it started', async () => {
    const seen = [];
    const m = monitor({ sqlite: (_cmd, args) => { seen.push(args[1]); return ''; } });
    await m.getUsage();
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((sql) => sql.includes(`updated_at >= ${Math.floor(NOW_MS / 1000)}`)),
      'the start-time filter is what keeps a previous run out of the reading'
    );
  });
});

describe('CodexContextMonitor — the ceiling fallback chain', () => {
  it('applies effective_context_window_percent', () => {
    writeModelsCache([{ slug: 'a', context_window: 200_000, effective_context_window_percent: 75 }]);
    assert.equal(monitor()._getModelCeiling(), 150_000);
  });

  it('treats a missing percent as 100', () => {
    writeModelsCache([{ slug: 'a', context_window: 200_000 }]);
    assert.equal(monitor()._getModelCeiling(), 200_000);
  });

  it('picks the requested model, not whichever came first', () => {
    writeModelsCache([
      { slug: 'gpt-5', context_window: 400_000 },
      { slug: 'gpt-5-codex', context_window: 272_000 },
    ]);
    assert.equal(monitor({ model: 'gpt-5-codex' })._getModelCeiling(), 272_000);
  });

  it('falls back to 128K when the cache is missing', () => {
    assert.equal(monitor()._getModelCeiling(), 128_000);
  });

  it('falls back to 128K when the cache is malformed', () => {
    fs.writeFileSync(path.join(dir, 'models_cache.json'), '{ this is not json');
    assert.equal(monitor()._getModelCeiling(), 128_000);
  });

  it('falls back to 128K when the cache has no usable window', () => {
    writeModelsCache([{ slug: 'a', context_window: 0 }]);
    assert.equal(monitor()._getModelCeiling(), 128_000);
  });

  it('never returns something the base class would have to discard', () => {
    for (const models of [[], [{}], [{ context_window: 'big' }], null]) {
      fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ models }));
      const ceiling = monitor()._getModelCeiling();
      assert.ok(Number.isFinite(ceiling) && ceiling > 0, `unusable ceiling for ${JSON.stringify(models)}`);
    }
  });
});

describe('CodexContextMonitor — what the base class then does with it', () => {
  it('turns a real reading into a ratio', async () => {
    writeRollout([tokenCount({ used: 136_000, ceiling: 272_000 })]);
    assert.deepEqual(await monitor().check(), { used: 136_000, ceiling: 272_000, ratio: 0.5 });
  });

  it('reports no data rather than a ratio when the session cannot be found', async () => {
    fs.rmSync(path.join(dir, 'sessions'), { recursive: true, force: true });
    assert.equal(await monitor().check(), null);
  });
});
