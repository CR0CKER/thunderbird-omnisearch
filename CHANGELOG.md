# Changelog

All notable changes to OmniSearch for Thunderbird are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses the `major.minor.patch` version in `manifest.json`.
Changelog tracking begins at the 0.4.x series; for earlier history see the git log.

## [Unreleased]

## [0.5.2] - 2026-08-05

### Fixed

- **Search results opened the wrong email.** Clicking a result (or pressing
  Enter on it) could open a completely unrelated message. The index stored each
  message's numeric Thunderbird id, but that id is an internal tracking number
  that is **reissued after every restart** and does not follow a message moved
  between folders — so a stored id silently came to address a *different* email.
  Opening it therefore succeeded on the wrong message, and the existing
  Message-ID fallback never ran because it only triggered when opening *failed*.
  Results are now resolved by their stable RFC `Message-ID` before opening, with
  the stored numeric id demoted to a hint that is verified first.
- Opening a result no longer reports success when the message does not exist:
  the mail-tab fallback previously returned success unconditionally, masking the
  failure instead of falling through to re-resolution.
- A result whose `Message-ID` exists in two accounts now reopens the copy from
  the account it was indexed from, matching the per-account search dedup.

### Added

- `test/open.test.js` — unit tests covering result-to-message resolution,
  including a regression test for the wrong-email bug above. Run with
  `npm test` (or `node --test 'test/*.test.js'`); no dependencies to install.
- CI now runs the unit tests as a separate `Unit tests` job.

## [0.5.1] - 2026-07-20

### Fixed

- Empty-state search popup: the "No index yet — Rebuild to index your mail" hint
  now has a **clickable "Rebuild"** that starts indexing directly. Previously it
  told the user to click a control that only exists on the Settings page.

## [0.5.0] - 2026-07-20

### Added

- **Settings → Clear index** — a control that purges the search index from disk
  (IndexedDB), including the decrypted contents of any encrypted emails you opted
  to index. Backs the purge capability that `SECURITY.md` describes. (audit M1)
- `package.json` pinning the vendored MiniSearch version, plus `lib/VENDOR.md`
  recording its upstream, version, and SHA-256 — so GitHub's dependency graph,
  Dependabot, and `osv-scanner` surface any MiniSearch advisory. (audit M2)
- CI workflow (`node --check` syntax gate, an OSV dependency audit querying
  api.osv.dev for each pinned dependency, `gitleaks` secret scan), a Dependabot
  config, and README status badges. (audit L3)

### Fixed

- `SECURITY.md`: corrected the stated indexed-body cap (default 4,000 chars,
  configurable up to 20,000 — it previously said a flat 20,000) and pointed the
  index-purge recommendation at the new **Clear index** control. (audit L1)
