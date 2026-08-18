'use strict';
// Tests for the v:2 -> v:3 in-place snapshot migration — see
// docs/adr/0001-stable-document-key-and-watermark-catchup.md.
//
// Run with the system node (no dependencies, no install):
//     node --test test/
//
// Why these tests exist: re-keying documents looks like it should force every
// user to rebuild their index from their whole mail archive. It does not.
// MiniSearch's inverted index references INTERNAL short ids; only _documentIds
// maps internal -> external. Both fields the stable key needs (accountId,
// headerMessageId) are already in storedFields. So the migration rewrites
// _documentIds, merges label copies with discard(), and builds folders[] from
// the folderNames it merges — without re-reading a single message. These tests
// pin that: the sandbox contains NO `messenger`, so any attempt to read mail
// during migration fails loudly rather than silently costing users a rebuild.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'lib');

function loadSandbox() {
  const sandbox = { console };
  vm.createContext(sandbox);
  for (const file of ['minisearch.js', 'query.js', 'dockey.js', 'engine.js']) {
    const full = path.join(LIB, file);
    // dockey.js is introduced by this change; skip it until it exists so these
    // tests fail on their assertions rather than on file I/O.
    if (!fs.existsSync(full)) continue;
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  }
  return sandbox;
}

const sandbox = loadSandbox();
const { OmniEngine, MiniSearch } = sandbox;

// The pre-change index shape: keyed on the numeric id, one doc per label copy,
// a single folderName per doc. Built with MiniSearch directly so the fixture
// does not depend on the very code being replaced.
const V2_OPTIONS = {
  idField: 'id',
  fields: ['subject', 'from', 'to', 'body'],
  storeFields: [
    'subject', 'from', 'to', 'date', 'folderName', 'accountId',
    'preview', 'bodyAvailable', 'headerMessageId', 'encrypted',
  ],
};

function v2Doc(over = {}) {
  return Object.assign(
    {
      id: '101',
      accountId: 'account1',
      headerMessageId: 'mesh@mail.gmail.com',
      subject: 'Re: API beta access request',
      from: '"Mesh Team (Mesh)" <care@clay.earth>',
      to: 'Nils <nils@example.com>',
      body: 'thanks for asking about the beta',
      date: Date.UTC(2026, 7, 17),
      folderName: 'Archive',
      preview: 'thanks for asking about the beta',
      bodyAvailable: true,
      encrypted: false,
    },
    over,
  );
}

// Mirrors the old SearchEngine.toData() exactly (lib/engine.js, format v:2).
function v2Snapshot(docs) {
  const mini = new MiniSearch(V2_OPTIONS);
  mini.addAll(docs);
  return {
    v: 2,
    mini: {
      documentCount: mini._documentCount,
      nextId: mini._nextId,
      fieldIds: mini._fieldIds,
      averageFieldLength: mini._avgFieldLength,
      dirtCount: mini._dirtCount,
      documentIds: mini._documentIds,
      fieldLength: mini._fieldLength,
      storedFields: mini._storedFields,
      indexTree: mini._index._tree,
    },
    ids: new Set(docs.map((d) => d.id)),
  };
}

test('a v:2 snapshot still loads and its mail is still findable', () => {
  const engine = OmniEngine.deserialize(v2Snapshot([v2Doc()]));
  const { ranked } = engine.rank('beta');
  assert.equal(ranked.length, 1, 'an existing index must keep working across the upgrade');
});

test('migration re-keys documents onto the stable key', () => {
  const engine = OmniEngine.deserialize(v2Snapshot([v2Doc()]));
  const { ranked } = engine.rank('beta');
  // Re-indexing the same mail under a recycled numeric id must now update the
  // migrated doc, not add a second one.
  engine.upsert(v2Doc({ id: '90210', subject: 'Re: API beta access request (v2)' }));
  const after = engine.rank('beta').ranked;
  assert.equal(after.length, 1, 'a migrated doc must be addressable by its stable key');
  assert.equal(after[0].subject, 'Re: API beta access request (v2)');
  assert.ok(ranked.length === 1);
});

test('migration collapses label copies and merges their folders', () => {
  const snap = v2Snapshot([
    v2Doc({ id: '101', folderName: 'All Mail' }),
    v2Doc({ id: '102', folderName: 'Inbox' }),
    v2Doc({ id: '103', headerMessageId: 'other@example.com', folderName: 'Inbox', subject: 'beta unrelated' }),
  ]);
  const engine = OmniEngine.deserialize(snap);

  const hit = engine.rank('beta').ranked.find((r) => r.headerMessageId === 'mesh@mail.gmail.com');
  assert.ok(hit, 'the collapsed message must survive migration');
  assert.deepEqual([...hit.folders].sort(), ['All Mail', 'Inbox']);
  assert.equal(engine.size, 2, 'two label copies of one message must migrate to one document');
});

test('migration re-serializes as v:3', () => {
  const engine = OmniEngine.deserialize(v2Snapshot([v2Doc()]));
  assert.equal(engine.toData().v, 3);
});

test('a migrated snapshot round-trips without migrating twice', () => {
  const once = OmniEngine.deserialize(v2Snapshot([
    v2Doc({ id: '101', folderName: 'All Mail' }),
    v2Doc({ id: '102', folderName: 'Inbox' }),
  ]));
  const twice = OmniEngine.deserialize(once.toData());

  const hit = twice.rank('beta').ranked[0];
  assert.ok(hit, 'a v:3 snapshot must reload');
  assert.deepEqual([...hit.folders].sort(), ['All Mail', 'Inbox'], 'folders must not be lost or duplicated on reload');
  assert.equal(twice.size, 1);
});
