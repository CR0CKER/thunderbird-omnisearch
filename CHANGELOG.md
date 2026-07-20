# Changelog

All notable changes to OmniSearch for Thunderbird are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses the `major.minor.patch` version in `manifest.json`.
Changelog tracking begins at the 0.4.x series; for earlier history see the git log.

## [Unreleased]

## [0.5.0] - 2026-07-20

### Added

- **Settings → Clear index** — a control that purges the search index from disk
  (IndexedDB), including the decrypted contents of any encrypted emails you opted
  to index. Backs the purge capability that `SECURITY.md` describes. (audit M1)
- `package.json` pinning the vendored MiniSearch version, plus `lib/VENDOR.md`
  recording its upstream, version, and SHA-256 — so GitHub's dependency graph,
  Dependabot, and `osv-scanner` surface any MiniSearch advisory. (audit M2)
- CI workflow (`node --check` syntax gate, `osv-scanner` dependency audit,
  `gitleaks` secret scan), a Dependabot config, and README status badges. (audit L3)

### Fixed

- `SECURITY.md`: corrected the stated indexed-body cap (default 4,000 chars,
  configurable up to 20,000 — it previously said a flat 20,000) and pointed the
  index-purge recommendation at the new **Clear index** control. (audit L1)
