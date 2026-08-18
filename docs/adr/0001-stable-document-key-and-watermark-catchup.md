# 1. Stable document key + watermark catch-up

- Status: proposed
- Date: 2026-08-18

## Context

A search for `mesh team api beta` failed to surface a message whose headers
contain all four terms (`From: "Mesh Team (Mesh)" <care@clay.earth>`,
`Subject: Re: API beta access request`, dated the previous day). With
`boost: {subject: 3, from: 2}` and the maximum recency multiplier it should have
ranked first. It was not ranked low — it was **not in the index**.

Decoding the live IndexedDB snapshot (78,860 docs, written minutes before) and
diffing it against the profile's mbox files showed the miss was not isolated:

| Folder  | Aug 2026 missing |
|---------|------------------|
| Archive | 75%              |
| INBOX   | 81%              |
| Sent    | 100%             |

Coverage is 100% through June, degrades from ~20 July (the last full rebuild),
and is mostly gone by August. Two structural causes, both confirmed:

**1. The document key is ephemeral.** Documents are keyed on
`String(header.id)` (`lib/indexer.js`), which Thunderbird's own docs describe as
"an internal tracking number that does not remain after a restart". Decoding the
snapshot's `documentIds` map: the stored ids are integers **3..79,079, filling
99.7% of that contiguous range**. Thunderbird reissues ids from that same low
range each session, so after a restart nearly every live id is already present
in the index under a *different* message. `reconcile()` — the documented
self-heal that "guarantees a message can never stay permanently hidden because
an event was dropped" — reads that as "already indexed" and skips it. The
self-heal cannot heal, which is why the staleness is permanent rather than
self-correcting.

**2. Freshness is push-only over a lossy channel.** Nothing schedules
`reconcile()`; its only caller is the Settings "Verify & repair" button. Index
correctness therefore *requires* every WebExtension event to arrive. The
extension already subscribes to **all five** message events that exist
(`onNewMailReceived`, `onUpdated`, `onDeleted`, `onMoved`, `onCopied`), so the
push surface is exhausted — no additional listener can close the gap.
`onNewMailReceived` is specified as firing when a message is *received*, which
structurally cannot cover mail synced while Thunderbird was closed, mail filed
server-side, or Sent (matching Sent at 100% missing).

Identifier stability, checked against the schema shipped in the running build
(Thunderbird 153.0.2, `chrome/messenger/content/messenger/schemas/`):

| Identifier                | Stable across restart?                                        |
|---------------------------|---------------------------------------------------------------|
| `header.id`               | **No** — recycled each session                                 |
| `folderId`                | **No** — "unique throughout a session"; rename/move invalidates|
| `headerMessageId`         | **Yes** — RFC Message-ID                                       |
| `accountId` + folder `path` | **Yes**                                                      |

Measured on the live index: `headerMessageId` is present on **100%** of 78,859
docs (Thunderbird synthesizes `md5:…` pseudo-ids for the 229 lacking a real
one), and `accountId + headerMessageId` yields **51,520** distinct keys — the
34.7% collapse being Gmail/IMAP label copies of one message (largest group: 20).

## Decision

**Key documents on `accountId + headerMessageId`, and make freshness pull-based.**

### 1. Stable document key

- `MINISEARCH_OPTIONS.idField` becomes `key`. The single pure derivation lives in
  a new shared module `lib/dockey.js` (`globalThis.OmniKey.docKey`) —
  `(accountId || '') + '\0' + headerMessageId`, falling back to `'id:' + id` when
  a Message-ID is somehow absent, so such a doc never collapses with another.
  This is the key `rank()` already computes at query time; it is promoted from
  query-time to storage-time.
- **`lib/dockey.js` is loaded on both sides** — as a background script in
  `manifest.json` and via `importScripts` in `lib/engine.worker.js` — because the
  watermark catch-up runs on the main thread (only there does `messenger.*`
  exist) and must compute the same key the worker stores under. One definition,
  no drift. `SearchEngine.docKey` is a thin static delegating to it, so
  engine-side call sites read naturally.
- The numeric `id` demotes to a **stored, non-authoritative cache hint**.
  `lib/open.js` already validates it before use and is unaffected.
- Label copies collapse: one document per message per account, carrying
  `folders[]` (replacing per-doc `folderName`). `upsert` merges an incoming
  folder into an existing document rather than creating a second one.
- Removal becomes folder-scoped: `removeFromFolder(key, folder)` drops that
  folder and discards the document **only when its last folder is gone**.

### 2. Watermark catch-up (the freshness fix)

- Track a per-account high-water mark (the newest indexed message date).
- On startup and on a periodic alarm, run
  `messages.query({ accountId, fromDate: watermark − overlap, includeSubFolders: true })`
  and index any result whose key is not already present. Cost is **O(new mail)**,
  not O(archive) — no full folder walk, so this does not reintroduce the
  main-thread cost the worker architecture exists to avoid.
- An `overlap` window (default 1 day) absorbs clock skew and same-day boundaries.
- Events remain the low-latency fast path. **After this change a dropped event
  costs latency, not permanent invisibility** — which is the whole point.

### 3. Deep sweep

`reconcile()` stays as the manual "Verify & repair", now correct by construction
because it diffs on the stable key. It covers the one hole a date watermark
cannot see: back-dated mail (an old `Date` header imported or moved in today).

**It also runs once automatically, on migration.** A watermark assumes everything
beneath it is complete, and an index written under the old keying violates
exactly that: it can be missing months of mail while still holding a message from
today, so the mark seeds near `now` and the catch-up steps over the hole. Every
existing install carries such an index, so the fix must repair, not merely stop
the bleeding. `SearchEngine.deserialize` therefore reports `migratedFromLegacyKey`,
`background.js` persists a `pendingDeepSweep` flag in `storage.local` **before**
sweeping, and `OmniEvents.deepSweepIfPending` clears it **only after**
`reconcile()` resolves — an interrupted sweep (Thunderbird quits, the event page
suspends mid-walk) stays pending and retries. It is triggered from three places
so no install can miss it: when a load that set the flag settles, on
`runtime.onStartup`, and on the daily alarm (ahead of the catch-up).

### 4. Migration: in place, no rebuild

MiniSearch's inverted index references *internal* short ids; only `_documentIds`
maps internal → external. Both fields the new key needs (`accountId`,
`headerMessageId`) are already in `storedFields`. So a `v:2` snapshot migrates by
rewriting `_documentIds`, merging duplicate label copies with the existing
`discard()` (`lib/minisearch.js`), and building `folders[]` from the
`folderName`s being merged. **No message is re-read and no rebuild is forced.**
Snapshot format becomes `v:3`; `v:2` and legacy `v:1` continue to load.

## Consequences

Good:

- Reconcile is correct *by construction*, not by a patched comparison; the whole
  class of id-instability bugs is retired at the storage layer.
- Index shrinks ~34.7% (78,859 → 51,520 docs on the reference profile): less RAM,
  faster cold start — the cost centre the `v:2` native-Map work already targeted.
- The query-time dedup pass in `rank()` is **deleted**, not rewritten: dedup
  becomes structural. One less place for the folder-merge to drift.
- `upsert` becomes idempotent across sessions, so re-indexing the same message
  can no longer create a duplicate.

Costs and risks:

- **`folders[]` bookkeeping is the new bug surface.** Deleting a message from
  Inbox must not delete a document still present in All Mail; a leaked entry
  shows a folder the mail no longer occupies. Pinned by tests, red first.
- Migration must be idempotent and crash-safe: a half-migrated snapshot must
  either load as `v:2` or as complete `v:3`, never as a mix.
- The one-time repair sweep costs a full folder walk on the main thread, once per
  upgraded install. That is the price of the old keying's damage, not of the new
  design; it must never become recurring.
- The watermark cannot see back-dated arrivals; that hole is explicitly assigned
  to the deep sweep rather than left implicit.
- A periodic alarm does main-thread work. Cadence is bounded by the watermark
  making the query O(new mail), and must stay that way — a regression to a full
  walk here would reintroduce the UI-freeze class of report.

## Alternatives rejected

- **Schedule the existing `reconcile()`.** Rejected: it diffs on the unstable id,
  so a scheduled run would skip the missing messages anyway (proved by the red
  test in `test/events.test.js`). Fixing the cadence without fixing the key
  treats the symptom.
- **Key on `accountId + folderId + headerMessageId`** (preserving one doc per
  label copy). Rejected: `folderId` is session-scoped, so the key would carry the
  same instability. The stable variant needs the folder `path`, which the index
  has never stored — making it the *only* option that forces a full rebuild,
  while also keeping 27,339 redundant documents.
- **Keep the numeric key, add a side map from stable key → id.** Rejected: that
  is the same key material with an extra structure to keep consistent, and every
  write path must now update two things or drift. It buys a smaller diff and
  keeps the defect.

## Notes

This ADR waives no floor control; it changes storage keying and freshness
mechanics only.
