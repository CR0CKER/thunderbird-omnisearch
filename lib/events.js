'use strict';
// Keeps the index correct as mail changes — the thing Gloda fails to do
// reliably. Subscribes to message events and applies incremental updates, plus
// reconcile() which re-walks folders to self-heal drift. Exposes globalThis.OmniEvents.
//
// A "controller" is { engine, ensureLoaded() } supplied by background.js, where
// engine is the async worker proxy (persistence is handled inside the worker).
(function () {
  async function upsertHeader(ctrl, header, opts) {
    const folder = header.folder;
    // Don't index messages from accounts the user excluded, or from Junk/Trash
    // unless they opted those in.
    if (folder) {
      if (opts.excluded && opts.excluded.has(folder.accountId)) return false;
      if (!opts.includeSpamTrash && OmniIndexer.isSpamOrTrash(folder)) return false;
    }
    const doc = await OmniIndexer.headerToDoc(header, opts.indexEncrypted);
    await ctrl.engine.upsert(doc);
    return true;
  }

  function headersOf(list) {
    return (list && list.messages) || [];
  }

  // The stable key for a live header — the SAME derivation the engine stores
  // under (lib/dockey.js). Never key off header.id: Thunderbird recycles those
  // every session, which is what let mail go permanently missing (docs/adr/0001).
  function keyOf(header) {
    return OmniKey.docKey({
      id: header.id,
      accountId: (header.folder && header.folder.accountId) || header.accountId || '',
      headerMessageId: header.headerMessageId || '',
    });
  }

  function folderNameOf(header) {
    return (header.folder && header.folder.name) || '';
  }

  // A message leaving ONE folder is not the message leaving the index: the same
  // mail commonly carries several Gmail/IMAP labels and is now a single document
  // listing all of them. Only when the last folder goes does the doc go.
  async function dropFromFolder(ctrl, header) {
    await ctrl.engine.removeFromFolder(keyOf(header), folderNameOf(header));
  }

  async function indexOpts() {
    return {
      excluded: await OmniIndexer.getExcludedAccounts(),
      includeSpamTrash: await OmniIndexer.getIncludeSpamTrash(),
      indexEncrypted: await OmniIndexer.getIndexEncryptedBodies(),
    };
  }

  // Wire up live incremental updates. Each listener is registered independently
  // so a single unsupported event API can't abort the others.
  function on(event, handler) {
    try {
      event.addListener(handler);
    } catch (e) {
      console.error('[OmniSearch] event listener registration failed:', e);
    }
  }

  function registerEvents(ctrl) {
    const m = messenger.messages;

    // Each handler awaits ctrl.ensureLoaded() first: the index loads
    // asynchronously now, so an event firing mid-load must wait for the real
    // engine rather than mutate the empty placeholder that's about to be swapped.
    on(m.onNewMailReceived, async (_folder, messageList) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      for (const header of headersOf(messageList)) await upsertHeader(ctrl, header, opts);
    });

    on(m.onUpdated, async (message) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      await upsertHeader(ctrl, message, opts);
    });

    on(m.onDeleted, async (messageList) => {
      await ctrl.ensureLoaded();
      // Removal is always safe regardless of inclusion settings.
      for (const header of headersOf(messageList)) await dropFromFolder(ctrl, header);
    });

    on(m.onMoved, async (originalMessages, movedMessages) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      // A message moved INTO Junk/Trash is dropped (upsertHeader skips it); one
      // moved out gets (re)indexed. Either way drop the originals' folder first.
      for (const header of headersOf(originalMessages)) await dropFromFolder(ctrl, header);
      for (const header of headersOf(movedMessages)) await upsertHeader(ctrl, header, opts);
    });

    on(m.onCopied, async (_originalMessages, copiedMessages) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      for (const header of headersOf(copiedMessages)) await upsertHeader(ctrl, header, opts);
    });
  }

  // ---- Freshness ----
  //
  // Events alone cannot keep the index correct. The extension subscribes to ALL
  // FIVE message events Thunderbird exposes, so the push surface is exhausted —
  // yet onNewMailReceived fires when a message is *received*, which structurally
  // cannot cover mail synced while Thunderbird was closed, mail filed
  // server-side, or Sent. Measured on a real profile before this change: 75% of
  // one month's Archive mail missing, 81% of INBOX, 100% of Sent.
  //
  // So freshness is a PULL, with events as the low-latency fast path on top. The
  // point is not that the pull is more thorough — it is that a dropped event now
  // costs latency instead of permanent invisibility. See docs/adr/0001.

  const DAY_MS = 24 * 60 * 60 * 1000;
  // Skew tolerance, not a rescan: mail can land a moment behind the mark (clock
  // differences, same-day boundaries), so the window reaches slightly back.
  const DEFAULT_OVERLAP_MS = DAY_MS;

  function dateMs(value) {
    if (!value) return 0;
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // Where to resume from for an account: the stored watermark, else the newest
  // date already indexed (a one-off O(docs) scan inside the worker), else the
  // epoch — which only happens on an empty index, where fullBuild is the right
  // mechanism anyway.
  async function watermarkFor(ctrl, accountId) {
    const stored = ctrl.watermarks ? await ctrl.watermarks.get(accountId) : null;
    if (stored != null) return stored;
    if (ctrl.engine && typeof ctrl.engine.maxDate === 'function') {
      return (await ctrl.engine.maxDate(accountId)) || 0;
    }
    return 0;
  }

  // Index everything newer than the watermark. Cost is O(new mail), NOT
  // O(archive): messages.query bounds the work with fromDate, so this never
  // becomes the full folder walk the worker architecture exists to avoid.
  async function catchUp(ctrl, opts = {}) {
    await ctrl.ensureLoaded();
    const now = opts.now == null ? Date.now() : opts.now;
    const overlapMs = opts.overlapMs == null ? DEFAULT_OVERLAP_MS : opts.overlapMs;
    const indexOptions = await indexOpts();
    const accounts = (await messenger.accounts.list(false)) || [];
    let scanned = 0;
    let added = 0;

    for (const account of accounts) {
      if (indexOptions.excluded && indexOptions.excluded.has(account.id)) continue;
      const mark = await watermarkFor(ctrl, account.id);
      let newest = mark;
      let list = await messenger.messages.query({
        accountId: account.id,
        fromDate: new Date(Math.max(0, mark - overlapMs)),
        includeSubFolders: true,
      });

      while (list) {
        for (const header of headersOf(list)) {
          scanned++;
          const when = dateMs(header.date);
          if (when > newest) newest = when;
          // Ask before reading: hasKey is one cheap worker round-trip, while
          // headerToDoc reads and extracts the whole message body.
          if (await ctrl.engine.hasKey(keyOf(header))) continue;
          if (await upsertHeader(ctrl, header, indexOptions)) added++;
        }
        list = list.id ? await messenger.messages.continueList(list.id) : null;
      }

      // Advance even when nothing was found, so a quiet account does not rescan
      // the same window forever. Never past `now`: a future-dated message must
      // not push the mark ahead of real time and blind the next run.
      if (ctrl.watermarks) await ctrl.watermarks.set(account.id, Math.min(Math.max(newest, mark), now));
    }

    return { scanned, added };
  }

  // Deep sweep: compare every live message against the index, removing stale
  // entries and indexing anything missing. This is the backstop for the one hole
  // the watermark cannot see — back-dated mail (an old Date header imported or
  // moved in today) lands behind the mark and is invisible to catchUp.
  //
  // It diffs on the STABLE key. It used to diff on the numeric message id, and
  // that made it a near no-op: those ids are recycled from a low, dense range
  // (measured: 99.7% of [3..79079] occupied), so after a restart nearly every
  // live id was already in the index under a DIFFERENT message, read as "already
  // indexed", and skipped. The self-heal could not heal.
  async function reconcile(ctrl) {
    await ctrl.ensureLoaded();
    const live = await OmniIndexer.collectAllMessageKeys();
    const opts = await indexOpts();
    // Pull the indexed key set once, then diff locally — cheaper than a worker
    // round-trip per message.
    const known = new Set(await ctrl.engine.knownIds());
    let added = 0;

    for (const [key, id] of live) {
      if (!known.has(key)) {
        try {
          const header = await messenger.messages.get(Number(id));
          if (await upsertHeader(ctrl, header, opts)) added++;
        } catch (e) {
          /* message vanished mid-reconcile; skip */
        }
      }
    }

    const removedKeys = [...known].filter((key) => !live.has(key));
    if (removedKeys.length) await ctrl.engine.remove(removedKeys);

    return { added, removed: removedKeys.length };
  }

  // One-time repair after migrating an index that was written under the old
  // numeric keying.
  //
  // Why this is needed at all: the catch-up resumes from a watermark, and a
  // watermark assumes everything BELOW it is already complete. An index built
  // under the broken keying violates exactly that assumption — it can be missing
  // mail from months back while still holding a message from today, so the mark
  // seeds near `now` and the pull steps straight over the hole. Only the deep
  // sweep can find those.
  //
  // The pending flag is cleared ONLY after reconcile resolves. If the sweep is
  // interrupted — Thunderbird quits, the event page suspends mid-walk — the flag
  // survives and the sweep runs again next time, because a half-finished repair
  // that marked itself done would leave mail permanently missing, which is the
  // very failure this whole change exists to end.
  async function deepSweepIfPending(ctrl) {
    if (!ctrl.sweepState) return { swept: false };
    if (!(await ctrl.sweepState.pending())) return { swept: false };
    const result = await reconcile(ctrl);
    await ctrl.sweepState.clear();
    return { swept: true, added: result.added, removed: result.removed };
  }

  globalThis.OmniEvents = { registerEvents, reconcile, catchUp, deepSweepIfPending };
})();
