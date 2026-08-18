'use strict';
// SearchEngine: the search-engine wrapper. The rest of the extension talks only
// to globalThis.OmniEngine, so swapping MiniSearch for FlexSearch/Orama later
// means editing this one file. Depends on globalThis.MiniSearch (lib/minisearch.js).
(function () {
  const MINISEARCH_OPTIONS = {
    // The STABLE key (accountId + RFC Message-ID), not the numeric id — see
    // lib/dockey.js and docs/adr/0001. This is what makes upsert idempotent
    // across restarts and reconcile correct by construction.
    idField: 'key',
    // Tokenised + indexed for full-text matching.
    fields: ['subject', 'from', 'to', 'body'],
    // Retained on the index for display (NOT the body — only a short preview,
    // to stay memory-lean; the full message is re-opened on click).
    //
    // `folders` replaces the old per-doc `folderName`: one message that carries
    // several Gmail/IMAP labels is now ONE document listing every folder it
    // lives in, rather than one document per label collapsed again at query
    // time. `id` is retained purely as a cache hint for opening (lib/open.js
    // validates it before trusting it) and is never used as identity.
    storeFields: ['key', 'id', 'subject', 'from', 'to', 'date', 'folders', 'accountId', 'preview', 'bodyAvailable', 'headerMessageId', 'encrypted'],
  };

  const SEARCH_OPTIONS = {
    // Boost matches in headers above the body, like OmniSearch boosts titles.
    boost: { subject: 3, from: 2, to: 1.5, body: 1 },
    // Typo tolerance (edit distance) + "as you type" prefix matching.
    fuzzy: 0.2,
    prefix: true,
    combineWith: 'AND',
  };

  // Recency boost. MiniSearch ranks on BM25 alone, so before this a message's
  // date played NO part in ranking (it is a storeFields value, for display), and
  // its `byScore` comparator has no secondary key — exact ties therefore fell
  // back to inverted-index posting order, i.e. roughly the folder-walk order of
  // the last full build. Old mail outranked new for no visible reason.
  //
  // The fix is a bounded multiplier on the text score: 1 + strength * 0.5^(age /
  // halfLife) — the exponential decay Lucene/Elasticsearch use. Newest mail gets
  // 2.5x, still 1.75x after a year, ~1.1x after five.
  //
  // This is the deliberately assertive ("Gmail-like") setting; an earlier
  // 1.6x/180d curve tested as too weak. Because the newest-vs-ancient ratio is
  // 1+strength, age alone can now overturn a text-score gap of up to 2.5x
  // (previously 1.6x) — that is the whole point, and the reason it can push a
  // strongly-matching old email below a decently-matching recent one.
  //
  // It does NOT flatten the field boosts, which is worth knowing before tuning:
  // measured, a subject hit still outranks a same-day body-only hit even when
  // the subject hit is ten years old (2.89 vs 2.40). Subject/sender matching
  // survives; it is same-field comparisons that recency now dominates.
  // If relevance feels blunted, lower `strength` before touching `halfLifeDays`.
  //
  // No index rebuild is needed: `date` is already stored on every doc.
  //
  // TODO: expose as a Settings preset (Off/Subtle/Balanced/Strong), mirroring
  // the bodyIndexLimit <select> in options/options.html — cached in
  // background.js and invalidated by the existing storage.onChanged listener,
  // then passed through as the `recency` search option.
  const RECENCY = { strength: 1.5, halfLifeDays: 365 };
  // Used when the query carries an explicit date range — see search().
  const RECENCY_OFF = { strength: 0, halfLifeDays: 365 };
  const DAY_MS = 24 * 60 * 60 * 1000;

  // How many results one page carries, and how deep paging may go in total.
  //
  // DEFAULT_LIMIT is a *page* size, not a ceiling on what the user can reach —
  // rank() orders every match and page() serves windows of it, so a result at
  // position 900 is three scrolls away rather than unreachable.
  //
  // MAX_RESULTS is the backstop, and it is deliberately not a user setting.
  // SEARCH_OPTIONS sets `prefix: true`, so the first keystroke of any search
  // ("m") matches every message containing a word starting with that letter —
  // most of the archive. Each result carries a 200-char preview and crosses two
  // structured-clone hops, the middle one on Thunderbird's UI thread, so an
  // unbounded payload freezes the whole application while you type. 5000 is ~50
  // pages, far past the point where relevance ranking still means anything.
  // How many docs addAllAsync indexes before yielding to the event loop.
  const ADD_CHUNK = 500;

  const DEFAULT_LIMIT = 100;
  const MAX_RESULTS = 5000;

  class SearchEngine {
    constructor() {
      this.mini = new MiniSearch(MINISEARCH_OPTIONS);
      // Set by deserialize() when a v1/v2 (numeric-keyed) snapshot was re-keyed.
      this.migratedFromLegacyKey = false;
      // MiniSearch has no public "enumerate all ids" API, so we track them
      // alongside the index to drive reconciliation.
      this.ids = new Set();
    }

    get size() {
      return this.mini.documentCount;
    }

    // Number of unique index terms — a proxy for index/memory size, for
    // diagnostics. Reaches into MiniSearch internals (the inverted index Map).
    get termCount() {
      return (this.mini && this.mini._index && this.mini._index.size) || 0;
    }

    has(key) {
      return this.ids.has(key);
    }

    // Alias with the name the freshness paths use: what they hold is a stable
    // key, and calling it an id is exactly the confusion that produced the
    // stale-index bug in the first place.
    hasKey(key) {
      return this.ids.has(key);
    }

    knownIds() {
      return [...this.ids];
    }

    // Newest indexed message date for an account, used to seed the catch-up
    // watermark the first time (before one has been stored). O(docs), but it
    // runs once, inside the engine worker — never on the UI thread.
    maxDate(accountId) {
      let newest = 0;
      for (const stored of this.mini._storedFields.values()) {
        if (!stored || (accountId && stored.accountId !== accountId)) continue;
        const date = stored.date || 0;
        if (date > newest) newest = date;
      }
      return newest;
    }

    // The stable key for a doc. Static so callers can key without an instance;
    // the derivation itself lives in lib/dockey.js because the main thread needs
    // the identical rule (see that file).
    static docKey(doc) {
      return OmniKey.docKey(doc);
    }

    // Normalise an incoming doc into stored shape: stamp the key, and fold a
    // single `folderName` into the `folders` list. The indexer may hand over
    // either shape, and accepting both keeps the extractor and the event paths
    // from each having to know about the collapse.
    static prepare(doc) {
      const folders = [];
      const push = (name) => {
        if (name && !folders.includes(name)) folders.push(name);
      };
      if (Array.isArray(doc.folders)) doc.folders.forEach(push);
      push(doc.folderName);
      const out = { ...doc, key: SearchEngine.docKey(doc), folders };
      delete out.folderName;
      return out;
    }

    addAll(docs) {
      // NOT mini.addAll(): a full build feeds every label copy of a message as
      // its own doc, so the batch itself contains duplicates of one key. They
      // must merge into a single document with a merged folder list, exactly as
      // an incremental upsert would.
      for (const doc of docs) this.upsert(doc);
    }

    // Yields to the event loop between chunks, so the worker can answer search
    // messages mid-build — search stays available while indexing. The index is
    // consistent between chunks (single-threaded).
    async addAllAsync(docs) {
      let sinceYield = 0;
      for (const doc of docs) {
        this.upsert(doc);
        if (++sinceYield >= ADD_CHUNK) {
          sinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    // Idempotent across sessions: keyed on stable identity, re-indexing the same
    // message can no longer create a second document, however many times its
    // numeric id has been recycled in between.
    upsert(doc) {
      const next = SearchEngine.prepare(doc);
      const key = next.key;
      if (this.ids.has(key)) {
        // Merge rather than overwrite: this may be a second label copy of a
        // message already indexed from another folder, and dropping the folders
        // already recorded would lose where the mail lives.
        const prev = this.mini.getStoredFields(key);
        if (prev && Array.isArray(prev.folders)) {
          for (const name of prev.folders) {
            if (name && !next.folders.includes(name)) next.folders.push(name);
          }
        }
        this.mini.replace(next);
      } else {
        this.mini.add(next);
      }
      this.ids.add(key);
    }

    remove(key) {
      if (this.ids.has(key)) {
        this.mini.discard(key);
        this.ids.delete(key);
      }
    }

    // Folder-scoped removal — the bookkeeping the label collapse introduces.
    // A message deleted from Inbox while it still sits in All Mail must lose the
    // folder, NOT the document; only when the last folder goes does the mail
    // actually leave the index.
    removeFromFolder(key, folderName) {
      if (!this.ids.has(key)) return;
      const prev = this.mini.getStoredFields(key);
      const folders = (prev && Array.isArray(prev.folders) ? prev.folders : []).filter(
        (name) => name !== folderName,
      );
      if (!folders.length) {
        this.remove(key);
        return;
      }
      this.mini.replace({ ...prev, key, folders });
    }

    // Score multiplier for a message's age. Pure and static so it can be unit-
    // tested without MiniSearch. See the RECENCY comment above for the shape.
    //
    // Two edges matter:
    //  - The age is clamped at 0. Without that, 0.5^negative grows without
    //    bound, so a future-dated message would rocket to the top — and dating
    //    mail in the future is a known trick for sitting atop sorted lists.
    //  - A falsy date (an unparseable header, or a doc from an index predating
    //    the stored `date`) is neutral 1x, not maximally penalised.
    //  - A non-positive half-life disables the boost rather than producing NaN
    //    (age 0 / half-life 0 is 0/0), so a bad future setting value can never
    //    poison the sort with NaN scores.
    static recencyFactor(date, now, opts = RECENCY) {
      const strength = opts && opts.strength;
      const halfLifeDays = opts && opts.halfLifeDays;
      if (!strength || !date || !(halfLifeDays > 0)) return 1;
      const ageDays = Math.max(0, now - date) / DAY_MS;
      return 1 + strength * Math.pow(0.5, ageDays / halfLifeDays);
    }

    // The same email appears once per Gmail/IMAP label it carries (All Mail +
    // Inbox/Archive/Sent…), each as its own doc with the same RFC Message-ID. We
    // collapse those into one result, keeping the best-scoring instance and
    // merging every folder it lives in. Dedup is scoped per account (accountId +
    // Message-ID) so an identical Message-ID in two accounts isn't merged;
    // messages with no Message-ID are keyed by id so they never collapse.
    //
    // The deduplicated results are then re-scored by recency and re-sorted. Only
    // AFTER that does page() take a window of them — slicing first would return
    // the top-N by raw text score and merely reorder those, so a newer message
    // just outside that top-N could never surface. Every label copy of a message
    // shares one date, so boosting after dedup cannot change which copy wins.
    //
    // Query operators (date:/after:/before:/from:/to:) are stripped by
    // OmniQuery and turned into a MiniSearch `filter` over STORED fields, which
    // is why they need no reindex — and why from:/to: are genuinely field-scoped
    // where a tokenized term matches any field in the document.
    //
    // Returns { ranked, errors, filters, applied, text } rather than a bare array:
    // a rejected date MUST reach the user. Silently dropping it would run an
    // unfiltered search that looks like it worked, which is the exact failure the
    // parser's reject-don't-guess rule exists to prevent.
    //
    // `ranked` is the COMPLETE ordered list, not a page. Callers slice it with
    // page(); the worker caches it so that paging never re-ranks (see
    // lib/engine.worker.js for why re-ranking would corrupt a page boundary).
    //
    // `opts` carries `now` and a `recency` curve; both exist so tests can drive
    // ranking deterministically, and they are the seam a future Settings preset
    // will use.
    rank(query, opts = {}) {
      const now = opts.now == null ? Date.now() : opts.now;
      const parsed = OmniQuery.parse(query, now);
      const { filters, errors, applied } = parsed;
      const q = parsed.text;
      const predicate = OmniQuery.toPredicate(filters);
      const empty = { ranked: [], errors, filters, applied, text: q };
      // With no text and no filters there is nothing to ask for. With filters
      // but no text, the wildcard query matches everything and the filter does
      // the work — MiniSearch skips its own sort in that case, which is fine
      // because we sort below regardless.
      if (!q && !predicate) return empty;

      // An explicit date range is itself a statement of time intent, so the
      // recency boost is damped there — otherwise it re-sorts the window toward
      // its newest edge and fights the instruction the user just gave.
      const dated = filters.after != null || filters.before != null;
      const recency = opts.recency || (dated ? RECENCY_OFF : RECENCY);

      const searchOptions = predicate ? { ...SEARCH_OPTIONS, filter: predicate } : SEARCH_OPTIONS;
      const hits = q
        ? this.mini.search(q, searchOptions)
        : this.mini.search(MiniSearch.wildcard, searchOptions); // descending score order
      // No dedup pass here any more. Label copies used to arrive as separate
      // documents sharing one Message-ID and were collapsed at query time; they
      // are now ONE document carrying folders[], so the collapse is structural
      // (docs/adr/0001). Deleting this loop is the point: a merge that runs once
      // at write time cannot drift from a merge that ran on every keystroke.
      const out = hits.map((h) => {
        const folders = Array.isArray(h.folders) ? h.folders.filter(Boolean) : [];
        return {
          // A cache hint for opening, never identity — lib/open.js re-resolves
          // by Message-ID and validates this before trusting it.
          id: String(h.id),
          headerMessageId: h.headerMessageId || '',
          // Carried through to the UI and back on open: a Message-ID can exist
          // in two accounts, and opening must reopen the copy from the account
          // this result was indexed from (lib/open.js).
          accountId: h.accountId || '',
          encrypted: !!h.encrypted,
          score: h.score,
          subject: h.subject || '',
          from: h.from || '',
          to: h.to || '',
          date: h.date || 0,
          folderName: folders[0] || '', // primary (back-compat); see folders
          folders,
          preview: h.preview || '',
          bodyAvailable: h.bodyAvailable !== false,
        };
      });
      for (const rec of out) rec.score *= SearchEngine.recencyFactor(rec.date, now, recency);
      // The date secondary key removes the last arbitrary ordering: without it,
      // an exact score tie keeps MiniSearch's posting order. It is applied even
      // when the boost is off, so "no recency boost" still means a stable,
      // explicable order rather than folder-walk order.
      out.sort((a, b) => b.score - a.score || b.date - a.date);
      return { ranked: out, errors, filters, applied, text: q };
    }

    // Slice one page out of a ranked list, with the metadata the UI needs to say
    // "showing 100 of 1,247" and to know whether scrolling further is worth it.
    //
    // `total` is free: rank() has already materialised and deduplicated the whole
    // list, so counting it costs nothing. It is the count of unique *messages*
    // (post-dedup), not raw MiniSearch hits — a Gmail message carrying three
    // labels contributes one, which is what the user is counting too.
    //
    // Static because the worker pages a *cached* ranked array without re-running
    // the query; see lib/engine.worker.js.
    static page(ranked, limit = DEFAULT_LIMIT, offset = 0, meta = {}) {
      const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), MAX_RESULTS) : DEFAULT_LIMIT;
      const start = Number.isFinite(offset) && offset > 0 ? Math.min(Math.trunc(offset), MAX_RESULTS) : 0;
      // The ceiling bounds the last reachable index, not just one page, so a
      // caller cannot walk past it by asking for offset 4999 with limit 1000.
      const end = Math.min(start + size, MAX_RESULTS, ranked.length);
      return {
        results: ranked.slice(start, end),
        total: ranked.length,
        offset: start,
        // Distinct from `total > offset + results.length`: at the ceiling there
        // are more matches but none of them are reachable, and the UI has to say
        // so rather than offering a scroll that yields nothing.
        hasMore: end < Math.min(ranked.length, MAX_RESULTS),
        capped: ranked.length > MAX_RESULTS,
        errors: meta.errors || [],
        filters: meta.filters || null,
        applied: meta.applied || [],
        text: meta.text || '',
      };
    }

    // Convenience wrapper preserving the original one-shot contract: rank, then
    // take the first page. The worker uses rank()/page() separately so that
    // paging never re-ranks.
    search(query, limit = DEFAULT_LIMIT, opts = {}) {
      const r = this.rank(query, opts);
      return SearchEngine.page(r.ranked, limit, opts.offset, r);
    }

    // A structured-clone-safe snapshot of the index, stored in IndexedDB as an
    // object (NOT a JSON string). We hand IndexedDB MiniSearch's *native* internal
    // Maps/Set directly — structured clone (de)serializes Map/Set in C++, far
    // faster than mini.toJSON()/loadJS, which flatten Maps→objects on save and
    // rebuild objects→Maps (with a parseInt per posting) on every cold load. The
    // whole MiniSearch state is nested Maps with string/number keys and the leaf
    // sentinel '' (a string, not a Symbol), so it clones cleanly. These fields
    // reference live objects; clone snapshots them during the put. The index isn't
    // mutated during a flush, so referencing the live Maps is safe.
    toData() {
      const m = this.mini;
      return {
        // v:3 — documents keyed on the stable key with folders[] (docs/adr/0001).
        // v:2 (numeric key, per-label docs) still loads and is migrated in place
        // on read, then rewritten as v:3 on the next persist.
        v: 3,
        mini: {
          documentCount: m._documentCount,
          nextId: m._nextId,
          fieldIds: m._fieldIds,
          averageFieldLength: m._avgFieldLength,
          dirtCount: m._dirtCount,
          documentIds: m._documentIds, // Map
          fieldLength: m._fieldLength, // Map
          storedFields: m._storedFields, // Map
          indexTree: m._index._tree, // radix tree: nested Maps
        },
        ids: this.ids, // Set
      };
    }

    // Rebuild from a toData() snapshot. Runs only inside the engine worker (off
    // the UI thread), so the synchronous loader is fine. Three formats are
    // handled: v2 native (assign fields, no loadJS — the fast path), legacy v1
    // (mini.toJSON() shape → loadJS), and an even older JSON string. An existing
    // v1 index loads via loadJS and is rewritten as v2 on the next persist, so the
    // upgrade is seamless (no forced rebuild).
    static deserialize(data) {
      if (typeof data === 'string') data = JSON.parse(data);
      const engine = new SearchEngine();
      const m = data.mini;
      const legacyKey = !(data.v >= 3); // v1/v2 are keyed on the numeric id
      if (m && m.indexTree) {
        // v2 native: reuse the constructor's empty SearchableMap and swap its
        // _tree, so we don't need access to MiniSearch's internal class.
        const ms = engine.mini;
        ms._documentCount = m.documentCount;
        ms._nextId = m.nextId;
        ms._fieldIds = m.fieldIds;
        ms._avgFieldLength = m.averageFieldLength;
        ms._dirtCount = m.dirtCount || 0;
        ms._documentIds = m.documentIds;
        ms._fieldLength = m.fieldLength;
        ms._storedFields = m.storedFields;
        ms._idToShortId = new Map();
        for (const [shortId, id] of ms._documentIds) ms._idToShortId.set(id, shortId);
        ms._index._tree = m.indexTree;
        ms._index._size = undefined; // force lazy recompute
      } else {
        engine.mini = MiniSearch.loadJS(m, MINISEARCH_OPTIONS);
      }
      // ids may come back as a Set (v2/v3, cloned natively) or an array (legacy).
      engine.ids = data.ids instanceof Set ? data.ids : new Set(data.ids || []);
      if (legacyKey) {
        engine.migrateToStableKey();
        // Flagged for the caller, not just for logging: an index written under
        // the old keying may be MISSING mail (reconcile could not self-heal
        // then), so migrating it is the signal to run one deep sweep. See
        // docs/adr/0001 and OmniEvents.deepSweepIfPending.
        engine.migratedFromLegacyKey = engine.size > 0;
      }
      return engine;
    }

    // Re-key a v1/v2 index onto the stable key, IN PLACE — no message is
    // re-read and no rebuild is forced (docs/adr/0001).
    //
    // This is possible because MiniSearch's inverted index refers to documents
    // only by INTERNAL short ids; the external id appears solely in
    // _documentIds. Both fields the stable key needs (accountId,
    // headerMessageId) are already in storedFields. So re-keying is a rewrite of
    // one map, plus a merge of the label copies that now share a key.
    //
    // The merge uses discard(), which leaves the losers' postings in the index
    // until a vacuum — that is safe, because the query path skips any posting
    // whose short id is no longer in _documentIds (and cleans it up lazily), so
    // a discarded duplicate can never surface as a ghost result.
    migrateToStableKey() {
      const ms = this.mini;
      const survivors = new Map(); // key -> short id
      const duplicates = [];

      for (const [shortId, oldId] of ms._documentIds) {
        const stored = ms._storedFields.get(shortId) || {};
        // storedFields is the only source here; the numeric id is preserved as
        // the cache hint it now is, falling back to the old external id.
        const doc = {
          id: stored.id == null ? oldId : stored.id,
          accountId: stored.accountId,
          headerMessageId: stored.headerMessageId,
        };
        const key = OmniKey.docKey(doc);
        const folders = [];
        const push = (name) => {
          if (name && !folders.includes(name)) folders.push(name);
        };
        if (Array.isArray(stored.folders)) stored.folders.forEach(push);
        push(stored.folderName);

        const winner = survivors.get(key);
        if (winner == null) {
          survivors.set(key, shortId);
          const next = { ...stored, key, id: String(doc.id), folders };
          delete next.folderName;
          ms._storedFields.set(shortId, next);
        } else {
          // A second label copy of a message already kept: fold its folder into
          // the survivor and drop this document.
          const kept = ms._storedFields.get(winner);
          if (kept) {
            for (const name of folders) {
              if (!kept.folders.includes(name)) kept.folders.push(name);
            }
          }
          duplicates.push(shortId);
        }
      }

      // Rewrite the external ids, then let discard() do the bookkeeping for the
      // duplicates (document count, field lengths, dirt count) rather than
      // hand-unpicking MiniSearch's internals.
      ms._idToShortId = new Map();
      for (const [key, shortId] of survivors) {
        ms._documentIds.set(shortId, key);
        ms._idToShortId.set(key, shortId);
      }
      for (const shortId of duplicates) {
        // Still the OLD external id: only survivors were rewritten above. It
        // cannot collide with a new key (those carry a NUL or an 'id:' prefix).
        const oldExternalId = ms._documentIds.get(shortId);
        // Point the lookup at this duplicate just long enough for discard() to
        // find it; the survivors' mappings are restored immediately after.
        ms._idToShortId.set(oldExternalId, shortId);
        ms.discard(oldExternalId);
      }
      for (const [key, shortId] of survivors) ms._idToShortId.set(key, shortId);

      this.ids = new Set(survivors.keys());
    }
  }

  // Paging constants are read by the worker (ceiling checks) and by tests.
  SearchEngine.DEFAULT_LIMIT = DEFAULT_LIMIT;
  SearchEngine.MAX_RESULTS = MAX_RESULTS;

  globalThis.OmniEngine = SearchEngine;
})();
