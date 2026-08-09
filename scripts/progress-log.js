import fs from 'node:fs';
import path from 'node:path';

/**
 * The development progress log (docs/progress.md) is the one place a person can
 * read in five minutes to learn where the product actually got to. It only stays
 * that way if every release lands a row in it.
 *
 * "Everyone should keep maintaining it" is a good sentence, and a good sentence
 * in a document never failed a build. So the rule is mechanical instead: the
 * newest row in the node table has to name the version in package.json, or
 * `npm run verify` goes red and the release does not ship.
 *
 * Deliberately narrow: this checks that the log was updated and that its rows
 * are well formed and in order. It does not grade the prose — that is a review
 * job, not a gate's.
 */

export const PROGRESS_LOG_PATH = path.join('docs', 'progress.md');

const START_MARKER = '<!-- progress-log:start -->';
const END_MARKER = '<!-- progress-log:end -->';

// | `0.1.13` | 2026-08-09 | `181e1d3` | one sentence |
const ROW = /^\|\s*`([^`|]+)`\s*\|\s*([^|]+?)\s*\|\s*`([^`|]+)`\s*\|\s*(.+?)\s*\|$/;
const SEPARATOR_ROW = /^\|[\s:|-]+\|$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// A row that says nothing is the same as no row. These are the shapes an empty
// row actually takes when someone is in a hurry.
const PLACEHOLDER = /^(tbd|todo|n\/a|-{1,}|待填|待补|同上)$/i;
const MINIMUM_SUMMARY_LENGTH = 8;

function splitVersion(version) {
  const [core, prerelease = ''] = version.split(/-(.+)/);
  return {
    numbers: core.split('.').map(Number),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

/**
 * Semver precedence, enough of it for our own version line: numeric parts
 * compare numerically, and a version WITH a prerelease sorts below the same
 * version without one (0.1.0-alpha.6 < 0.1.0).
 *
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a, b) {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (bothNumeric) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Pull the node table out of the progress log.
 *
 * @param {string} source - full contents of docs/progress.md
 * @returns {{version: string, date: string, commit: string, summary: string}[]} newest first
 */
export function parseProgressLog(source) {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1) {
    throw new Error(
      `${PROGRESS_LOG_PATH}: could not find the node table between ${START_MARKER} and ${END_MARKER}`
    );
  }
  if (end < start) {
    throw new Error(`${PROGRESS_LOG_PATH}: node table markers are in the wrong order`);
  }

  const rows = [];
  const seen = new Set();
  const block = source.slice(start + START_MARKER.length, end).split('\n');

  for (const rawLine of block) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (SEPARATOR_ROW.test(line)) continue;
    // The header row carries no backticks, so ROW does not match it.
    const match = ROW.exec(line);
    if (!match) {
      if (/^\|\s*版本\s*\|/.test(line)) continue;
      throw new Error(
        `${PROGRESS_LOG_PATH}: malformed node table row: ${line}\n`
        + 'expected: | `<version>` | <YYYY-MM-DD> | `<commit>` | <one sentence> |'
      );
    }
    const [, version, date, commit, summary] = match;
    if (!VERSION.test(version)) {
      throw new Error(`${PROGRESS_LOG_PATH}: "${version}" is not a version number`);
    }
    if (!DATE.test(date)) {
      throw new Error(`${PROGRESS_LOG_PATH}: ${version}: "${date}" is not a YYYY-MM-DD date`);
    }
    if (!COMMIT.test(commit)) {
      throw new Error(`${PROGRESS_LOG_PATH}: ${version}: "${commit}" is not a commit id`);
    }
    if (PLACEHOLDER.test(summary) || summary.length < MINIMUM_SUMMARY_LENGTH) {
      throw new Error(
        `${PROGRESS_LOG_PATH}: ${version}: say what this release solved; `
        + `"${summary}" is a placeholder, and a placeholder row is the same as no row`
      );
    }
    if (seen.has(version)) {
      throw new Error(`${PROGRESS_LOG_PATH}: ${version} appears twice in the node table`);
    }
    seen.add(version);
    rows.push({ version, date, commit, summary });
  }

  if (rows.length === 0) {
    throw new Error(`${PROGRESS_LOG_PATH}: the node table has no entries`);
  }

  for (let i = 1; i < rows.length; i += 1) {
    if (compareVersions(rows[i - 1].version, rows[i].version) <= 0) {
      throw new Error(
        `${PROGRESS_LOG_PATH}: the node table must run newest to oldest, `
        + `but ${rows[i - 1].version} is listed above ${rows[i].version}`
      );
    }
  }

  return rows;
}

/**
 * The gate itself: the released version must be the newest row.
 *
 * @param {string} root - repository root
 * @returns {{entries: number, version: string}}
 */
export function verifyProgressLog(root) {
  const logPath = path.join(root, PROGRESS_LOG_PATH);
  if (!fs.existsSync(logPath)) {
    throw new Error(`missing ${PROGRESS_LOG_PATH}: the development progress log is not optional`);
  }
  const rows = parseProgressLog(fs.readFileSync(logPath, 'utf8'));

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`could not read package.json: ${error.message}`);
  }
  const released = manifest.version;
  if (typeof released !== 'string' || !VERSION.test(released)) {
    throw new Error(`package.json version "${released}" is not a version number`);
  }

  if (rows[0].version !== released) {
    throw new Error(
      `${PROGRESS_LOG_PATH} is behind the release: package.json is ${released}, `
      + `but the newest row in the node table is ${rows[0].version}. `
      + 'Add a row for this version — one line saying what it solved — before shipping.'
    );
  }

  return { entries: rows.length, version: released };
}
