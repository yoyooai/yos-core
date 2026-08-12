/**
 * What a backup prefix is allowed to be — one definition, shared by the script
 * that mints the credential and the script that uses it.
 *
 * The prefix is not just a folder name. `cos-sts-token.mjs` interpolates it into
 * a CAM resource ARN as `<bucket>/<prefix>*`, and CAM treats `*` and `?` in that
 * string as wildcards. So a prefix of `*` mints a credential for
 * `<bucket>/*​/*`, and `rollback/*` mints one for every backup under
 * `rollback/` — the exact widening the prefix scoping exists to prevent, handed
 * out by the tool whose job is to narrow it. `shelf-offsite.mjs` then pastes the
 * same string in front of every object key, where `..` segments aim writes at
 * paths outside the run (小C's 2026-08-11 review, third round).
 *
 * The rule is therefore an allowlist, not a blocklist: a prefix is a sequence of
 * `/`-separated segments, each made only of characters that mean themselves in
 * both a CAM resource and an object key. Anything else is refused. Blocklisting
 * `*` and `..` would leave `?`, empty segments, and whatever CAM adds next.
 *
 * Both callers import this. A second opinion about what a prefix may contain is
 * how this comes back.
 */

/** Characters with no special meaning to CAM matching or to an object key. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Normalise and check a prefix, returning it with exactly one trailing slash.
 * Throws with a specific reason — the caller turns that into a usage error.
 */
export function normalizeCosPrefix(raw) {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error('prefix must be a non-empty string');
  }
  if (raw.startsWith('/')) {
    throw new Error('prefix must not start with /');
  }
  const withoutTrailing = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = withoutTrailing.split('/');

  for (const segment of segments) {
    if (segment === '') {
      throw new Error(`prefix has an empty path segment: ${JSON.stringify(raw)}`);
    }
    if (segment === '.' || segment === '..') {
      throw new Error(
        `prefix segment ${JSON.stringify(segment)} would point outside the run: ${JSON.stringify(raw)}`,
      );
    }
    if (!SEGMENT.test(segment)) {
      throw new Error(
        `prefix segment ${JSON.stringify(segment)} is not allowed — segments may contain ` +
          'only letters, digits, dot, underscore and hyphen. `*` and `?` are wildcards in a ' +
          'CAM resource, so a prefix containing one mints a credential far wider than the ' +
          `run it names: ${JSON.stringify(raw)}`,
      );
    }
  }
  return `${segments.join('/')}/`;
}
