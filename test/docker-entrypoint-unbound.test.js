import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

/**
 * The official `docker run` path must survive with none of the optional
 * environment variables set.
 *
 * On 2026-08-02 a fix for the hardcoded console port expanded
 * `${WEB_CONSOLE_PORT}` bare, under `set -euo pipefail`, in the banner at the
 * very end of the entrypoint. The documented `docker run` command does not pass
 * that variable and the Dockerfile does not set it, so the container ran its
 * whole startup and then died on `unbound variable` — entrypoint exits, cleanup
 * runs, PM2 is stopped, container gone. The tests of the day checked that the
 * banner no longer said 3456; none checked that the script was still alive.
 *
 * This guards the class, not that one line: any uppercase variable expanded
 * without a default has to be one the script itself sets, or one the Dockerfile
 * guarantees.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRYPOINT = path.join(ROOT, 'docker', 'entrypoint.sh');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');

/** Variables the container image itself guarantees, so a bare use is safe. */
const IMAGE_PROVIDED = new Set(['HOME', 'PATH', 'NPM_CONFIG_PREFIX']);

function withoutCommentsAndHeredocs(source) {
  return source
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/(^|\s)#(?!\{).*$/, '$1')))
    .join('\n');
}

function assignedNames(source) {
  const names = new Map();
  const patterns = [
    /^\s*(?:local\s+|readonly\s+|export\s+|declare\s+)?([A-Z_][A-Z0-9_]*)=/gm,
    /^\s*(?:local\s+|readonly\s+|export\s+)?([A-Z_][A-Z0-9_]*)\s*\(\)/gm,
    /\bfor\s+([A-Z_][A-Z0-9_]*)\s+in\b/g,
    /\bread\s+(?:-r\s+)?([A-Z_][A-Z0-9_]*)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      if (!names.has(match[1]) || names.get(match[1]) > line) names.set(match[1], line);
    }
  }
  return names;
}

/** Line numbers that sit inside a function body, where source order says nothing
 * about execution order: `step()` legitimately reads a variable assigned below it. */
function functionBodyLines(source) {
  const inside = new Set();
  const lines = source.split('\n');
  let depth = 0;
  lines.forEach((line, index) => {
    const opens = /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/.test(line)
      || /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*$/.test(line);
    if (depth > 0) inside.add(index + 1);
    if (opens) { depth += 1; inside.add(index + 1); return; }
    if (depth > 0) {
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (depth < 0) depth = 0;
    }
  });
  return inside;
}

/**
 * Bare `${VAR}` / `$VAR` uses — the ones `set -u` kills when VAR is unset.
 *
 * A bare use on a line that also guards the same variable is safe: in
 * `[ -n "${TZ:-}" ] && ... ${TZ}` the right-hand side only runs when TZ is set.
 */
function bareUses(source) {
  const uses = [];
  const lines = source.split('\n');
  const selfGuarded = /\$\{[A-Z_][A-Z0-9_]*(:?[-=+?])/;
  for (const match of source.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::?[-=+?][^}]*)?\}|\$([A-Z_][A-Z0-9_]*)\b/g)) {
    const name = match[1] ?? match[2];
    if (selfGuarded.test(match[0])) continue;
    const line = source.slice(0, match.index).split('\n').length;
    if (new RegExp(`\\$\\{${name}:?[-=+?]`).test(lines[line - 1] ?? '')) continue;
    uses.push({ name, line });
  }
  return uses;
}

describe('the docker entrypoint under set -u', () => {
  const source = withoutCommentsAndHeredocs(fs.readFileSync(ENTRYPOINT, 'utf8'));

  test('runs with set -euo pipefail, which is what makes an unset variable fatal', () => {
    expect(source).toMatch(/^set -euo pipefail$/m);
  });

  test('never expands an optional variable bare', () => {
    const assigned = assignedNames(source);
    const offenders = bareUses(source).filter(
      (use) => !IMAGE_PROVIDED.has(use.name) && !assigned.has(use.name),
    );
    expect(offenders.map((use) => `${use.name} (line ${use.line})`)).toEqual([]);
  });

  test('sets a variable before the first place it is used bare', () => {
    const assigned = assignedNames(source);
    const inFunction = functionBodyLines(source);
    const tooEarly = bareUses(source)
      .filter((use) => !inFunction.has(use.line))
      .filter((use) => assigned.has(use.name) && use.line < assigned.get(use.name))
      .map((use) => `${use.name} used at line ${use.line}, first set at line ${assigned.get(use.name)}`);
    expect(tooEarly).toEqual([]);
  });

  test('the variables treated as image-provided really are set by the Dockerfile', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    for (const name of IMAGE_PROVIDED) {
      expect(dockerfile).toMatch(new RegExp(`^ENV\\s+${name}=`, 'm'));
    }
  });

  test('the documented docker run command still passes none of them', () => {
    // If a future doc change starts passing WEB_CONSOLE_PORT or TZ, that does
    // not make a bare expansion safe — people copy the short command, and
    // compose files and CI invoke the image their own way.
    const docs = fs.readFileSync(path.join(ROOT, 'docs', 'docker.md'), 'utf8');
    const runBlock = docs.slice(docs.indexOf('docker run -d --name yos'));
    expect(runBlock).not.toMatch(/-e\s+WEB_CONSOLE_PORT=/);
  });
});
