# Changelog

All notable changes to OmniSearch for Thunderbird are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses the `major.minor.patch` version in `manifest.json`.
Changelog tracking begins at the 0.4.x series; for earlier history see the git log.

## [Unreleased]

### Added

- **Filter chips.** Each active `date:`/`from:`/`to:` filter now appears as a chip
  below the search box, labelled with the dates it actually **resolved to**
  (`1/6/2024 – 31/7/2024`) rather than the text you typed — so a range that came
  out wider than you meant is visible before it hands you the wrong mail. Click a
  chip's **×** to drop that filter and search again; the rest of the query,
  including your search words, is kept.
- **A hint pointing at the filters**, shown when a search finds nothing — the
  moment you are most likely to want it. It stays out of the way otherwise.
- **Filter suggestions in the search window.** While the search box is empty, the
  line under it now offers the available filters — `from:`, `to:`, `date:`,
  `after:`, `before:` — each with an example value, so you can see both that a
  filter exists and what a valid value looks like. Click one to drop it into the
  search box, then type the value. They disappear as soon as you start typing.

### Added (developer)

- `./build.sh` now stamps development builds with the branch and commit they came
  from (`…+master-d613db3.xpi`, plus `-dirty` for uncommitted changes), so a
  stale `.xpi` is no longer indistinguishable from a fresh one. `./build.sh
  --release` produces the clean release filename, and the stamp is skipped
  automatically outside a git checkout.

### Fixed

- **A taller search window now fills with results.** Dragging the centered search
  window taller left most of it empty: the result list was capped at a fixed
  height regardless of the window. The list now fills whatever height the window
  has, and once you size the window yourself it keeps that size instead of
  snapping back on the next search.
- The **×** on a filter chip is now centred in its hover circle, and the
  "encrypted" / "header-only" badge sits on the same line as the subject beside
  it rather than hanging below it.

### Changed

- The toolbar button's tooltip is now just "OmniSearch", rather than
  "OmniSearch — search your mail".
- The search window no longer shows "X messages indexed · updated …". It was
  read once and then ignored, while occupying the most visible line in the
  window; the filter suggestions above use that space instead. The index count
  and last-updated time are still on the Settings page, which is also where an
  indexing problem is reported.

## [0.7.0] - 2026-08-07

### Added

- **Search filters for date and sender.** Narrow any search with `date:`,
  `after:`, `before:`, `from:` and `to:` — for example
  `invoice from:alice@corp.com date:2024-06..2024-07`. Filters work on their own
  too, with no search words at all.
  - A date always means **the whole period you named**: `date:2024-06` is all of
    June, `after:2024-06` starts at 1 June, and `before:2024-06` runs to the end
    of 30 June. So `after:2024-06 before:2024-07` is June and July inclusive —
    unlike Gmail, you never have to name a month you don't want.
  - `from:`/`to:` match the sender or recipient **only**. Previously a plain
    search for a domain could match on the recipient instead, and a bare address
    like `<bob@example.net>` was hard to find by name because of how addresses
    are split into words; both are fixed by these filters.
  - Dates must be written **year first** (`2024-06-07`) or with the month spelled
    out in whatever order comes naturally — `date:7 july 2024`,
    `date:july 7 2024`, `date:July 7, 2024` and `date:july 2024` all work
    without quotes, in English, German, French and Spanish. An ambiguous form
    like `7/6/2024` is refused with an explanation rather than guessed at: it
    means 7 June in Europe and 6 July in the US, and search results give no hint
    that the wrong month was chosen.
  - Inside an explicit date range, results are ordered by relevance rather than
    by the recency preference added in 0.6.0 — you already said which period you
    wanted.
  - A filter is **never dropped in silence.** If part of what you typed can't be
    understood as a date, it is reported in the results area rather than being
    ignored, because a search that quietly ran without your filter looks exactly
    like one that worked.
  - **No rebuild is required.**

- **Relative and named date filters.** `newer_than:7d` and `older_than:1y` take
  a number and a unit (`d`, `w`, `m`, `y`); months and years step the calendar,
  so `3m` respects month lengths rather than assuming 30 days. The two are exact
  complements — every message falls in one or the other, with no overlap and no
  gap. Also `date:today`, `date:yesterday`, `date:this-week` (Monday to Sunday),
  `date:this-month` and `date:this-year`, which are ordinary period values and so
  compose with the rest: `after:today`, `date:yesterday..today`.
  Relative windows snap to whole days, so results do not shift under you as the
  clock ticks.

### Added (developer)

- `lib/query.js` — the query-operator parser, a pure module with no Thunderbird
  or MiniSearch dependencies, loaded inside the engine worker.
- `test/query.test.js` — 49 unit tests for it, including the ambiguous-date
  rules and a pinned non-UTC timezone (a UTC test runner cannot see the
  local-vs-UTC parsing bug these guard against). Total suite: 84 tests.

## [0.6.0] - 2026-08-06

### Changed

- **Recent emails now rank higher.** Search ranking previously ignored a
  message's date entirely, so equally-good matches came back in an order derived
  from the folder-walk of the last index build — which meant new mail often sat
  below old mail for no visible reason. Results are now multiplied by a recency
  factor that decays with age (2.5× for today's mail, 2.1× at six months, 1.75×
  after a year, and effectively nothing past several years), and exact ties are
  broken by date instead of index order. Matching in the subject or sender still
  counts for more than being recent: a years-old email with your search term in
  its **subject** still outranks one from today that only mentions it in the
  body.
  **No rebuild is required** — this changes ranking only, not the index.

### Added

- `test/engine.test.js` — unit tests for search-result shaping: the recency
  curve and its edges (future-dated mail is clamped so it cannot be pushed to
  the top; a missing date stays neutral), the guarantee that recency does not
  override the subject/sender weighting, and the existing de-duplication
  behaviour. Run with `npm test`; no dependencies to install.

### Fixed

- `lib/engine.js` no longer contains a literal NUL byte (it was the internal
  separator in the de-duplication key, now written as an escape). Git classified
  the file as binary because of it, which suppressed diffs for the project's
  most-edited source file. Runtime behaviour is unchanged.

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
