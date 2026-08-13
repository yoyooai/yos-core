# YOS Shelf Automatic Off-site Backup Design

## Goal

Turn the manually proven COS backup procedure into a repeatable scheduled job
without giving the shelf machine a long-lived cloud credential or giving the
backup job permission to delete history.

The job is successful only when all of the following are true:

1. The production shelf passes a full local shelf audit.
2. Every shelf file is uploaded under a unique run prefix.
3. COS contains exactly the uploaded files and every ETag matches local bytes.
4. Run metadata and the shelf audit are uploaded and verified separately.
5. The first run, and then every configured interval, is restored on the control
   machine and passes `verify-public-shelf.mjs --local --full`.
6. A durable local state record is committed atomically.

## Non-goals

- The scheduler does not publish, tag, switch, or modify the production shelf.
- The scheduler does not delete COS objects. Retention produces explicit
  candidates for a separately authorized cleanup operation.
- Long-lived Tencent credentials are not stored in the repository, generated
  systemd units, scheduler config, logs, or state files.
- The scheduler does not replace release-time backups. It adds a periodic copy
  between releases.

## Placement and trust boundaries

The timer runs on a control machine, not the shelf machine. A configured
credential command mints a short-lived STS credential scoped to the unique run
prefix. The credential stays in process memory and is sent over SSH standard
input for the shelf-side upload; it is never written to a temporary file.

The shelf machine runs the existing `shelf-offsite.mjs` and
`verify-public-shelf.mjs` tools against the real shelf. The control machine owns
the state directory, optional restore workspace, and alert command. The alert
command receives a redacted JSON event on standard input and never receives COS
credentials.

## Run flow

1. Acquire an exclusive lock. A live lock fails the run; a stale lock is
   recovered and recorded.
2. Create `scheduled/<UTC timestamp>-<random>/` and full-audit the shelf before
   minting any cloud credential.
3. Mint an STS token for that parent prefix, upload and reverse-verify `shelf/`
   over SSH, then audit the live shelf again. The two shelf identities must be
   identical so a release switch cannot mix one audit with another tree.
4. On the first successful run and every `restoreEvery` successes thereafter,
   restore `shelf/` into a new temporary directory and run the full shelf audit.
5. Write redacted run metadata locally, upload it under `meta/`, and reverse
   verify it. The off-site evidence says `backupVerified`, not overall `pass`;
   overall PASS exists only after this metadata has itself been verified.
6. Atomically update `state.json` with success/failure, counts, buildId,
   index digest, restore evidence, and retention candidates.
7. On failure, invoke the configured alert executable with a redacted event and
   exit non-zero. An alert failure is reported in addition to the original
   failure; it never converts the run to success.

## Retention

`keepSuccessful` controls how many successful verified run prefixes are kept
out of the local ledger's active set. Older successful prefixes are listed as
`retentionCandidates`; they are not deleted. A future cleanup command must use a
different credential with delete permission and an explicit approval record.
This separation prevents one compromised scheduled job from erasing both the
current shelf and all historical backups.

## Scheduling

`install-shelf-auto-backup.mjs` installs a system-level systemd service and timer
that run as the selected unprivileged operator. System scope is required because
user-level sandbox namespaces can remap the system SSH configuration ownership,
causing SSH to fail only when the timer eventually fires. The service retains
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, and
`ProtectHome=read-only`; explicit HOME, PATH, and writable paths provide only the
runtime access the backup and alert commands need.

Installation is fail-closed. Before accepting and enabling the timer, the
installer starts the real oneshot service and requires `Result=success`. Failure
restores the previous unit files and timer state, or removes a fresh failed
installation. Generation without `--system` is rejected by the CLI.

## Acceptance

- A healthy fake shelf completes upload, reverse verification, metadata upload,
  first-run restore, and atomic state commit.
- Upload, verification, restore, credential, and alert failures all exit
  non-zero; credentials never appear in output or state.
- Concurrent runs are rejected and stale locks are recoverable.
- Retention candidates are deterministic and no delete operation is issued.
- Generated units contain no secret values and refuse configs that contain
  credential material.
- System installation proves the real backup service once before enabling the
  timer; failed installation restores the previous units and timer state.
- Additional alert write paths are checked with the selected runtime user before
  any unit is installed.
- Removing each critical failure check makes its focused test fail.
- Full repository verification remains green with updated protected test floors.
