'use strict';
// Tests for the stable document key — see docs/adr/0001-stable-document-key-and-
// watermark-catchup.md.
//
// Run with the system node (no dependencies, no install):
//     node --test test/
//
// Why these tests exist: documents were keyed on String(header.id), a number
// Thunderbird recycles every session. Decoding a live index found 78,859 docs
// whose ids filled 99.7% of the contiguous range [3..79079], so after a restart
// nearly every live id already addressed a DIFFERENT message. The key answers
// one question — "is this a message I already have?" — and every write path
// (upsert, remove, reconcile) inherits its answer. These tests pin the stable
// key (accountId + RFC Message-ID), the label-copy collapse it makes structural,
// and the folder bookkeeping that collapse introduces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'lib');

function loadOmniEngine() {
  const sandbox = { console };
  vm.createContext(sandbox);
  for (const file of ['minisearch.js', 'query.js', 'dockey.js', 'engine.js']) {
    const full = path.join(LIB, file);
    // dockey.js is introduced by this change; skip it until it exists so these
    // tests fail on their assertions rather than on file I/O.
    if (!fs.existsSync(full)) continue;
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  }
  return sandbox.OmniEngine;
}

const OmniEngine = loadOmniEngine();

// A message as the indexer hands it over. `id` is the numeric Thunderbird id —
// a cache hint only, and deliberately DIFFERENT per label copy, exactly as
// Thunderbird reports it.
function doc(over = {}) {
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
    },
    over,
  );
}

test('docKey is derived from the account and the RFC Message-ID', () => {
  const key = OmniEngine.docKey(doc());
  assert.equal(key, 'account1\0mesh@mail.gmail.com');
});

test('docKey ignores the numeric id, which is not stable across restarts', () => {
  // The same mail, same account, reported under a recycled id next session.
  assert.equal(OmniEngine.docKey(doc({ id: '101' })), OmniEngine.docKey(doc({ id: '77123' })));
});

test('docKey separates the same Message-ID in two different accounts', () => {
  assert.notEqual(
    OmniEngine.docKey(doc({ accountId: 'account1' })),
    OmniEngine.docKey(doc({ accountId: 'account2' })),
  );
});

test('docKey falls back to the id when a message has no Message-ID, so such docs never collapse', () => {
  const a = OmniEngine.docKey(doc({ headerMessageId: '', id: '5' }));
  const b = OmniEngine.docKey(doc({ headerMessageId: '', id: '6' }));
  assert.notEqual(a, b);
});

test('re-indexing a message after its numeric id was recycled updates rather than duplicates', () => {
  const engine = new OmniEngine();
  engine.upsert(doc({ id: '101' }));
  engine.upsert(doc({ id: '77123', subject: 'Re: API beta access request (updated)' }));

  const { ranked } = engine.rank('beta');
  assert.equal(ranked.length, 1, 'the same mail under a new numeric id must not become a second doc');
  assert.equal(ranked[0].subject, 'Re: API beta access request (updated)');
});

test('label copies of one message collapse into a single doc carrying every folder', () => {
  // Gmail/IMAP: one message, one Message-ID, several labels, distinct numeric ids.
  const engine = new OmniEngine();
  engine.upsert(doc({ id: '101', folderName: 'All Mail' }));
  engine.upsert(doc({ id: '102', folderName: 'Inbox' }));

  const { ranked } = engine.rank('beta');
  assert.equal(ranked.length, 1, 'label copies must be one document, not one result per label');
  assert.deepEqual([...ranked[0].folders].sort(), ['All Mail', 'Inbox']);
});

test('removing a message from one folder keeps the copy that still lives elsewhere', () => {
  // The bookkeeping hazard the collapse introduces: deleting from Inbox must not
  // delete mail still sitting in All Mail.
  const engine = new OmniEngine();
  engine.upsert(doc({ id: '101', folderName: 'All Mail' }));
  engine.upsert(doc({ id: '102', folderName: 'Inbox' }));

  engine.removeFromFolder(OmniEngine.docKey(doc()), 'Inbox');

  const { ranked } = engine.rank('beta');
  assert.equal(ranked.length, 1, 'the message still lives in All Mail and must remain searchable');
  // Spread first: `folders` is built inside the vm realm, so its Array
  // prototype differs from this one and deepStrictEqual would reject two
  // identical arrays.
  assert.deepEqual([...ranked[0].folders], ['All Mail'], 'the removed folder must not linger');
});

test('removing a message from its last folder discards the document', () => {
  const engine = new OmniEngine();
  engine.upsert(doc({ id: '101', folderName: 'Inbox' }));

  engine.removeFromFolder(OmniEngine.docKey(doc()), 'Inbox');

  const { ranked } = engine.rank('beta');
  assert.equal(ranked.length, 0, 'a message gone from every folder must leave the index');
});
