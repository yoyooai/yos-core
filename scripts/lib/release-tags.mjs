/**
 * What "the newest released tag" means — one definition, shared.
 *
 * The capability index picks providers by newest mirrored tag; the public-shelf
 * verifier has to decide whether the shelf's newest core version is the one
 * being released. Those two answers must come from the same code. When the
 * verifier had its own idea of "latest" (it looked for the expected version
 * anywhere in VERSIONS.md) a shelf carrying a newer core than the one being
 * verified still passed: 2026-08-11 review, newest was 0.1.15 with 0.1.14 still
 * listed in the history table, and the check was satisfied by the history row.
 *
 * So the rule lives here and both callers import it. A second comparator is how
 * that class of bug comes back.
 */
import semver from 'semver';

/** The version part of a tag, prefix and all: `feishu-v0.1.4` → `0.1.4`. */
export function tagVersion(tag) {
  const match = String(tag).match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match?.[1] ?? null;
}

/**
 * The component prefix a tag belongs to: `v0.1.14` → `''` (core),
 * `feishu-v0.1.4` → `'feishu'`. Mirrors how build-dist groups tags for
 * retention, so "newest of this component" means the same thing in both places.
 */
export function tagPrefixOf(tag) {
  const version = tagVersion(tag);
  if (version === null) return null;
  return String(tag).slice(0, String(tag).length - version.length).replace(/[-v]+$/, '');
}

/**
 * The newest tag of one component within a mirrored tag set, or null.
 * `prefix` is '' (or nullish) for the core line.
 */
export function newestReleaseTag(tags, prefix) {
  const expectedPrefix = prefix ? `${prefix}-v` : 'v';
  return [...(tags ?? [])]
    .filter((tag) => String(tag).startsWith(expectedPrefix) && semver.valid(tagVersion(tag)))
    .sort((a, b) => semver.rcompare(tagVersion(a), tagVersion(b)) || String(a).localeCompare(String(b), 'en'))[0]
    ?? null;
}
