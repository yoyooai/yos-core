/**
 * Turns a TAP stream from `node --test` into a short, human-readable list of
 * which tests failed and where they live.
 *
 * Why this exists: the raw TAP for the full suite is tens of thousands of
 * lines. When one test out of ~1200 goes red, the `not ok` line scrolls out of
 * the terminal and the run is over — leaving "the suite went red once and I
 * cannot tell which test it was". An unidentifiable red is worse than no test
 * at all, because it trains people to ignore red.
 */

const NOT_OK = /^(\s*)not ok \d+ - (.*)$/;
const LOCATION = /^\s*location:\s*'(.+)'\s*$/;
const ERROR_START = /^\s*error:\s*(.*)$/;
const SUBTEST = /^(\s*)# Subtest: (.*)$/;
// A todo/skip directive on a `not ok` line is not a failure.
const NOT_A_FAILURE = /#\s*(TODO|SKIP)\b/i;

/**
 * @param {string} tapText raw TAP output
 * @returns {{failures: Array<{name: string, path: string[], location: string|null, error: string|null}>, reportedFailCount: number|null}}
 */
export function summarizeTapFailures(tapText) {
  const lines = String(tapText ?? '').split('\n');
  const failures = [];
  /** @type {Array<{indent: number, name: string}>} */
  const openSubtests = [];
  let reportedFailCount = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const failCount = /^# fail (\d+)$/.exec(line);
    if (failCount) {
      reportedFailCount = Number(failCount[1]);
      continue;
    }

    const subtest = SUBTEST.exec(line);
    if (subtest) {
      const indent = subtest[1].length;
      while (openSubtests.length > 0 && openSubtests[openSubtests.length - 1].indent >= indent) {
        openSubtests.pop();
      }
      openSubtests.push({ indent, name: subtest[2] });
      continue;
    }

    const notOk = NOT_OK.exec(line);
    if (!notOk || NOT_A_FAILURE.test(notOk[2])) continue;

    const indent = notOk[1].length;
    const name = notOk[2].trim();
    const ancestors = openSubtests
      .filter((entry) => entry.indent < indent)
      .map((entry) => entry.name);

    failures.push({
      name,
      path: ancestors,
      location: findLocation(lines, index),
      error: findError(lines, index),
    });
  }

  // A parent suite is reported as `not ok` purely because a child failed.
  // Keep only the deepest failures so the list names real tests, not wrappers.
  const leafOnly = failures.filter(
    (candidate) => !failures.some((other) => other !== candidate && other.path.includes(candidate.name)),
  );

  return { failures: leafOnly.length > 0 ? leafOnly : failures, reportedFailCount };
}

function findLocation(lines, startIndex) {
  for (let index = startIndex + 1; index < Math.min(startIndex + 12, lines.length); index += 1) {
    if (NOT_OK.test(lines[index])) break;
    const found = LOCATION.exec(lines[index]);
    if (found) return found[1];
  }
  return null;
}

function findError(lines, startIndex) {
  for (let index = startIndex + 1; index < Math.min(startIndex + 12, lines.length); index += 1) {
    if (NOT_OK.test(lines[index])) break;
    const found = ERROR_START.exec(lines[index]);
    if (!found) continue;
    const inline = found[1].trim();
    // `error: |-` introduces a folded block; take its first content line.
    if (inline === '|-' || inline === '|' || inline === '>-' || inline === '>') {
      const next = lines[index + 1];
      return next ? next.trim() : null;
    }
    return inline.replace(/^'(.*)'$/, '$1');
  }
  return null;
}

/**
 * @param {ReturnType<typeof summarizeTapFailures>} summary
 * @param {{logPath?: string|null, root?: string}} [options]
 * @returns {string}
 */
export function formatFailureReport(summary, options = {}) {
  const { failures, reportedFailCount } = summary;
  const root = options.root ?? '';
  const out = [];
  out.push('');
  out.push('──────── node tests: FAILED ────────');

  if (failures.length === 0) {
    out.push(
      reportedFailCount
        ? `${reportedFailCount} test(s) failed, but no "not ok" line could be parsed.`
        : 'The runner exited non-zero but reported no failing test (crash, or the suite never started).',
    );
  } else {
    const count = reportedFailCount ?? failures.length;
    out.push(`${count} test(s) failed:`);
    for (const failure of failures) {
      const label = [...failure.path, failure.name].join(' › ');
      out.push(`  · ${label}`);
      if (failure.location) {
        const shown = root && failure.location.startsWith(root)
          ? failure.location.slice(root.length).replace(/^[/\\]/, '')
          : failure.location;
        out.push(`    at ${shown}`);
      }
      if (failure.error) out.push(`    ${truncate(failure.error, 200)}`);
    }
  }

  if (options.logPath) {
    out.push('');
    out.push(`Full TAP output kept at: ${options.logPath}`);
  }
  out.push('────────────────────────────────────');
  return out.join('\n');
}

function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
