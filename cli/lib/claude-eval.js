/**
 * Claude-powered evaluation of local modifications during component upgrades.
 *
 * Uses `claude --print` to assess whether an upgrade is safe given the user's
 * local changes, producing per-file verdicts (safe / warning / conflict).
 *
 * This is the last thing a user reads before typing `y` on an operation that
 * overwrites files they have edited, so the failure that matters here is not a
 * wrong verdict — it is an analysis that *looked* complete when it wasn't.
 * Three of those were possible until 2026-08-27: only the first ten changed
 * files were ever sent, files were truncated at 500 lines before being sent,
 * and the returned verdicts were never reconciled against the files that were
 * asked about. All three produced a tidy screen of green with no hint of what
 * had not been examined.
 *
 * So the contract this module now keeps, pinned by __tests__/claude-eval.test.js:
 *
 *   - Everything not examined is named in the result — `skippedFiles`,
 *     `truncatedFiles`, `unevaluatedFiles`, and a single `complete` flag.
 *   - Nothing examined only in part is ever reported as plain `safe`.
 *   - A file that was asked about and not ruled on comes back `unknown`, never
 *     absent — an absent line on screen is indistinguishable from a file that
 *     was never modified.
 *   - `safe` is a conclusion about the whole set, not a field the model gets to
 *     assert: it is false whenever anything is unresolved.
 *   - An evaluator that could not be reached says why (`available: false`,
 *     `reason`), because "analysis skipped" reads as reassurance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseSkillMd } from './skill.js';

export const MAX_EVAL_FILE_LINES = 500;
export const MAX_EVAL_FILES = 10;
const TIMEOUT_MS = 60_000;

const VERDICTS = new Set(['safe', 'warning', 'conflict']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @returns {{text: string|null, truncated: boolean}} — `truncated` is what makes
 *   the difference between a verdict and a guess, so it travels with the text.
 */
function truncateLines(content, max) {
  if (!content) return { text: content, truncated: false };
  const lines = content.split('\n');
  if (lines.length <= max) return { text: content, truncated: false };
  return {
    text: lines.slice(0, max).join('\n') + `\n... (truncated, ${lines.length - max} more lines)`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Build diff context
// ---------------------------------------------------------------------------

function buildDiffContext(localChanges, skillDir, tempDir) {
  const diffs = [];
  const modified = localChanges.modified || [];
  const added = localChanges.added || [];
  const deleted = localChanges.deleted || [];

  const present = [...modified, ...added];
  const requested = [...present, ...deleted];

  for (const file of present.slice(0, MAX_EVAL_FILES)) {
    const local = truncateLines(readFileSafe(path.join(skillDir, file)), MAX_EVAL_FILE_LINES);
    const upstream = truncateLines(readFileSafe(path.join(tempDir, file)), MAX_EVAL_FILE_LINES);
    diffs.push({
      file,
      local: local.text,
      new: upstream.text,
      truncated: local.truncated || upstream.truncated,
    });
  }

  // Note deleted files (exist in new but removed locally)
  for (const file of deleted.slice(0, Math.max(0, MAX_EVAL_FILES - diffs.length))) {
    const upstream = truncateLines(readFileSafe(path.join(tempDir, file)), MAX_EVAL_FILE_LINES);
    diffs.push({
      file,
      local: null,
      new: upstream.text,
      truncated: upstream.truncated,
    });
  }

  const examined = new Set(diffs.map((d) => d.file));
  return {
    diffs,
    requested,
    // Named, not counted. A count cannot be printed next to the file it is about.
    skippedFiles: requested.filter((f) => !examined.has(f)),
    truncatedFiles: diffs.filter((d) => d.truncated).map((d) => d.file),
  };
}

// ---------------------------------------------------------------------------
// Construct prompt
// ---------------------------------------------------------------------------

function buildPrompt({ component, diffs, skippedFiles, changelog, preserveList }) {
  const changelogSnippet = changelog
    ? changelog.slice(0, 2000)
    : '(no changelog available)';

  const preserveNote = preserveList.length > 0
    ? `\nPreserved files (excluded from overwrite during upgrade): ${preserveList.join(', ')}\n`
    : '';

  let fileSection = '';
  for (const d of diffs) {
    fileSection += `\n--- ${d.file} ---\n`;
    if (d.local !== null) {
      fileSection += `[LOCAL]\n${d.local}\n`;
    } else {
      fileSection += `[LOCAL] (file deleted by user)\n`;
    }
    if (d.new !== null) {
      fileSection += `[NEW]\n${d.new}\n`;
    } else {
      fileSection += `[NEW] (file does not exist in upgrade)\n`;
    }
  }

  if (skippedFiles.length > 0) {
    fileSection += `\n(... and ${skippedFiles.length} more changed files not shown: ${skippedFiles.join(', ')})\n`;
  }

  return `You are evaluating whether a component upgrade is safe given local modifications.

Component: ${component}
Changelog:
${changelogSnippet}
${preserveNote}
The following files have local modifications. For each, the LOCAL version (user's current) and NEW version (from upgrade) are shown.
${fileSection}
Evaluate each modified file and respond in JSON:
{
  "safe": boolean,
  "recommendation": "one-line summary",
  "files": [
    { "file": "...", "verdict": "safe|warning|conflict", "reason": "..." }
  ]
}

Rules:
- "safe": file is in the preserve list (never overwritten), or local change is in a config/user area, or new version did not change the same section
- "warning": new version changed related areas, user should review after upgrade
- "conflict": new version changed the exact same code the user modified — data loss risk
- Give a verdict for every file shown above, even if the answer is obvious
- Keep reasons concise (one sentence each)
- Respond ONLY with the JSON object, no markdown fencing`;
}

// ---------------------------------------------------------------------------
// Call Claude CLI
// ---------------------------------------------------------------------------

/**
 * Run the evaluator.
 *
 * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
 *   The reason matters: "analysis skipped" with no explanation reads as
 *   reassurance, and the caller cannot explain what it was not told.
 */
function callClaude(prompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn('claude', ['--print', '--output-format', 'text'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      resolve({ ok: false, reason: `could not start claude: ${err?.message || err}` });
      return;
    }

    child.stdin.on('error', () => {}); // Ignore EPIPE if child exits early
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk; });

    child.on('error', (err) => {
      settle({ ok: false, reason: `could not run claude: ${err?.message || err}` });
    });

    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, reason: `claude did not answer within ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle({ ok: true, text: stdout });
        return;
      }
      const detail = stderr.trim().split('\n').slice(-1)[0] || `exit code ${code}`;
      settle({ ok: false, reason: `claude failed: ${detail}` });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Parse response
// ---------------------------------------------------------------------------

/** @returns {{ok: true, value: object} | {ok: false, reason: string}} */
function parseResponse(raw) {
  if (!raw || !raw.trim()) return { ok: false, reason: 'the evaluator returned nothing to parse' };

  // Strip markdown fencing if present despite instructions
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the evaluator did not answer in JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files) || !parsed.recommendation) {
    return { ok: false, reason: 'the evaluator answered in JSON but not in the shape asked for' };
  }
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Turn the model's answer into one line per file that was asked about.
 *
 * Files it skipped, invented, or labelled with a word we do not recognise are
 * all resolved here rather than left for the caller's rendering to guess at.
 */
function reconcile({ requested, diffs, parsed }) {
  const truncated = new Set(diffs.filter((d) => d.truncated).map((d) => d.file));
  const examined = new Set(diffs.map((d) => d.file));
  const byFile = new Map();

  for (const entry of parsed.files) {
    if (!entry || typeof entry.file !== 'string') continue;
    if (!examined.has(entry.file)) continue; // a verdict about a file nobody sent
    const known = VERDICTS.has(entry.verdict);
    byFile.set(entry.file, {
      file: entry.file,
      verdict: known ? entry.verdict : 'unknown',
      reason: known
        ? String(entry.reason || '').trim() || 'no reason given'
        : `the evaluator answered "${entry.verdict}", which is not a verdict this tool understands`,
    });
  }

  const files = [];
  for (const file of requested) {
    let entry = byFile.get(file);

    if (!entry) {
      files.push({
        file,
        verdict: 'unknown',
        reason: examined.has(file)
          ? 'the evaluator did not rule on this file'
          : 'this file was not sent for evaluation',
      });
      continue;
    }

    // A verdict of "safe" about a file whose tail was never sent is not a
    // verdict. Anything already more worried than safe is left alone.
    if (entry.verdict === 'safe' && truncated.has(file)) {
      entry = {
        ...entry,
        verdict: 'warning',
        reason: `${entry.reason} (downgraded: the file was truncated at ${MAX_EVAL_FILE_LINES} lines before evaluation, so the rest was never seen)`,
      };
    }
    files.push(entry);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether an upgrade is safe given local modifications.
 *
 * @param {object} opts
 * @param {string} opts.component  - Component name
 * @param {object} opts.localChanges - { modified: string[], added: string[], deleted?: string[] }
 * @param {string} opts.tempDir    - Path to downloaded new version
 * @param {string} opts.skillDir   - Path to installed component
 * @param {string|null} opts.changelog - Changelog text (may be null)
 * @param {Function} [opts.runEvaluator] - Evaluator injection point (tests)
 * @returns {Promise<object|null>} null when there is nothing to evaluate.
 *   Otherwise always an object, and always one that admits what it does not
 *   know:
 *     { available, reason, safe, complete, recommendation, files,
 *       analyzed, skippedFiles, truncatedFiles, unevaluatedFiles }
 */
export async function evaluateUpgrade({
  component,
  localChanges,
  tempDir,
  skillDir,
  changelog,
  runEvaluator = callClaude,
}) {
  // Nothing to evaluate
  if (!localChanges) return null;
  const totalFiles = (localChanges.modified?.length || 0) + (localChanges.added?.length || 0);
  if (totalFiles === 0) return null;

  const { diffs, requested, skippedFiles, truncatedFiles } = buildDiffContext(localChanges, skillDir, tempDir);
  if (diffs.length === 0) return null;

  // Read preserve list from new SKILL.md (preserved files are never overwritten)
  const newSkill = parseSkillMd(tempDir);
  const preserveList = newSkill?.frontmatter?.lifecycle?.preserve || [];

  const prompt = buildPrompt({ component, diffs, skippedFiles, changelog, preserveList });

  let response;
  try {
    response = await runEvaluator(prompt);
  } catch (err) {
    response = { ok: false, reason: `the evaluator could not be run: ${err?.message || err}` };
  }

  const unavailable = (reason) => ({
    available: false,
    reason,
    safe: false,
    complete: false,
    recommendation: `Upgrade analysis unavailable — ${reason}. Review your local changes yourself before upgrading.`,
    files: [],
    analyzed: 0,
    skippedFiles,
    truncatedFiles,
    unevaluatedFiles: requested,
  });

  if (!response?.ok) return unavailable(response?.reason || 'the evaluator was not reachable');

  const parsed = parseResponse(response.text);
  if (!parsed.ok) return unavailable(parsed.reason);

  const files = reconcile({ requested, diffs, parsed: parsed.value });
  const unresolved = files.filter((f) => f.verdict === 'unknown').map((f) => f.file);
  const complete = unresolved.length === 0 && skippedFiles.length === 0 && truncatedFiles.length === 0;

  return {
    available: true,
    reason: null,
    // A conclusion about the whole set, not a field the model gets to assert.
    safe: complete && files.every((f) => f.verdict === 'safe'),
    complete,
    recommendation: String(parsed.value.recommendation),
    files,
    analyzed: diffs.length,
    skippedFiles,
    truncatedFiles,
    unevaluatedFiles: unresolved,
  };
}
