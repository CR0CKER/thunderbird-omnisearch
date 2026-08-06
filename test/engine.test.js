'use strict';
// Tests for lib/engine.js — result shaping: the recency boost, the dedup pass,
// and how the two interact with the result limit.
//
// Run with the system node (no dependencies, no install):
//     node --test test/
//
// Why these tests exist: date used to play NO part in ranking. It is a
// storeFields value (display only), MiniSearch's boostDocument hook was never
// set, and MiniSearch's own `byScore` comparator has no secondary key — so exact
// score ties fell back to inverted-index posting order, i.e. roughly the
// folder-walk order of the last full build. Results therefore put old mail above
// new mail for no reason a user could see. These tests pin the recency curve,
// its ceiling (it must NOT overrule the subject field boost), and the edges that
// make a naive decay dangerous — above all future-dated mail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'lib');

// lib/engine.js is an IIFE assigning globalThis.OmniEngine, and it depends on
// globalThis.MiniSearch. Running the vendored UMD build first in the same vm
// context satisfies that: with no `module`/`exports` in a bare sandbox the UMD
// wrapper takes its `global.MiniSearch = factory()` branch (lib/minisearch.js:1-11).
function loadOmniEngine() {
  const sandbox = { console };
  vm.createContext(sandbox);
  for (const file of ['minisearch.js', 'engine.js']) {
    const full = path.join(LIB, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  }
  return sandbox.OmniEngine;
}

const OmniEngine = loadOmniEngine();

const DAY = 24 * 60 * 60 * 1000;
// A fixed "now" so every assertion is deterministic — never Date.now().
const NOW = Date.UTC(2026, 0, 15);
const days = (n) => n * DAY;

// The shipped curve, restated here so a change to lib/engine.js's constants
// fails these tests loudly instead of silently re-tuning ranking.
const STRENGTH = 1.5;
const HALF_LIFE_DAYS = 365;

function doc(over) {
  return {
    id: '1',
    subject: '',
    from: 'sender@example.com',
    to: 'me@example.com',
    body: '',
    date: NOW,
    folderName: 'Inbox',
    accountId: 'account1',
    preview: '',
    bodyAvailable: true,
    headerMessageId: '<m1@example.com>',
    encrypted: false,
    ...over,
  };
}

function engineWith(docs) {
  const engine = new OmniEngine();
  engine.addAll(docs);
  return engine;
}

// Arrays built inside the vm context carry that realm's Array.prototype, which
// assert/strict's deepEqual rejects as not reference-equal even when the
// contents match. Array.from re-homes the values into this realm.
const ids = (results) => Array.from(results, (r) => r.id);

// ---------------------------------------------------------------------------
// The curve itself (pure — no MiniSearch involved)
// ---------------------------------------------------------------------------

test('recencyFactor: brand-new mail gets the full boost', () => {
  assert.equal(OmniEngine.recencyFactor(NOW, NOW), 1 + STRENGTH);
});

test('recencyFactor: one half-life halves the boost, not the score', () => {
  const f = OmniEngine.recencyFactor(NOW - days(HALF_LIFE_DAYS), NOW);
  // 1 + 1.5 * 0.5 = 1.75 — the *boost* halves; the multiplier floors at 1.
  assert.ok(Math.abs(f - (1 + STRENGTH / 2)) < 1e-12, `expected ~1.3, got ${f}`);
});

test('recencyFactor: ancient mail is effectively unboosted', () => {
  // Ten years is ten half-lives at 365d, so the boost is strength/1024 ≈ 0.0015.
  // The bound was 1.001 under the original 0.6/180d curve; the assertive
  // 1.5/365d curve legitimately leaves slightly more residue at this age, which
  // is a property of the tuning, not a defect. Still negligible against a text
  // score, which is the point of the assertion.
  const f = OmniEngine.recencyFactor(NOW - days(3650), NOW);
  assert.ok(f > 1 && f < 1.01, `expected ~1.0, got ${f}`);
});

test('recencyFactor: decreases monotonically with age', () => {
  let prev = Infinity;
  for (const age of [0, 7, 30, 90, 180, 365, 730, 1825, 3650]) {
    const f = OmniEngine.recencyFactor(NOW - days(age), NOW);
    assert.ok(f < prev, `factor did not decrease at age ${age}d (${f} >= ${prev})`);
    prev = f;
  }
});

test('recencyFactor: future-dated mail is clamped, never boosted beyond new', () => {
  // Without clamping the age at 0, 0.5^negative grows without bound — and
  // future-dating is a known spam trick for topping date-sorted lists.
  const future = OmniEngine.recencyFactor(NOW + days(365), NOW);
  assert.equal(future, OmniEngine.recencyFactor(NOW, NOW));
  assert.equal(future, 1 + STRENGTH);
});

test('recencyFactor: a missing date (0) is neutral, not maximally stale-penalised', () => {
  // toMillis() (lib/indexer.js) yields 0 for an unparseable header date, and a
  // pre-`date` index has no value at all. Both must score as a plain 1x.
  assert.equal(OmniEngine.recencyFactor(0, NOW), 1);
  assert.equal(OmniEngine.recencyFactor(undefined, NOW), 1);
});

test('recencyFactor: strength 0 disables the boost entirely', () => {
  const off = { strength: 0, halfLifeDays: HALF_LIFE_DAYS };
  assert.equal(OmniEngine.recencyFactor(NOW, NOW, off), 1);
  assert.equal(OmniEngine.recencyFactor(NOW - days(1000), NOW, off), 1);
});

test('recencyFactor: a non-positive half-life disables the boost, never returns NaN', () => {
  // age 0 / halfLife 0 is 0/0. A NaN factor would propagate into the score and
  // scramble the sort, so a bad (future, user-set) value must fail safe to 1x.
  for (const halfLifeDays of [0, -1, undefined, NaN]) {
    const f = OmniEngine.recencyFactor(NOW, NOW, { strength: STRENGTH, halfLifeDays });
    assert.equal(f, 1, `halfLifeDays=${halfLifeDays} gave ${f}`);
  }
});

// ---------------------------------------------------------------------------
// The boost applied through search()
// ---------------------------------------------------------------------------

test('search: with identical text, the newer message ranks first', () => {
  // Same tokens everywhere, so BM25 scores them identically and recency is the
  // only differentiator. Inserted oldest-first so a regression (falling back to
  // insertion/posting order) is caught rather than accidentally passing.
  const engine = engineWith([
    doc({ id: 'old', headerMessageId: '<old@x>', subject: 'quarterly budget', date: NOW - days(900) }),
    doc({ id: 'mid', headerMessageId: '<mid@x>', subject: 'quarterly budget', date: NOW - days(180) }),
    doc({ id: 'new', headerMessageId: '<new@x>', subject: 'quarterly budget', date: NOW - days(2) }),
  ]);
  const found = ids(engine.search('budget', 100, { now: NOW }));
  assert.deepEqual(found, ['new', 'mid', 'old']);
});

test('search: recency does NOT overrule the subject field boost', () => {
  // The ceiling that keeps the boost from flattening field relevance. Subject is
  // boosted 3x and the recency multiplier tops out at 2.5x, but field-length
  // normalisation keeps the subject hit ahead: measured 3.42 vs 2.40 here, and
  // still 2.89 vs 2.40 with the subject hit aged ten years. If a future strength
  // increase breaks this test, that is the signal that recency has started
  // overriding field relevance — investigate, do not just relax the assertion.
  const engine = engineWith([
    doc({ id: 'old-subject', headerMessageId: '<a@x>', subject: 'invoice attached', date: NOW - days(1100) }),
    doc({ id: 'new-body', headerMessageId: '<b@x>', subject: 'hello', body: 'invoice attached', date: NOW }),
  ]);
  const found = ids(engine.search('invoice', 100, { now: NOW }));
  assert.deepEqual(found, ['old-subject', 'new-body']);
});

test('search: the boost is a multiplier on the text score, not a replacement', () => {
  const docs = [doc({ id: 'a', subject: 'quarterly budget', date: NOW - days(90) })];
  const withBoost = engineWith(docs).search('budget', 100, { now: NOW })[0];
  const noBoost = engineWith(docs).search('budget', 100, {
    now: NOW,
    recency: { strength: 0, halfLifeDays: HALF_LIFE_DAYS },
  })[0];
  const expected = noBoost.score * OmniEngine.recencyFactor(NOW - days(90), NOW);
  assert.ok(Math.abs(withBoost.score - expected) < 1e-12, `${withBoost.score} != ${expected}`);
});

test('search: exact score ties break on date, not on index insertion order', () => {
  // Isolates the *secondary* sort key: with the boost off the two texts score
  // identically, so date is the only thing left to order them. Previously ties
  // kept inverted-index posting order — roughly the folder-walk order of the
  // last full build, i.e. arbitrary to the user. The tie-break is deliberately
  // unconditional, so turning the boost off still yields a stable, sane order.
  const engine = engineWith([
    doc({ id: 'older', headerMessageId: '<c@x>', subject: 'standup notes', date: NOW - days(3) }),
    doc({ id: 'newer', headerMessageId: '<d@x>', subject: 'standup notes', date: NOW - days(1) }),
  ]);
  const off = { strength: 0, halfLifeDays: HALF_LIFE_DAYS };
  const results = engine.search('standup', 100, { now: NOW, recency: off });
  assert.equal(results[0].score, results[1].score, 'precondition: the scores must actually tie');
  assert.deepEqual(ids(results), ['newer', 'older']);
});

test('search: the limit is applied AFTER the recency re-sort', () => {
  // The regression this guards: truncating first would return the top-N by raw
  // text score and merely re-order those, so a newer message just outside the
  // text-score top-N could never surface.
  const engine = engineWith([
    doc({ id: 'old', headerMessageId: '<e@x>', subject: 'release plan', date: NOW - days(900) }),
    doc({ id: 'mid', headerMessageId: '<f@x>', subject: 'release plan', date: NOW - days(400) }),
    doc({ id: 'new', headerMessageId: '<g@x>', subject: 'release plan', date: NOW - days(1) }),
  ]);
  const found = ids(engine.search('release', 2, { now: NOW }));
  assert.deepEqual(found, ['new', 'mid']);
});

// ---------------------------------------------------------------------------
// Dedup — unchanged behaviour, re-pinned because search() was restructured
// ---------------------------------------------------------------------------

test('search: label copies still collapse into one result with merged folders', () => {
  // A Gmail message carries one doc per label, all sharing an RFC Message-ID.
  const engine = engineWith([
    doc({ id: '1', headerMessageId: '<same@x>', subject: 'travel receipt', folderName: 'All Mail' }),
    doc({ id: '2', headerMessageId: '<same@x>', subject: 'travel receipt', folderName: 'Inbox' }),
  ]);
  const results = engine.search('receipt', 100, { now: NOW });
  assert.equal(results.length, 1);
  assert.deepEqual(Array.from(results[0].folders).sort(), ['All Mail', 'Inbox']);
});

test('search: an identical Message-ID in two accounts is NOT merged', () => {
  const engine = engineWith([
    doc({ id: '1', headerMessageId: '<same@x>', accountId: 'account1', subject: 'travel receipt' }),
    doc({ id: '2', headerMessageId: '<same@x>', accountId: 'account2', subject: 'travel receipt' }),
  ]);
  assert.equal(engine.search('receipt', 100, { now: NOW }).length, 2);
});

test('search: messages with no Message-ID never collapse together', () => {
  const engine = engineWith([
    doc({ id: '1', headerMessageId: '', subject: 'travel receipt' }),
    doc({ id: '2', headerMessageId: '', subject: 'travel receipt' }),
  ]);
  assert.equal(engine.search('receipt', 100, { now: NOW }).length, 2);
});

test('search: an empty query returns nothing', () => {
  const engine = engineWith([doc({ subject: 'anything' })]);
  assert.equal(engine.search('   ', 100, { now: NOW }).length, 0);
});
