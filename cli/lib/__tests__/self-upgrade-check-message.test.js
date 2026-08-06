import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { checkForCoreUpdates } = await import('../self-upgrade.js');
const { resolveReleaseRepo } = await import('../release-source.js');

function withoutReleaseRepo(run) {
  const saved = process.env.YOS_RELEASE_REPO;
  delete process.env.YOS_RELEASE_REPO;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.YOS_RELEASE_REPO;
    else process.env.YOS_RELEASE_REPO = saved;
  }
}

function withReleaseRepo(value, run) {
  const saved = process.env.YOS_RELEASE_REPO;
  process.env.YOS_RELEASE_REPO = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.YOS_RELEASE_REPO;
    else process.env.YOS_RELEASE_REPO = saved;
  }
}

// Remote self-upgrade is intentionally disabled until YOS_RELEASE_REPO is set,
// but `yos upgrade --self --check` printed the raw machine token
// `release_source_not_configured`, which tells the operator nothing about what
// to configure. The human text already existed in `message` and was discarded.
describe('checkForCoreUpdates when no release source is configured', () => {
  it('surfaces the operator-facing text, not the machine token', () => {
    const result = withoutReleaseRepo(() => checkForCoreUpdates());
    const token = resolveReleaseRepo({}).error;

    assert.equal(result.success, false);
    // The machine token stays available for programmatic callers …
    assert.equal(result.error, 'remote_version_failed');
    // … while the text the CLI prints must name what to configure.
    assert.notEqual(result.message, token);
    assert.match(result.message, /YOS_RELEASE_REPO/);
  });

  it('keeps the release-source contract intact for programmatic callers', () => {
    // The token itself is still part of the library contract; only the text the
    // CLI shows changed.
    assert.equal(resolveReleaseRepo({}).error, 'release_source_not_configured');
    // The message is asserted by content, not as a whole string: it now carries
    // the repair as well (TD-19), and pinning the exact sentence made this test
    // the thing that broke when the message became more useful.
    assert.match(resolveReleaseRepo({}).message, /YOS_RELEASE_REPO is not configured/);
    assert.match(resolveReleaseRepo({}).message, /export YOS_RELEASE_REPO=/);
  });

  it('surfaces the operator-facing text for an invalid release source', () => {
    const invalidRepo = 'https://github.com/example/yos';
    const sourceResult = resolveReleaseRepo({ YOS_RELEASE_REPO: invalidRepo });
    const result = withReleaseRepo(invalidRepo, () => checkForCoreUpdates());

    assert.equal(sourceResult.error, 'invalid_release_source');
    assert.equal(result.success, false);
    assert.equal(result.error, 'remote_version_failed');
    assert.equal(result.message, sourceResult.message);
    assert.notEqual(result.message, sourceResult.error);
    assert.match(result.message, /YOS_RELEASE_REPO/);
    assert.match(result.message, /owner\/repository/);
  });
});
