import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateUpgrade, MAX_EVAL_FILES, MAX_EVAL_FILE_LINES } from '../claude-eval.js';

/**
 * Why this file exists.
 *
 * This is the last thing a user reads before typing `y` on an upgrade that
 * overwrites files they have edited. Its output is advice, but the action it
 * precedes destroys work, so the failure that matters is not "wrong verdict" —
 * it is "looked complete when it wasn't".
 *
 * Three ways it could look complete without being complete, all silent until
 * 2026-08-27:
 *
 *   1. Only the first ten changed files were ever sent to the evaluator. The
 *      prompt mentioned the rest as a count; the returned object did not, so
 *      the caller printed ten tidy verdicts and no hint that fifteen other
 *      modified files were never looked at.
 *
 *   2. Files were truncated at 500 lines before being sent. A local change at
 *      line 900 was simply not in the evidence, and the file could still come
 *      back "safe" — a verdict about a section nobody read.
 *
 *   3. The verdict list was never reconciled against the file list. A file the
 *      model quietly omitted produced no line at all, which on screen is
 *      indistinguishable from a file that was never modified. An invented
 *      verdict string fell through to the caller's `else` branch.
 *
 * The rule these tests hold the module to: everything not examined is named in
 * the result, and nothing examined only in part is ever reported as plain safe.
 */

let dir;
let skillDir;
let tempDir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-eval-'));
  skillDir = path.join(dir, 'installed');
  tempDir = path.join(dir, 'incoming');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writePair(file, localBody, newBody) {
  const write = (root, body) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  if (localBody !== null) write(skillDir, localBody);
  if (newBody !== null) write(tempDir, newBody);
}

/** An evaluator that records its prompt and replies with whatever is scripted. */
function scriptedEvaluator(reply) {
  const seen = { prompts: [] };
  const run = async (prompt) => {
    seen.prompts.push(prompt);
    return typeof reply === 'function' ? reply(prompt) : reply;
  };
  return { run, seen };
}

const ok = (files, recommendation = 'looks fine') =>
  ({ ok: true, text: JSON.stringify({ safe: true, recommendation, files }) });

const verdict = (file, v = 'safe', reason = 'unrelated section') => ({ file, verdict: v, reason });

const changes = (modified = [], added = [], deleted = []) => ({ modified, added, deleted });

async function evaluate({ reply, localChanges, changelog = null }) {
  const evaluator = scriptedEvaluator(reply);
  const result = await evaluateUpgrade({
    component: 'wechat',
    localChanges,
    tempDir,
    skillDir,
    changelog,
    runEvaluator: evaluator.run,
  });
  return { result, seen: evaluator.seen };
}

describe('evaluateUpgrade — the ordinary path still works', () => {
  it('returns the per-file verdicts the evaluator gave', async () => {
    writePair('config.json', '{"a":1}', '{"a":2}');
    const { result } = await evaluate({
      localChanges: changes(['config.json']),
      reply: ok([verdict('config.json', 'safe', 'user config area')]),
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].verdict, 'safe');
    assert.equal(result.recommendation, 'looks fine');
  });

  it('passes both versions of each file to the evaluator', async () => {
    writePair('scripts/send.js', 'LOCAL_MARKER', 'NEW_MARKER');
    const { seen } = await evaluate({
      localChanges: changes(['scripts/send.js']),
      reply: ok([verdict('scripts/send.js')]),
    });

    assert.match(seen.prompts[0], /LOCAL_MARKER/);
    assert.match(seen.prompts[0], /NEW_MARKER/);
  });

  it('does not call the evaluator when nothing changed', async () => {
    const { result, seen } = await evaluate({
      localChanges: changes([], []),
      reply: ok([]),
    });
    assert.equal(result, null);
    assert.equal(seen.prompts.length, 0);
  });

  it('tolerates a caller that reports no deletions at all', async () => {
    writePair('a.js', 'x', 'y');
    const { result } = await evaluate({
      localChanges: { modified: ['a.js'], added: [] },
      reply: ok([verdict('a.js')]),
    });
    assert.ok(result, 'a missing `deleted` list is a caller shape we already produce elsewhere');
  });

  it('strips markdown fencing the model was asked not to use', async () => {
    writePair('a.js', 'x', 'y');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: { ok: true, text: '```json\n' + JSON.stringify({ safe: true, recommendation: 'r', files: [verdict('a.js')] }) + '\n```' },
    });
    assert.equal(result.files[0].verdict, 'safe');
  });
});

describe('evaluateUpgrade — what it did not look at has to be in the answer', () => {
  it('names the files it never sent, instead of only counting them in the prompt', async () => {
    const modified = [];
    for (let i = 0; i < 25; i++) {
      const f = `file-${String(i).padStart(2, '0')}.js`;
      writePair(f, `local ${i}`, `new ${i}`);
      modified.push(f);
    }

    const { result } = await evaluate({
      localChanges: changes(modified),
      reply: (prompt) => ok(
        modified.filter((f) => prompt.includes(`--- ${f} ---`)).map((f) => verdict(f))
      ),
    });

    assert.equal(result.analyzed, MAX_EVAL_FILES);
    assert.deepEqual(result.skippedFiles, modified.slice(MAX_EVAL_FILES),
      'a user about to overwrite 25 edited files must not be shown a clean report on 10 of them');
    assert.equal(result.complete, false);
  });

  it('says the analysis was complete when it really was', async () => {
    writePair('a.js', 'x', 'y');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: ok([verdict('a.js')]),
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.skippedFiles, []);
    assert.deepEqual(result.truncatedFiles, []);
  });

  it('names the files it could only read part of', async () => {
    const long = Array.from({ length: MAX_EVAL_FILE_LINES + 400 }, (_, i) => `line ${i}`).join('\n');
    writePair('big.js', long, long + '\nnew tail');
    writePair('small.js', 'a', 'b');

    const { result } = await evaluate({
      localChanges: changes(['big.js', 'small.js']),
      reply: ok([verdict('big.js'), verdict('small.js')]),
    });

    assert.deepEqual(result.truncatedFiles, ['big.js']);
    assert.equal(result.complete, false);
  });

  it('will not call a file safe when it only read part of it', async () => {
    const long = Array.from({ length: MAX_EVAL_FILE_LINES + 400 }, (_, i) => `line ${i}`).join('\n');
    writePair('big.js', long, long);

    const { result } = await evaluate({
      localChanges: changes(['big.js']),
      reply: ok([verdict('big.js', 'safe', 'no overlapping change')]),
    });

    const entry = result.files.find((f) => f.file === 'big.js');
    assert.equal(entry.verdict, 'warning',
      'a verdict of safe about a file whose second half was never sent is not a verdict');
    assert.match(entry.reason, /truncated at \d+ lines/i,
      'and the user has to be told why it was downgraded');
  });

  it('leaves an already-worrying verdict on a truncated file alone', async () => {
    const long = Array.from({ length: MAX_EVAL_FILE_LINES + 400 }, (_, i) => `line ${i}`).join('\n');
    writePair('big.js', long, long);

    const { result } = await evaluate({
      localChanges: changes(['big.js']),
      reply: ok([verdict('big.js', 'conflict', 'same function rewritten')]),
    });
    assert.equal(result.files.find((f) => f.file === 'big.js').verdict, 'conflict');
  });
});

describe('evaluateUpgrade — a verdict that never came back is not a pass', () => {
  it('fills in every requested file the evaluator did not rule on', async () => {
    writePair('a.js', '1', '2');
    writePair('b.js', '1', '2');
    writePair('c.js', '1', '2');

    const { result } = await evaluate({
      localChanges: changes(['a.js', 'b.js', 'c.js']),
      reply: ok([verdict('a.js')]), // b and c quietly dropped
    });

    const byFile = Object.fromEntries(result.files.map((f) => [f.file, f.verdict]));
    assert.equal(byFile['a.js'], 'safe');
    assert.equal(byFile['b.js'], 'unknown',
      'a file with no line printed looks exactly like a file that was never modified');
    assert.equal(byFile['c.js'], 'unknown');
    assert.equal(result.complete, false);
  });

  it('rejects a verdict word it does not recognise instead of passing it on', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: ok([verdict('a.js', 'probably-fine', 'looks ok')]),
    });
    assert.equal(result.files[0].verdict, 'unknown');
  });

  it('drops a verdict about a file nobody asked about', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: ok([verdict('a.js'), verdict('imaginary.js', 'safe', 'invented')]),
    });
    assert.deepEqual(result.files.map((f) => f.file), ['a.js']);
  });

  it('does not claim overall safety while anything is unresolved', async () => {
    writePair('a.js', '1', '2');
    writePair('b.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js', 'b.js']),
      reply: ok([verdict('a.js')]),
    });
    assert.equal(result.safe, false,
      'the model said safe: true, but it ruled on half the files');
  });

  it('keeps overall safety when every file really did come back safe', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: ok([verdict('a.js')]),
    });
    assert.equal(result.safe, true);
  });

  it('never reports safe when any file conflicts, whatever the model claimed', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: ok([verdict('a.js', 'conflict', 'same lines rewritten')]),
    });
    assert.equal(result.safe, false);
  });
});

describe('evaluateUpgrade — when the evaluator cannot be reached', () => {
  it('reports why, rather than returning a bare nothing', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: { ok: false, reason: 'claude: command not found' },
    });

    assert.equal(result.available, false);
    assert.match(result.reason, /command not found/,
      '"analysis skipped" reads as "we checked and it was fine" unless it says why');
    assert.deepEqual(result.unevaluatedFiles, ['a.js']);
    assert.equal(result.safe, false);
  });

  it('says so when the reply is not JSON at all', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: { ok: true, text: 'Sure! Here is my analysis: everything looks great.' },
    });
    assert.equal(result.available, false);
    assert.match(result.reason, /pars|json/i);
  });

  it('says so when the JSON is the wrong shape', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: { ok: true, text: JSON.stringify({ verdicts: [] }) },
    });
    assert.equal(result.available, false);
  });

  it('never turns an unreachable evaluator into an all-clear', async () => {
    writePair('a.js', '1', '2');
    for (const reply of [
      { ok: false, reason: 'timed out' },
      { ok: true, text: '' },
      { ok: true, text: '{}' },
      { ok: true, text: JSON.stringify({ safe: true, recommendation: 'ok', files: 'not-an-array' }) },
    ]) {
      const { result } = await evaluate({ localChanges: changes(['a.js']), reply });
      assert.equal(result.safe, false, `an all-clear leaked out of ${JSON.stringify(reply)}`);
      assert.equal(result.available, false);
    }
  });

  it('survives an evaluator that throws', async () => {
    writePair('a.js', '1', '2');
    const { result } = await evaluate({
      localChanges: changes(['a.js']),
      reply: () => { throw new Error('spawn EACCES'); },
    });
    assert.equal(result.available, false);
    assert.match(result.reason, /EACCES/);
  });
});

describe('evaluateUpgrade — deleted files', () => {
  it('tells the evaluator the user removed a file the upgrade still ships', async () => {
    writePair('kept.js', 'a', 'b');
    writePair('gone.js', null, 'still here upstream');
    const { seen } = await evaluate({
      localChanges: changes(['kept.js'], [], ['gone.js']),
      reply: ok([verdict('kept.js'), verdict('gone.js', 'warning', 'user removed it')]),
    });
    assert.match(seen.prompts[0], /gone\.js/);
    assert.match(seen.prompts[0], /deleted by user/);
  });

  it('does not run an evaluation for deletions alone', async () => {
    writePair('gone.js', null, 'still here upstream');
    const { result, seen } = await evaluate({
      localChanges: changes([], [], ['gone.js']),
      reply: ok([]),
    });
    // Deliberate, and matched by the caller in cli/commands/component.js, which
    // only evaluates when something was modified or added. A file the user
    // deleted and the upgrade restores is a surprise, not lost work, and it is
    // not worth a `claude --print` round trip of its own.
    assert.equal(result, null);
    assert.equal(seen.prompts.length, 0);
  });

  it('counts deletions towards the file budget too', async () => {
    const modified = [];
    for (let i = 0; i < MAX_EVAL_FILES; i++) {
      const f = `m-${i}.js`;
      writePair(f, 'a', 'b');
      modified.push(f);
    }
    writePair('gone.js', null, 'upstream');

    const { result } = await evaluate({
      localChanges: changes(modified, [], ['gone.js']),
      reply: (prompt) => ok(modified.filter((f) => prompt.includes(`--- ${f} ---`)).map((f) => verdict(f))),
    });

    assert.ok(result.skippedFiles.includes('gone.js'), 'a deletion nobody looked at is still a deletion nobody looked at');
  });
});

/**
 * TD-271 discipline: naming the unexamined files inside the result object
 * changes nothing unless the screen the user actually reads shows them.
 */
describe('the report a user actually sees', () => {
  it('puts the files nobody looked at on screen', async () => {
    const { formatEvalReport } = await import('../../commands/component.js');
    const lines = formatEvalReport({
      available: true,
      complete: false,
      recommendation: 'looks fine',
      files: [{ file: 'a.js', verdict: 'safe', reason: 'unrelated' }],
      skippedFiles: ['b.js', 'c.js'],
      truncatedFiles: [],
    }).join('\n');

    assert.match(lines, /NOT examined/);
    assert.match(lines, /b\.js/);
    assert.match(lines, /c\.js/);
    assert.match(lines, /incomplete/i,
      'a screen of green verdicts must not be the last word when two files were never read');
  });

  it('marks a file the evaluator would not rule on', async () => {
    const { formatEvalReport } = await import('../../commands/component.js');
    const lines = formatEvalReport({
      available: true, complete: false, recommendation: 'r',
      files: [{ file: 'a.js', verdict: 'unknown', reason: 'the evaluator did not rule on this file' }],
      skippedFiles: [], truncatedFiles: [],
    }).join('\n');
    assert.match(lines, /NOT ASSESSED/);
  });

  it('says why there is no analysis instead of printing nothing', async () => {
    const { formatEvalReport } = await import('../../commands/component.js');
    const lines = formatEvalReport({
      available: false,
      reason: 'claude: command not found',
      unevaluatedFiles: ['a.js', 'b.js'],
    }).join('\n');
    assert.match(lines, /command not found/);
    assert.match(lines, /No file was assessed/);
    assert.match(lines, /a\.js/);
  });

  it('stays quiet about coverage when coverage was total', async () => {
    const { formatEvalReport } = await import('../../commands/component.js');
    const lines = formatEvalReport({
      available: true, complete: true, recommendation: 'all good',
      files: [{ file: 'a.js', verdict: 'safe', reason: 'unrelated' }],
      skippedFiles: [], truncatedFiles: [],
    }).join('\n');
    assert.doesNotMatch(lines, /NOT examined/);
    assert.doesNotMatch(lines, /incomplete/i);
  });
});
