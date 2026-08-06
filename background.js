'use strict';
// Orchestrator: drives the search engine (which lives in a Web Worker so its
// heavy JSON + index work never touches the UI thread), applies live updates via
// the messenger.* APIs, and answers search/command messages from the UI page.
// Depends on the globals OmniIndexer, OmniEvents, OmniOpen (loaded first; see
// manifest).
// The worker owns OmniEngine/OmniStore/MiniSearch.
(function () {
  let loaded = false;
  let loadPromise = null;
  let building = false;
  let buildProgress = 0;
  let buildTotal = 0;
  let headerOnly = 0;
  let updatedAt;
  // Cached document count reported by the worker (we can't read engine.size
  // synchronously across the worker boundary).
  let engineCount = 0;
  // Last index-save error reported by the worker (null = saved OK). Surfaced in
  // status so the Settings page can warn that the index won't survive a restart.
  let saveError = null;

  // ---- Worker RPC ----
  // Shared request/response envelope for our workers: post {reqId, ...payload},
  // resolve when the worker echoes {reqId, ok, result|error} back.
  function rpcWorker(url) {
    const w = new Worker(url);
    const pending = new Map();
    let nextReqId = 1;
    w.onmessage = (e) => {
      const { reqId, ok, result, error } = e.data;
      const resolver = pending.get(reqId);
      if (!resolver) return;
      pending.delete(reqId);
      if (ok) resolver.resolve(result);
      else resolver.reject(new Error(error));
    };
    w.onerror = (e) => console.error('[OmniSearch] worker error:', e.message || e);
    return function post(payload) {
      const reqId = nextReqId++;
      return new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        w.postMessage({ reqId, ...payload });
      });
    };
  }

  // The engine (index + persistence) lives in one worker.
  const enginePost = rpcWorker('lib/engine.worker.js');
  function call(cmd, payload) {
    return enginePost({ cmd, ...payload });
  }

  // Pool of extractor workers for the CPU-heavy text extraction during a rebuild
  // — sized to the machine, so HTML stripping runs across cores. Calls are
  // round-robined; each worker queues its own requests.
  const EXTRACT_WORKERS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const extractPosts = Array.from({ length: EXTRACT_WORKERS }, () => rpcWorker('lib/extract.worker.js'));
  let extractRR = 0;
  const extractor = {
    run(mode, headerMeta, full, indexEncrypted, maxBody) {
      const post = extractPosts[extractRR++ % extractPosts.length];
      return post({ mode, headerMeta, full, indexEncrypted, maxBody });
    },
  };

  // Async stand-in for the old in-process SearchEngine. fullBuild/events talk to
  // this; each method updates the cached count from the worker's reply.
  const engineProxy = {
    // Returns the engine's full { results, errors, filters } reply, not just the
    // hits: a rejected date operator has to reach the UI, or an unparseable
    // query silently runs unfiltered and looks like it worked.
    async search(query, limit) {
      return await call('search', { query, limit });
    },
    async addAll(docs) {
      engineCount = (await call('addAll', { docs })).count;
    },
    async upsert(doc) {
      engineCount = (await call('upsert', { doc })).count;
    },
    async remove(ids) {
      engineCount = (await call('remove', { ids })).count;
    },
    async knownIds() {
      return (await call('knownIds')).ids;
    },
    async reset() {
      engineCount = (await call('reset')).count;
    },
    async clear() {
      // Purge RAM + persisted (IndexedDB) index. Refresh every cached field the
      // status() report reads so the UI immediately shows the empty state.
      const r = await call('clear');
      engineCount = r.count;
      headerOnly = r.headerOnly;
      updatedAt = r.updatedAt;
      saveError = r.saveError || null;
    },
    async flush(meta) {
      const r = await call('flush', meta || {});
      engineCount = r.count;
      headerOnly = r.headerOnly;
      saveError = r.saveError || null;
    },
  };

  function status() {
    if (building) {
      return { state: 'building', count: engineCount, total: buildTotal, headerOnly, progress: buildProgress, updatedAt };
    }
    // Not yet finished loading the persisted index. Report this explicitly (and
    // immediately — see handle('status')) so the popup keeps the "Loading…"
    // indicator up and knows precisely when the index becomes usable, instead of
    // the background going silent until the load completes.
    if (!loaded) {
      return { state: 'loading', count: engineCount, headerOnly, updatedAt };
    }
    return {
      state: engineCount > 0 ? 'ready' : 'empty',
      count: engineCount,
      headerOnly,
      updatedAt,
      saveError,
    };
  }

  // Lazy-load the persisted index on first use. Single-flight: concurrent
  // callers share one load promise, so an early search can't kick off a second
  // deserialize that races the startup one.
  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          // The worker reads IndexedDB and deserializes off the UI thread.
          const r = await call('load');
          engineCount = r.count;
          headerOnly = r.headerOnly || 0;
          updatedAt = r.updatedAt;
          saveError = r.saveError || null;
        } catch (e) {
          console.error('[OmniSearch] index load failed:', e);
        } finally {
          loaded = true;
        }
      })();
    }
    return loadPromise;
  }

  const controller = {
    get engine() {
      return engineProxy;
    },
    // Live-update handlers await this before mutating: it guarantees the worker
    // has finished loading the persisted index before any incremental update is
    // sent, so updates can't be applied to an empty index that's about to load.
    ensureLoaded,
  };

  // Full rebuild from scratch. Persistence happens once at the end (flush).
  async function rebuild() {
    if (building) return;
    await ensureLoaded();
    building = true;
    buildProgress = 0;
    headerOnly = 0;
    await engineProxy.reset();
    try {
      const result = await OmniIndexer.fullBuild(engineProxy, extractor, (fraction, _count, ho, total) => {
        buildProgress = fraction;
        headerOnly = ho;
        buildTotal = total || 0;
      });
      headerOnly = result.headerOnly;
    } finally {
      building = false;
    }
    await engineProxy.flush({ headerOnly });
  }

  // Opening a result lives in lib/open.js (globalThis.OmniOpen) so its
  // id-resolution logic — the stored numeric id is not stable across restarts —
  // can be unit-tested without Thunderbird. See test/open.test.js.

  // ---- UI message handling ----
  async function handle(msg) {
    switch (msg.type) {
      case 'search':
        await ensureLoaded();
        {
          const r = await engineProxy.search(msg.query, msg.limit || 100);
          return { type: 'results', results: r.results, errors: r.errors || [], filters: r.filters || null };
        }
      case 'status':
        // Reply immediately (don't await the load): status() reports 'loading'
        // until the index is ready, so the popup keeps getting replies during a
        // slow cold load rather than the background going silent for seconds.
        void ensureLoaded();
        return { type: 'status', status: status() };
      case 'rebuild':
        await ensureLoaded();
        void rebuild();
        return { type: 'status', status: status() };
      case 'clear':
        // Let any in-flight cold load settle first, then purge RAM + disk, so a
        // load racing the clear can't repopulate the index right after.
        await ensureLoaded();
        await engineProxy.clear();
        return { type: 'status', status: status() };
      case 'reconcile':
        await ensureLoaded();
        await OmniEvents.reconcile(controller);
        return { type: 'status', status: status() };
      case 'open':
        await OmniOpen.openMessage(msg);
        return { type: 'ok' };
      default:
        return { type: 'ok' };
    }
  }

  // The toolbar button opens the search UI as a native popup panel
  // (action.default_popup). The keyboard shortcut is bound in the manifest via
  // the reserved "_execute_action" command, which opens that same popup
  // natively — so no JS is needed to open it.

  // ---- Keep the index warm (optional) ----
  // The index lives in the worker, which dies when the event page suspends —
  // causing a cold reload on the next popup. When the user enables keepWarm, a
  // short repeating alarm keeps the page (and worker) alive so reopening is
  // instant. Best-effort: trades a little memory/battery for no cold start.
  const KEEPALIVE_ALARM = 'omnisearch-keepwarm';
  async function keepWarmEnabled() {
    try {
      const r = await messenger.storage.local.get('settings');
      return !!(r.settings && r.settings.keepWarm);
    } catch (e) {
      return false;
    }
  }
  async function applyKeepWarm() {
    try {
      await messenger.alarms.clear(KEEPALIVE_ALARM);
      if (await keepWarmEnabled()) {
        messenger.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
      }
    } catch (e) {
      console.error('[OmniSearch] keepWarm setup failed:', e);
    }
  }

  // ---- Search UI mode (toolbar popup vs Spotlight-style window) ----
  // 'spotlight' (default): clear the action popup so a click / the Alt+S command
  // fires action.onClicked, which opens ui/search.html as a centered standalone
  // window (reuses the exact same page).
  // 'popup': the toolbar button opens ui/search.html anchored to it.
  // One setting drives both button and shortcut.
  const SPOTLIGHT_W = 720;
  // Start collapsed (about the height of the search field); the page grows the
  // window downward to fit results as they appear (see fitModalWindow in
  // ui/search.js). It does NOT reposition while growing — to avoid a jerky
  // moving window — so we anchor the top up-front for the expanded height
  // (SPOTLIGHT_EXPANDED_H): the collapsed field opens high, then results fill
  // downward to land roughly vertically centered.
  const SPOTLIGHT_H = 140; // must track MODAL_MIN_H (the resize floor) in ui/search.js
  const SPOTLIGHT_EXPANDED_H = 560; // must track the height cap in fitModalWindow
  let spotlightWindowId = null;
  async function searchUIMode() {
    try {
      const r = await messenger.storage.local.get('settings');
      // Spotlight is the default: only an explicit 'popup' choice opts out.
      return r.settings && r.settings.searchUI === 'popup' ? 'popup' : 'spotlight';
    } catch (e) {
      return 'spotlight';
    }
  }
  async function applySearchUI() {
    try {
      const mode = await searchUIMode();
      await messenger.action.setPopup({ popup: mode === 'spotlight' ? '' : 'ui/search.html' });
    } catch (e) {
      console.error('[OmniSearch] search UI mode setup failed:', e);
    }
  }

  // Open (or focus) the centered search window. The top is anchored for the
  // expanded height so the field opens high and grows straight down to a roughly
  // centered results view — the window never moves once open.
  async function openSpotlight() {
    if (spotlightWindowId != null) {
      try {
        await messenger.windows.update(spotlightWindowId, { focused: true });
        return;
      } catch (e) {
        spotlightWindowId = null; // stale id — recreate below
      }
    }
    let pos = {};
    try {
      const ref = await messenger.windows.getLastFocused();
      if (ref && Number.isFinite(ref.left) && Number.isFinite(ref.width)) {
        pos = {
          left: Math.round(ref.left + (ref.width - SPOTLIGHT_W) / 2),
          top: Math.round(ref.top + Math.max(0, (ref.height - SPOTLIGHT_EXPANDED_H) / 2)),
        };
      }
    } catch (e) {
      /* no reference bounds — let the WM place it */
    }
    try {
      const win = await messenger.windows.create({
        type: 'popup',
        url: 'ui/search.html#modal',
        width: SPOTLIGHT_W,
        height: SPOTLIGHT_H,
        allowScriptsToClose: true,
        ...pos,
      });
      spotlightWindowId = win.id;
    } catch (e) {
      console.error('[OmniSearch] could not open Spotlight window:', e);
    }
  }

  // Register everything defensively: an unsupported API on a given Thunderbird
  // build must not abort the rest (which is what left the button dead before).
  function safe(label, fn) {
    try {
      fn();
    } catch (e) {
      console.error('[OmniSearch] failed to register ' + label + ':', e);
    }
  }

  safe('runtime.onMessage', () =>
    messenger.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      handle(msg).then(sendResponse);
      return true; // keep the channel open for the async response
    }),
  );

  safe('runtime.onInstalled', () =>
    messenger.runtime.onInstalled.addListener(async (details) => {
      if (details.reason === 'install') {
        await ensureLoaded();
        if (engineCount === 0) void rebuild();
      }
    }),
  );

  safe('registerEvents', () => OmniEvents.registerEvents(controller));

  // Warm the index when Thunderbird starts a session, so the first popup is fast.
  safe('runtime.onStartup', () =>
    messenger.runtime.onStartup.addListener(() => void ensureLoaded()),
  );

  // Keepalive alarm handler + (re)apply when the setting changes.
  safe('alarms.onAlarm', () =>
    messenger.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) void ensureLoaded();
    }),
  );
  // In Spotlight mode the popup is cleared, so clicking the button (and the Alt+S
  // _execute_action command, when no popup is set) fires onClicked → open window.
  safe('action.onClicked', () =>
    messenger.action.onClicked.addListener(() => void openSpotlight()),
  );
  safe('windows.onRemoved', () =>
    messenger.windows.onRemoved.addListener((id) => {
      if (id === spotlightWindowId) spotlightWindowId = null;
    }),
  );

  safe('storage.onChanged', () =>
    messenger.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        void applyKeepWarm();
        void applySearchUI();
      }
    }),
  );
  void applyKeepWarm();
  void applySearchUI();

  console.log('[OmniSearch] background loaded');
  void ensureLoaded();
})();
