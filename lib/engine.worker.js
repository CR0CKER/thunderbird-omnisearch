'use strict';
// Search-engine worker. Owns the MiniSearch index, all (de)serialization, and
// IndexedDB persistence — so the multi-second JSON.parse/stringify + index
// rebuild run OFF the UI thread and Thunderbird never freezes. The main thread
// (background.js) only does messenger.* work and talks to us via postMessage.
//
// importScripts resolves relative to this file (lib/), so the existing modules
// are reused unchanged: they attach OmniEngine / OmniStore / MiniSearch to the
// worker's globalThis, and both indexedDB and MiniSearch are available here.
importScripts('minisearch.js', 'engine.js', 'store.js');

let engine = new OmniEngine();
let headerOnly = 0;
let updatedAt;
// Last persistence error, surfaced to the UI (status). null when the last save
// succeeded. The index is built in RAM but won't survive a restart if this set.
let saveError = null;

// Best-effort: ask for persistent storage (can raise the free-disk-derived
// IndexedDB quota that may otherwise reject a large index).
(async () => {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const granted = await navigator.storage.persist();
      console.log('[OmniSearch] storage.persist():', granted);
    }
  } catch (e) {
    /* not available — ignore */
  }
})();

async function logStorageEstimate(tag) {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      const mb = (n) => (n == null ? '?' : Math.round(n / 1e6) + 'MB');
      console.log(`[OmniSearch] storage ${tag}: usage ${mb(usage)} / quota ${mb(quota)}`);
    }
  } catch (e) {
    /* ignore */
  }
}

// ---- Debounced persistence (mirrors the old background.js timing) ----
let persistTimer;
async function persistNow() {
  updatedAt = Date.now();
  const t0 = Date.now();
  await logStorageEstimate('before save');
  try {
    await OmniStore.saveIndex(engine.toData(), { count: engine.size, headerOnly, updatedAt });
    saveError = null;
    console.log(`[OmniSearch] persisted ${engine.size} docs (${engine.termCount} terms) in ${Date.now() - t0}ms`);
  } catch (err) {
    // Surface instead of swallowing — this is the thing that makes the index
    // re-build every session instead of loading from disk.
    saveError = `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`;
    console.error(`[OmniSearch] persist FAILED after ${Date.now() - t0}ms:`, err && err.name, err && err.message, `(${engine.size} docs, ${engine.termCount} terms)`);
    await logStorageEstimate('after failed save');
  }
}
function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persistNow(), 1500);
}

async function dispatch(cmd, msg) {
  switch (cmd) {
    case 'load': {
      // Instrumented so we can see where cold-load time goes (IndexedDB read vs
      // rebuilding the MiniSearch index) on large mailboxes.
      const tRead = Date.now();
      const data = await OmniStore.loadIndex();
      const tParsed = Date.now();
      if (data) {
        // A legacy on-disk snapshot (JSON string, or a v1 mini.toJSON() shape with
        // no native indexTree) had to go through the slow MiniSearch.loadJS rebuild.
        // Once it's in RAM as native Maps, rewrite it as v2 so the NEXT cold load
        // skips that rebuild — without waiting for an incremental update to fire.
        const legacy = typeof data === 'string' || !(data.mini && data.mini.indexTree);
        engine = OmniEngine.deserialize(data);
        const meta = await OmniStore.loadMeta();
        headerOnly = (meta && meta.headerOnly) || 0;
        updatedAt = meta && meta.updatedAt;
        console.log(
          `[OmniSearch] load: read ${tParsed - tRead}ms, deserialize ${Date.now() - tParsed}ms, ${engine.size} docs`,
        );
        if (legacy && engine.size > 0) {
          console.log('[OmniSearch] migrating index to v2 (native) format — next load will be fast…');
          void persistNow();
        }
      }
      return { count: engine.size, headerOnly, updatedAt, saveError };
    }
    case 'search':
      return { results: engine.search(msg.query, msg.limit || 100) };
    case 'reset':
      engine = new OmniEngine();
      headerOnly = 0;
      return { count: 0 };
    case 'clear':
      // Purge the index from RAM *and* disk (IndexedDB). Unlike 'reset' (which
      // only empties the in-RAM engine for a rebuild), this also deletes the
      // persisted snapshot so the just-cleared state survives a restart — the
      // user-facing "Clear index" action, and the real backing for SECURITY.md's
      // claim that Settings can purge the index (incl. any opted-in decrypted
      // encrypted-mail bodies).
      engine = new OmniEngine();
      headerOnly = 0;
      updatedAt = undefined;
      await OmniStore.clearIndex();
      saveError = null;
      return { count: 0, headerOnly, updatedAt, saveError };
    case 'addAll':
      // Bulk build path: no auto-persist; background calls 'flush' at the end.
      // addAllAsync yields between chunks so queued 'search' messages still get
      // answered while a rebuild is running.
      await engine.addAllAsync(msg.docs || []);
      return { count: engine.size };
    case 'upsert':
      engine.upsert(msg.doc);
      persistSoon();
      return { count: engine.size };
    case 'remove':
      for (const id of msg.ids || []) engine.remove(id);
      persistSoon();
      return { count: engine.size };
    case 'knownIds':
      return { ids: engine.knownIds() };
    case 'flush':
      if (typeof msg.headerOnly === 'number') headerOnly = msg.headerOnly;
      await persistNow();
      return { count: engine.size, headerOnly, saveError };
    default:
      return {};
  }
}

onmessage = async (e) => {
  const { reqId, cmd } = e.data;
  try {
    const result = await dispatch(cmd, e.data);
    postMessage({ reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId, ok: false, error: String((err && err.message) || err) });
  }
};
