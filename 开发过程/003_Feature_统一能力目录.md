# Unified Capability Catalog

## Background

YOS could install components but could not answer which capability a built-in
skill or component provided. The accepted design keeps the release shelf as the
single artifact authority and adds only a reverse capability index.

## Decisions

- Capability declarations live in `SKILL.md`.
- Component identity and compatibility stay in `package.json`.
- Local queries read only package skills and recorded installed components.
- The existing shelf build derives `capabilities.json` beside `index.json` with
  one deterministic build identity.
- Queries are read-only. Health entrypoints run only from `yos doctor`.
- Legacy components without declarations remain installable and visible as
  undeclared.

The declared Core set is deliberately limited to existing outward product
abilities: runtime monitoring, messaging, component management, skill authoring,
system health, web publishing, scheduling and persistent memory. Internal
session-maintenance skills remain undeclared rather than being given invented
public capabilities.

Rejected alternatives were a separate Registry repository, a new
`component.json`, a persistent local index, and using catalog data as an action
permission source. Each would duplicate an existing authority or widen V1.

## Dependency

`semver` is now a direct production dependency because component YOS version
ranges are a runtime compatibility contract and prerelease ordering cannot be
implemented safely with ad hoc string comparison.

## Verification

Development verification covers strict schema rejection, local read boundaries,
Core/channel provider grouping, compatibility, all read-only CLI commands,
doctor isolation, same-build shelf loading, remote degradation, mixed-build
rejection, temporary-shelf publication/removal, legacy components, package
derivation and a real TTY cancellation of the existing add flow.

Final development-side evidence:

- Jest: `274/274`; Node test: `1541/1541` with no failures.
- Six dependency roots: `0` vulnerabilities.
- Core package: `465` entries; content SHA-256
  `1a43feadc411c1dbdd88b1eda2d66ee267c5fb6cea4c06e81f755ac9d26cf98c`.
- Two local package builds were byte-identical; archive SHA-256
  `a4414111b39d647cb7f86941d91fdd21de3bc219b8128eaa866ee0abc79dc00d`.
- Two independent shelf builds produced byte-identical `index.json` and
  `capabilities.json`. Their SHA-256 values were
  `32c86edabc0af535dfaa8d8d847904c5f43fbc2cd1b8f124779dd80d99c00692`
  and `0315c5aafbf8e7034ce716db272b22d0127db4add02d383360739df5f8edd4e9`.
- Mutation checks proved that removing capability artifact integrity checking
  or omitting `capabilities.json` from `index.json` makes the relevant tests fail.

This record does not claim independent acceptance, merge, tag or publication.
