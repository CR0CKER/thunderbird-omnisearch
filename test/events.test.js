'use strict';
// Tests for lib/events.js — keeping the index correct as mail changes.
//
// Run with the system node (no dependencies, no install):
//     node --test test/
//
// Why these tests exist: reconcile() is the documented self-heal — "Guarantees a
// message can never stay permanently hidden because an event was dropped". It
// earns that only if its diff is keyed on something stable. It is keyed on the
// numeric Thunderbird id, which is "an internal tracking number that does not
// remain after a restart" (see test/open.test.js for the same hazard on the open
// path). Those ids are handed out from a low, dense, contiguous range: a live
// index observed here held 78,859 docs whose ids covered 99.7% of [3..79079].
// So after a restart nearly every live id is already present in the index under
// a DIFFERENT message, reconcile reads that as "already indexed", and the
// missing message stays missing forever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EVENTS_JS = path.join(__dirname, '..', 'lib', 'events.js');
const source = fs.readFileSync(EVENTS_JS, 'utf8');

// lib/events.js is an IIFE assigning globalThis.OmniEvents, calling the globals
// `messenger` and `OmniIndexer`. Same vm-injection trick as open.test.js.
function loadOmniEvents(sandboxExtras) {
  const errors = [];
  const sandbox = Object.assign(
    { console: { error: (...a) => errors.push(a) } },
    sandboxExtras,
  );
  vm.createContext(sandbox);
  // lib/dockey.js is a background script alongside lib/events.js in
  // manifest.json, and events.js calls OmniKey.docKey — load it the same way.
  const dockey = path.join(__dirname, '..', 'lib', 'dockey.js');
  vm.runInContext(fs.readFileSync(dockey, 'utf8'), sandbox, { filename: dockey });
  vm.runInContext(source, sandbox, { filename: EVENTS_JS });
  return { OmniEvents: sandbox.OmniEvents, errors };
}

// A fake world: `live` maps the CURRENT numeric id to a message; `indexed` is
// what the engine already holds, keyed the way the engine keys it (by id).
function makeWorld({ live, indexed }) {
  const liveMap = new Map(live.map((m) => [String(m.id), m]));
  const store = new Map(
    indexed.map((d) => [(d.accountId || 'account1') + '\0' + d.headerMessageId, d]),
  );

  const messenger = {
    messages: {
      async get(id) {
        const m = liveMap.get(String(id));
        if (!m) throw new Error('no message with id ' + id);
        return m;
      },
    },
  };

  const key = (m) => (m.accountId || 'account1') + '\0' + m.headerMessageId;

  const OmniIndexer = {
    // stableKey -> numeric id, as lib/indexer.js now returns.
    async collectAllMessageKeys() {
      return new Map([...liveMap.values()].map((m) => [key(m), String(m.id)]));
    },
    async headerToDoc(header) {
      return {
        id: String(header.id),
        accountId: header.accountId || 'account1',
        headerMessageId: header.headerMessageId,
      };
    },
    async getExcludedAccounts() {
      return new Set();
    },
    async getIncludeSpamTrash() {
      return false;
    },
    async getIndexEncryptedBodies() {
      return false;
    },
    isSpamOrTrash() {
      return false;
    },
  };

  const ctrl = {
    async ensureLoaded() {},
    engine: {
      async knownIds() {
        return [...store.keys()];
      },
      async upsert(doc) {
        store.set(key(doc), doc);
      },
      async remove(keys) {
        for (const k of keys) store.delete(k);
      },
      async removeFromFolder(k) {
        store.delete(k);
      },
    },
  };

  const indexedMessageIds = () =>
    new Set([...store.values()].map((d) => d.headerMessageId));

  return { messenger, OmniIndexer, ctrl, indexedMessageIds };
}

test('reconcile indexes a message the events missed', async () => {
  // The plain case: one live message absent from the index, no id reuse.
  const world = makeWorld({
    live: [
      { id: 7, headerMessageId: 'kept@example.com' },
      { id: 8, headerMessageId: 'missed@example.com' },
    ],
    indexed: [{ id: 7, headerMessageId: 'kept@example.com' }],
  });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.reconcile(world.ctrl);

  assert.ok(
    world.indexedMessageIds().has('missed@example.com'),
    'a message missing from the index must be added by reconcile',
  );
});

test('reconcile indexes a missed message whose numeric id was reused after a restart', async () => {
  // The real-world case. Thunderbird reissues numeric ids each session, so the
  // id an old doc was stored under now addresses a different message. Here id 42
  // used to be 'old@example.com' (still in the index, stale) and now belongs to
  // 'new@example.com', which was never indexed because its arrival event was
  // dropped. reconcile must notice that the INDEXED message and the LIVE message
  // are not the same mail.
  const world = makeWorld({
    live: [{ id: 42, headerMessageId: 'new@example.com' }],
    indexed: [{ id: 42, headerMessageId: 'old@example.com' }],
  });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.reconcile(world.ctrl);

  assert.ok(
    world.indexedMessageIds().has('new@example.com'),
    'reconcile must index the live message even when its numeric id was already ' +
      'present in the index under a different message',
  );
});

// ---------------------------------------------------------------------------
// Watermark catch-up — see docs/adr/0001-stable-document-key-and-watermark-
// catchup.md.
//
// Why these tests exist: index freshness currently depends on every
// WebExtension event arriving. The extension already subscribes to ALL FIVE
// message events that exist, so the push surface is exhausted and the gap cannot
// be closed by listening harder — onNewMailReceived fires when a message is
// *received*, which structurally cannot cover mail synced while Thunderbird was
// closed, mail filed server-side, or Sent. Measured on a real profile: 75% of
// August mail missing from Archive, 81% from INBOX, 100% from Sent.
//
// The fix is a pull keyed on a high-water mark, so a dropped event costs
// LATENCY, not permanent invisibility. These tests pin the two properties that
// make it viable: it must actually catch what the events missed, and it must
// stay O(new mail) — a regression to a full folder walk would reintroduce the
// main-thread cost the worker architecture exists to avoid.

// A fake Thunderbird whose messages.query() honours fromDate/accountId and pages
// through continueList(), matching the shipped schema (TB 153):
//   query(queryInfo) -> MessageList { id, messages }
function makeMailHost(messages, { pageSize = 100 } = {}) {
  const queries = [];
  const pages = new Map();
  let nextListId = 1;

  function serve(matching) {
    const first = matching.slice(0, pageSize);
    const rest = matching.slice(pageSize);
    if (!rest.length) return { id: null, messages: first };
    const listId = String(nextListId++);
    pages.set(listId, rest);
    return { id: listId, messages: first };
  }

  return {
    queries,
    messenger: {
      accounts: {
        async list() {
          return [{ id: 'account1' }];
        },
      },
      messages: {
        async query(queryInfo) {
          queries.push(queryInfo);
          const from = queryInfo.fromDate ? new Date(queryInfo.fromDate).getTime() : -Infinity;
          const matching = messages.filter(
            (m) => m.date.getTime() >= from && (!queryInfo.accountId || m.accountId === queryInfo.accountId),
          );
          return serve(matching);
        },
        async continueList(listId) {
          const rest = pages.get(listId) || [];
          pages.delete(listId);
          return serve(rest);
        },
        async list() {
          throw new Error('catch-up must not walk whole folders — it must query from the watermark');
        },
      },
    },
  };
}

function makeCatchUpWorld({ messages, indexedKeys = [], watermark }) {
  const host = makeMailHost(messages);
  const keys = new Set(indexedKeys);
  const added = [];
  const marks = new Map(watermark == null ? [] : [['account1', watermark]]);

  const OmniIndexer = {
    async headerToDoc(header) {
      return {
        id: String(header.id),
        accountId: header.accountId,
        headerMessageId: header.headerMessageId,
        folderName: header.folder && header.folder.name,
        date: header.date.getTime(),
      };
    },
    async getExcludedAccounts() { return new Set(); },
    async getIncludeSpamTrash() { return false; },
    async getIndexEncryptedBodies() { return false; },
    isSpamOrTrash() { return false; },
  };

  const docKey = (d) => (d.accountId || '') + '\0' + d.headerMessageId;

  const ctrl = {
    async ensureLoaded() {},
    watermarks: {
      async get(accountId) { return marks.get(accountId); },
      async set(accountId, ms) { marks.set(accountId, ms); },
    },
    engine: {
      async hasKey(key) { return keys.has(key); },
      async upsert(doc) {
        keys.add(docKey(doc));
        added.push(doc);
      },
      async remove() {},
      async knownIds() { return []; },
    },
  };

  return { host, ctrl, added, marks, OmniIndexer };
}

function header(over = {}) {
  return Object.assign(
    {
      id: 42,
      accountId: 'account1',
      headerMessageId: 'mesh@mail.gmail.com',
      date: new Date('2026-08-17T18:18:00Z'),
      folder: { name: 'Archive', accountId: 'account1' },
    },
    over,
  );
}

test('catchUp indexes mail that arrived while the events were not delivered', async () => {
  const world = makeCatchUpWorld({
    messages: [header()],
    watermark: Date.parse('2026-08-01T00:00:00Z'),
  });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.host.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.catchUp(world.ctrl, { now: Date.parse('2026-08-18T21:00:00Z') });

  assert.deepEqual(
    world.added.map((d) => d.headerMessageId),
    ['mesh@mail.gmail.com'],
    'a message the events missed must be picked up by the watermark pull',
  );
});

test('catchUp queries forward from the watermark, not across the whole archive', async () => {
  const watermark = Date.parse('2026-08-01T00:00:00Z');
  const world = makeCatchUpWorld({ messages: [header()], watermark });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.host.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.catchUp(world.ctrl, { now: Date.parse('2026-08-18T21:00:00Z') });

  const [q] = world.host.queries;
  assert.ok(q, 'catchUp must issue a messages.query()');
  assert.ok(q.fromDate != null, 'the query must be bounded by fromDate — an unbounded query is a full scan');
  const from = new Date(q.fromDate).getTime();
  assert.ok(
    from > 0 && from <= watermark,
    `fromDate must sit at or just before the watermark (got ${new Date(from).toISOString()})`,
  );
  assert.ok(
    watermark - from <= 7 * 24 * 60 * 60 * 1000,
    'the overlap window must stay small — it is skew tolerance, not a rescan',
  );
});

test('catchUp still catches a message dated just before the watermark', async () => {
  // Clock skew and same-day boundaries: an overlap window is why the pull does
  // not drop mail that lands a moment behind the mark.
  const watermark = Date.parse('2026-08-17T18:00:00Z');
  const world = makeCatchUpWorld({
    messages: [header({ date: new Date('2026-08-17T17:30:00Z') })],
    watermark,
  });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.host.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.catchUp(world.ctrl, { now: Date.parse('2026-08-18T21:00:00Z') });

  assert.equal(world.added.length, 1, 'a message just behind the watermark must still be caught');
});

test('catchUp skips mail already indexed, so a quiet run costs nothing', async () => {
  const world = makeCatchUpWorld({
    messages: [header()],
    indexedKeys: ['account1\0mesh@mail.gmail.com'],
    watermark: Date.parse('2026-08-01T00:00:00Z'),
  });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.host.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.catchUp(world.ctrl, { now: Date.parse('2026-08-18T21:00:00Z') });

  assert.equal(world.added.length, 0, 'catch-up must not re-index mail it already has');
});

test('catchUp advances the watermark so the next run stays cheap', async () => {
  const world = makeCatchUpWorld({
    messages: [header()],
    watermark: Date.parse('2026-08-01T00:00:00Z'),
  });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.host.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.catchUp(world.ctrl, { now: Date.parse('2026-08-18T21:00:00Z') });

  const mark = world.marks.get('account1');
  assert.ok(
    mark >= header().date.getTime(),
    'the watermark must advance past the newest message seen, or every run rescans the same window',
  );
});

test('catchUp follows pagination instead of indexing only the first page', async () => {
  // messages.query() returns a MessageList with a continuation id; stopping at
  // page one would silently index a prefix of the new mail.
  const messages = Array.from({ length: 250 }, (_, i) =>
    header({
      id: 1000 + i,
      headerMessageId: `bulk-${i}@example.com`,
      date: new Date(Date.parse('2026-08-10T00:00:00Z') + i * 1000),
    }),
  );
  const world = makeCatchUpWorld({ messages, watermark: Date.parse('2026-08-01T00:00:00Z') });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.host.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await OmniEvents.catchUp(world.ctrl, { now: Date.parse('2026-08-18T21:00:00Z') });

  assert.equal(world.added.length, 250, 'every page of the query must be consumed');
});

// ---------------------------------------------------------------------------
// One-time deep sweep after migrating a faulty index.
//
// Why these tests exist: the watermark catch-up assumes everything below the
// mark is already indexed. An index written under the old numeric keying breaks
// that assumption — it can be missing months of mail while still holding a
// message from today, so the mark seeds near now and the pull skips the hole
// entirely. Everyone upgrading carries such an index, so migration must trigger
// one deep sweep, and that sweep must be durable: marking it done before it
// finishes would leave mail permanently missing.

function makeSweepWorld({ pending, reconcileThrows = false }) {
  const world = makeWorld({
    live: [
      { id: 7, headerMessageId: 'kept@example.com' },
      { id: 8, headerMessageId: 'missed@example.com' },
    ],
    indexed: [{ id: 7, headerMessageId: 'kept@example.com' }],
  });
  let isPending = pending;
  const cleared = [];
  world.ctrl.sweepState = {
    async pending() { return isPending; },
    async clear() { isPending = false; cleared.push(true); },
  };
  if (reconcileThrows) {
    world.OmniIndexer.collectAllMessageKeys = async () => {
      throw new Error('interrupted mid-walk');
    };
  }
  world.cleared = cleared;
  world.stillPending = () => isPending;
  return world;
}

test('a migrated index gets one deep sweep, which finds what the watermark cannot', async () => {
  const world = makeSweepWorld({ pending: true });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  const r = await OmniEvents.deepSweepIfPending(world.ctrl);

  assert.equal(r.swept, true);
  assert.ok(
    world.indexedMessageIds().has('missed@example.com'),
    'the sweep must index mail the faulty index never recorded',
  );
  assert.equal(world.stillPending(), false, 'a completed sweep must not run again');
});

test('an index that never needed the sweep does not pay for one', async () => {
  const world = makeSweepWorld({ pending: false });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  const r = await OmniEvents.deepSweepIfPending(world.ctrl);

  assert.equal(r.swept, false);
  assert.equal(world.added === undefined ? 0 : world.added.length, 0);
});

test('an interrupted sweep stays pending and runs again', async () => {
  // Thunderbird quits, or the event page suspends, mid-walk. Clearing the flag
  // optimistically would strand every message the walk had not reached yet.
  const world = makeSweepWorld({ pending: true, reconcileThrows: true });
  const { OmniEvents } = loadOmniEvents({
    messenger: world.messenger,
    OmniIndexer: world.OmniIndexer,
  });

  await assert.rejects(() => OmniEvents.deepSweepIfPending(world.ctrl));

  assert.equal(world.stillPending(), true, 'a sweep that did not finish must not be marked done');
  assert.equal(world.cleared.length, 0);
});
