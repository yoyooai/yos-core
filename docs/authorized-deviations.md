# Authorized deviations from upstream

YOS is a rename-and-reset of upstream `v0.6.0` (commit `d008294`).
Most of the tree is upstream verbatim or upstream with the brand renamed. This file is the
register of everything else.

**Why this file exists.** Until 2026-08-03 the authorized set lived in chat messages. An
independent review measured `main` against a four-item list that omitted two commits, and
correctly reported a deviation as unauthorized. A list that lives in a conversation drifts;
a list in the repository can be checked by anyone against the code.

**Rules.**

- Every departure from upstream that changes runtime behaviour, packaging or licensing gets a
  row here — including ones added by us to fix our own baseline.
- Pure brand renaming does not need a row. Renaming that changes behaviour does (see D5).
- `Status` is `authorized` only when the owner has said so **in their own words**. Inferring
  authorization from a general instruction is not enough, and neither is a reviewer's
  reasonable assumption — `Authorized by` must name whoever actually decided. Anything else is
  `pending`, and `pending` rows block a customer-facing release, not development.
- Where the decision is an engineering one rather than the owner's, name the engineering owner.
  Attributing our own decisions to the product owner makes this register less accurate, not
  more authoritative (see D4).
- Reviewers: this file is the specification. A functional deviation absent from this table is
  a finding, not a feature.

**How D6 and D7 got here.** Both were written by 小A under a general instruction to fix minor
blemishes. That instruction did not say which behaviours changed, so both rows were opened as
`pending` rather than assumed. A reviewer then marked them authorized; independent verification
could not find the owner ever saying so and refused to sign off. 苏白 confirmed both explicitly
on 2026-08-03 and directed that D4 be recorded as the technical director's decision instead of
theirs. The rows are `authorized` because that confirmation exists — not because the changes
looked reasonable.

## Register

| # | Deviation | Behaviour change | Authorized by | Commit | Status |
|---|---|---|---|---|---|
| D1 | In-place instruction-migration system removed (`cli/commands/migrate-instructions.js`, `cli/lib/instruction-migration.js`, `cli/lib/migrate.js`, baseline manifest, export script, tests) | An upstream or early-YOS install can no longer be upgraded in place. Fresh install only. | 苏白, 2026-08-03 | `ae85d6b` | authorized |
| D2 | Interrupted-message persistence and recovery added (upstream has none) | Messages survive a runtime crash, resume automatically, and are de-duplicated per source. Adds a `UNIQUE` constraint in `init-db.sql`. | 苏白, 2026-08-03 | `ae85d6b` | authorized |
| D3 | Release/upgrade source must be configured explicitly (`YOS_RELEASE_REPO`, `YOS_REGISTRY_REPO`; new `cli/lib/release-source.js`) | With no release source configured, remote self-upgrade is disabled rather than defaulting to upstream. Without this, `yos upgrade --self` would upgrade a YOS install back to the upstream brand. | 苏白, 2026-08-03 | `ae85d6b` | authorized |
| D4 | `npm run verify` gate added (`scripts/verify.js`, `scripts/package-policy.js`, dependency audit, double-build determinism, repository-cleanliness check) | No runtime behaviour change. Blocks packaging when the tree is dirty or policy fails. | 小A (technical director) | `ae85d6b`, `651481e`, `9b5eebd` | authorized |
| D5 | Namespace migration: sole `yos` entry point, default `~/yos`, metadata `.yos`, `YOS_*` variables, `yos-*` service names | The pre-rename entry point, home directory and `ZYLOS_*` variables are not recognised at all. This is the behavioural half of the rename. | 苏白, 2026-08-03 | `ae85d6b` | authorized |
| D6 | `yos logs` targets corrected to the paths services actually write (`activity-monitor/activity.log`; `scheduler` read through PM2) | `yos logs` execution path changes. Upstream pointed `activity` and `scheduler` at files nothing writes, so the default invocation always failed on a healthy install. | 苏白, 2026-08-03 | `3f21e9f` | authorized |
| D7 | `yos upgrade --self --check` reports the variable to configure instead of the internal token | Operator-facing text only. The `remote_version_failed` token and the release-source library contract are unchanged. | 苏白, 2026-08-03 | `6597a0a` | authorized |
| D8 | `LICENSE` copyright line replaced (upstream's holder replaced with `YOS Team`) | Licensing, not code. MIT permits modification and commercial use but requires the original copyright notice to be retained, so the compliant form is upstream's line plus ours, not a replacement. | — | `ae85d6b` | **pending — owner handling** |
| D9 | Self-upgrade and release packaging made transactional (`release:pack`, pre-stop candidate preparation, previous-core snapshot, post-install rollback and explicit recovery) | Ordinary `npm pack` no longer runs the repository release gate. A self-upgrade prepares its candidate before stopping services, restores the previous core and services after a failed step 4–12, retains a warning backup after step 13, and exposes an explicit recovery command when automatic rollback is incomplete. Optional update notes are read only from the downloaded package. | 苏白, 2026-08-04 | `4886eb3`, `e3520bb`, `c40acfb` | authorized |

## Consequences for future upstream syncs

Upstream `v0.6.0` was imported as a tree, not merged, so **it is not a git ancestor of this
repository.** Pulling an upstream fix cannot be a plain `git merge`; it requires tree-level
comparison and selective porting. The rows above are where that porting will conflict:

- **D1** — an upstream change that touches the migration system has nothing here to apply to.
- **D2** — upstream has no equivalent, so upstream changes to message handling must be
  reconciled against our recovery layer by hand.
- **D3** — any upstream change to upgrade or release resolution will conflict directly.
- **D5** — path, variable and service-name renames affect nearly every diff hunk.
- **D9** — upstream changes to self-upgrade steps, package lifecycle scripts or release construction must preserve the transaction and release-gate boundaries.

The fork-review audit that produced this classification is
[`docs/audits/2026-07-16-yos-v060-fork-review.md`](audits/2026-07-16-yos-v060-fork-review.md).

## Not a deviation

For the avoidance of a repeat finding: `README.md` and `README.zh-CN.md` previously stated
that legacy runtime paths, environment variables and the legacy executable remained
available. That was never true — see D1 and D5 — and it was a false statement in the
documentation, not a deviation in the code. It is pinned by
`cli/lib/__tests__/readme-compatibility-claims.test.js`, which fails whenever the READMEs and
the code disagree about which install paths exist.
