# YOS Changelog

All notable changes to YOS are recorded here from the point at which the independent YOS product baseline was established.

## Unreleased

### Fixed

- `yos logs activity` and `yos logs scheduler` resolved to `activity-log.txt` and `scheduler-log.txt`, which no service ever writes, so the default `yos logs` always reported "Log file not found". `activity` now reads the activity monitor's own log and `scheduler` reads the output PM2 captures for it.
- `yos upgrade --self --check` printed the raw `release_source_not_configured` token when no release source was configured. It now reports which variable to set.

## [0.1.0-alpha.1] - 2026-08-03

This is an internal engineering milestone for continued YOS development, not a customer release.

### Changed

- Established the verified v0.6.0 engineering baseline from an authorized upstream product.
- Added dependency security fixes, deterministic tests and a reproducible verification gate.
- Started the user-facing YOS brand separation while retaining runtime compatibility.
