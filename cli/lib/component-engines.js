/**
 * Does this machine's Node actually satisfy what a component declares?
 *
 * The installer accepts Node 20 and up. The WeChat channel declares
 * `>=24.18.0 <25.0.0` because it runs TypeScript entrypoints directly, which
 * Node 20 cannot load at all. Nothing checked the two against each other, so a
 * Node 20 machine installed the channel, reported success, and was left with a
 * service that could never start — measured on 2026-08-06: Node 20.20.0 dies
 * with ERR_UNKNOWN_FILE_EXTENSION on the channel's own entrypoint.
 *
 * The range parser deliberately covers only plain comparators, which is what
 * engines fields use. Anything else is reported as unknown rather than guessed:
 * blocking an install on a range we misread would be its own dishonesty.
 */

import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const COMPARATOR = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * The node range a component declares, or null when it declares none.
 *
 * @param {string} skillDir
 * @returns {string|null}
 */
export function readDeclaredNodeRange(skillDir, { readFile = fs.readFileSync } = {}) {
  try {
    const pkg = JSON.parse(readFile(path.join(skillDir, 'package.json'), 'utf8'));
    const range = pkg?.engines?.node;
    return typeof range === 'string' && range.trim() !== '' ? range.trim() : null;
  } catch {
    return null;
  }
}

export function readDeclaredYosContract(skillDir, { readFile = fs.readFileSync } = {}) {
  try {
    const pkg = JSON.parse(readFile(path.join(skillDir, 'package.json'), 'utf8'));
    const contract = pkg?.yos;
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
    const id = typeof contract.id === 'string' ? contract.id.trim() : '';
    const core = typeof contract.core === 'string' ? contract.core.trim() : '';
    if (!id || !core) return null;
    return {
      id,
      core,
      upstreamVersion: typeof contract.upstreamVersion === 'string'
        ? contract.upstreamVersion
        : null,
    };
  } catch {
    return null;
  }
}

export function checkYosCoreCompatibility(range, coreVersion) {
  const running = String(coreVersion ?? '').replace(/^v/, '');
  if (!range) {
    return { checked: false, satisfied: true, range: null, running, reason: 'no range declared' };
  }
  if (!semver.valid(running) || !semver.validRange(range)) {
    return {
      checked: true,
      satisfied: false,
      range,
      running,
      error: !semver.validRange(range) ? 'invalid_core_range' : 'invalid_core_version',
    };
  }
  return {
    checked: true,
    satisfied: semver.satisfies(running, range, { includePrerelease: true }),
    range,
    running,
  };
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesComparator(version, text) {
  const match = COMPARATOR.exec(text.trim());
  if (!match) return null;
  const operator = match[1] ?? '=';
  const target = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  const order = compare(version, target);
  switch (operator) {
    case '>=': return order >= 0;
    case '>': return order > 0;
    case '<=': return order <= 0;
    case '<': return order < 0;
    // A bare major/minor means that whole line, not exactly x.0.0.
    case '=': return match[3] === undefined
      ? version[0] === target[0]
      : match[4] === undefined
        ? version[0] === target[0] && version[1] === target[1]
        : order === 0;
    default: return null;
  }
}

/**
 * @param {string|null} range engines.node as declared
 * @param {string} nodeVersion e.g. process.version
 * @returns {{checked: boolean, satisfied: boolean, range: string|null, running: string, reason?: string}}
 */
export function checkNodeEngine(range, nodeVersion = process.version) {
  const running = String(nodeVersion ?? '').replace(/^v/, '');
  const version = parseVersion(running);
  if (!range) return { checked: false, satisfied: true, range: null, running, reason: 'no range declared' };
  if (!version) return { checked: false, satisfied: true, range, running, reason: 'unreadable node version' };
  if (range === '*' || range === 'x' || range.toLowerCase() === 'any') {
    return { checked: true, satisfied: true, range, running };
  }

  const alternatives = range.split('||');
  let anyChecked = false;

  for (const alternative of alternatives) {
    const comparators = alternative.trim().split(/[\s,]+/).filter(Boolean);
    if (comparators.length === 0) continue;
    const verdicts = comparators.map((comparator) => satisfiesComparator(version, comparator));
    if (verdicts.some((verdict) => verdict === null)) continue; // unparseable alternative
    anyChecked = true;
    if (verdicts.every(Boolean)) {
      return { checked: true, satisfied: true, range, running };
    }
  }

  if (!anyChecked) {
    return { checked: false, satisfied: true, range, running, reason: 'unsupported range syntax' };
  }
  return { checked: true, satisfied: false, range, running };
}

/**
 * What to tell someone whose Node does not satisfy the component.
 *
 * @param {{range: string, running: string}} verdict
 * @param {string} componentName
 * @returns {string[]} lines, already ordered for printing
 */
export function describeEngineMismatch(verdict, componentName) {
  return [
    `${componentName} needs Node ${verdict.range}, and this machine runs Node ${verdict.running}.`,
    'Installing it would leave a service that cannot start, so nothing was installed.',
    'Fix it either way:',
    `  · install a Node that satisfies ${verdict.range}, then run: yos add ${componentName}`,
    `  · or, if ${componentName} really does run on Node ${verdict.running}, widen its engines range at the source and release it again`,
  ];
}
