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

- Jest: `274/274`; Node test: `1544/1544` with no failures.
- Six dependency roots: `0` vulnerabilities.
- Core package: `465` entries; cross-platform content SHA-256
  `971620b74893b1a5b15e132afb8b2d79bb229fa2edf55c1b855d3409a1bad9fb`.
- Two macOS package builds were byte-identical; macOS archive SHA-256
  `3bdadfef6a2d0c379b66bd4c16ebecb6fb0b900aec0b0dfbda4dd01aaeca38dd`.
  Independent cross-platform comparison must use the content digest above,
  not this platform-specific tar/gzip digest.
- Two independent shelf builds produced byte-identical `index.json` and
  `capabilities.json`. Their SHA-256 values were
  `32c86edabc0af535dfaa8d8d847904c5f43fbc2cd1b8f124779dd80d99c00692`
  and `0315c5aafbf8e7034ce716db272b22d0127db4add02d383360739df5f8edd4e9`.
- Mutation checks proved that removing capability artifact integrity checking
  or omitting `capabilities.json` from `index.json` makes the relevant tests fail.
- Review closure mutations also proved that duplicate capability IDs, providers
  referencing unpublished tags, and JSON exposure of doctor-only health paths
  each have an independent test that fails when its guard is removed.

## Shared title contract

Shared capability titles are now Core-owned and provider-neutral. Local catalog
reads and shelf publication both call the same resolver, while each provider
keeps its own display title on the provider record. Reversing provider order
therefore cannot rename a shared capability. Unknown capability IDs receive a
deterministic fallback title so a newly published provider does not require a
Core release merely to appear in the catalog.

This record does not claim independent acceptance, merge, tag or publication.
