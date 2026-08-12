/**
 * The prefix is the only thing standing between "a credential for this backup"
 * and "a credential for the bucket". It reaches two places that both give
 * characters meanings: a CAM resource ARN, where `*` and `?` are wildcards, and
 * an object key, where `..` aims a write somewhere else.
 *
 * 小C's 2026-08-11 review, third round: `--prefix '*'` was accepted, and minted
 * a token for `<bucket>/*​/*`. The narrowing added one round earlier could be
 * undone by the argument that names the run.
 *
 * So these are attack tests, not validation tests — each string used to produce
 * a wider credential than the operator asked for. They are written out one by
 * one rather than as a `test.each` table on purpose: the critical-file floor in
 * scripts/critical-test-files.json counts test *calls* in the source, so a table
 * of thirteen attacks would count as one, and twelve of them could be deleted
 * without the gate noticing.
 */
import { describe, expect, test } from '@jest/globals';

import { normalizeCosPrefix } from '../scripts/lib/cos-prefix.mjs';

describe('prefixes that widen the credential', () => {
  test('a bare * is refused — it would mint a token for the whole bucket', () => {
    expect(() => normalizeCosPrefix('*')).toThrow(/wildcard/i);
  });

  test('rollback/* is refused — it would cover every backup under rollback/', () => {
    expect(() => normalizeCosPrefix('rollback/*')).toThrow(/wildcard/i);
  });

  test('*/ is refused — the trailing slash changes nothing', () => {
    expect(() => normalizeCosPrefix('*/')).toThrow();
  });

  test('? is refused — CAM matches it as a single character', () => {
    expect(() => normalizeCosPrefix('?')).toThrow();
  });

  test('a wildcard in the middle of a name is refused', () => {
    expect(() => normalizeCosPrefix('roll?ack/')).toThrow();
  });

  test('a wildcard inside an otherwise ordinary segment is refused', () => {
    expect(() => normalizeCosPrefix('a*b/')).toThrow();
  });

  test('the refusal names the reason, so nobody "fixes" it by allowing the character', () => {
    expect(() => normalizeCosPrefix('rollback/*')).toThrow(/CAM resource/);
  });
});

describe('prefixes that escape the run', () => {
  test('../ is refused', () => {
    expect(() => normalizeCosPrefix('../')).toThrow(/outside the run/);
  });

  test('.. with no slash is refused', () => {
    expect(() => normalizeCosPrefix('..')).toThrow(/outside the run/);
  });

  test('a .. buried mid-path is refused', () => {
    expect(() => normalizeCosPrefix('a/../b/')).toThrow(/outside the run/);
  });

  test('stacked .. segments are refused', () => {
    expect(() => normalizeCosPrefix('a/../../b/')).toThrow(/outside the run/);
  });

  test('a . segment is refused rather than quietly dropped', () => {
    expect(() => normalizeCosPrefix('a/./b/')).toThrow(/outside the run/);
  });

  test('an absolute path is refused', () => {
    expect(() => normalizeCosPrefix('/absolute/')).toThrow(/must not start with/);
  });

  test('an empty segment is refused rather than silently collapsed', () => {
    expect(() => normalizeCosPrefix('a//b/')).toThrow(/empty path segment/);
  });

  test('an empty prefix is refused', () => {
    expect(() => normalizeCosPrefix('')).toThrow();
  });

  test('a non-string is refused rather than coerced', () => {
    expect(() => normalizeCosPrefix(undefined)).toThrow();
    expect(() => normalizeCosPrefix(null)).toThrow();
  });
});

describe('the prefixes the runbook actually uses', () => {
  test('a rollback run prefix passes through unchanged', () => {
    expect(normalizeCosPrefix('rollback/0.1.13-20260812-0000/')).toBe(
      'rollback/0.1.13-20260812-0000/',
    );
  });

  test('a missing trailing slash is added', () => {
    expect(normalizeCosPrefix('rollback/0.1.13-20260812-0000')).toBe(
      'rollback/0.1.13-20260812-0000/',
    );
  });

  test('the shelf prefix from step 10 is accepted', () => {
    expect(normalizeCosPrefix('shelf/0.1.14-20260812/')).toBe('shelf/0.1.14-20260812/');
  });

  test('the meta sub-prefix is accepted', () => {
    expect(normalizeCosPrefix('rollback/0.1.13-20260812-0000/meta/')).toBe(
      'rollback/0.1.13-20260812-0000/meta/',
    );
  });

  test('dots, underscores and hyphens are ordinary characters in a segment', () => {
    expect(normalizeCosPrefix('probe_1.2.3-x/')).toBe('probe_1.2.3-x/');
  });

  test('a doubled trailing slash is an empty segment, not a formatting quirk', () => {
    expect(() => normalizeCosPrefix('shelf/x//')).toThrow(/empty path segment/);
  });
});
