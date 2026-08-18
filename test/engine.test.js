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
  for (const file of ['minisearch.js', 'query.js', 'engine.js']) {
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
  const found = ids(engine.search('budget', 100, { now: NOW }).results);
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
  const found = ids(engine.search('invoice', 100, { now: NOW }).results);
  assert.deepEqual(found, ['old-subject', 'new-body']);
});

test('search: the boost is a multiplier on the text score, not a replacement', () => {
  const docs = [doc({ id: 'a', subject: 'quarterly budget', date: NOW - days(90) })];
  const withBoost = engineWith(docs).search('budget', 100, { now: NOW }).results[0];
  const noBoost = engineWith(docs).search('budget', 100, {
    now: NOW,
    recency: { strength: 0, halfLifeDays: HALF_LIFE_DAYS },
  }).results[0];
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
  const results = engine.search('standup', 100, { now: NOW, recency: off }).results;
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
  const found = ids(engine.search('release', 2, { now: NOW }).results);
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
  const results = engine.search('receipt', 100, { now: NOW }).results;
  assert.equal(results.length, 1);
  assert.deepEqual(Array.from(results[0].folders).sort(), ['All Mail', 'Inbox']);
});

test('search: an identical Message-ID in two accounts is NOT merged', () => {
  const engine = engineWith([
    doc({ id: '1', headerMessageId: '<same@x>', accountId: 'account1', subject: 'travel receipt' }),
    doc({ id: '2', headerMessageId: '<same@x>', accountId: 'account2', subject: 'travel receipt' }),
  ]);
  assert.equal(engine.search('receipt', 100, { now: NOW }).results.length, 2);
});

test('search: messages with no Message-ID never collapse together', () => {
  const engine = engineWith([
    doc({ id: '1', headerMessageId: '', subject: 'travel receipt' }),
    doc({ id: '2', headerMessageId: '', subject: 'travel receipt' }),
  ]);
  assert.equal(engine.search('receipt', 100, { now: NOW }).results.length, 2);
});

test('search: an empty query returns nothing', () => {
  const engine = engineWith([doc({ subject: 'anything' })]);
  assert.equal(engine.search('   ', 100, { now: NOW }).results.length, 0);
});

// ---------------------------------------------------------------------------
// Query operators (lib/query.js wired through search())
//
// These need the parser, so the sandbox loads lib/query.js too — see
// loadOmniEngine(). Boundaries are built with the LOCAL Date constructor,
// matching the parser's semantics.
// ---------------------------------------------------------------------------

const june2024 = (day = 20) => new Date(2024, 5, day, 12).getTime();
const july2024 = (day = 4) => new Date(2024, 6, day, 12).getTime();
const may2024 = (day = 20) => new Date(2024, 4, day, 12).getTime();

function datedDocs() {
  return [
    doc({ id: 'may', headerMessageId: '<may@x>', subject: 'quarterly invoice', date: may2024() }),
    doc({ id: 'jun', headerMessageId: '<jun@x>', subject: 'quarterly invoice', date: june2024() }),
    doc({ id: 'jul', headerMessageId: '<jul@x>', subject: 'quarterly invoice', date: july2024() }),
    doc({ id: 'aug', headerMessageId: '<aug@x>', subject: 'quarterly invoice', date: new Date(2024, 7, 3, 12).getTime() }),
  ];
}

test('search: a date range restricts results to that window', () => {
  const engine = engineWith(datedDocs());
  const found = ids(engine.search('invoice date:2024-06..2024-07', 100, { now: NOW }).results);
  assert.deepEqual(found.sort(), ['jul', 'jun']);
});

test('search: after:/before: is equivalent to the range form', () => {
  const engine = engineWith(datedDocs());
  const a = ids(engine.search('invoice date:2024-06..2024-07', 100, { now: NOW }).results).sort();
  const b = ids(engine.search('invoice after:2024-06 before:2024-07', 100, { now: NOW }).results).sort();
  assert.deepEqual(b, a);
});

test('search: a filter-only query with no free text still returns mail', () => {
  // Requires MiniSearch's wildcard path — the normal term search needs terms.
  const engine = engineWith(datedDocs());
  const found = ids(engine.search('date:2024-06', 100, { now: NOW }).results);
  assert.deepEqual(found, ['jun']);
});

test('search: from: is field-scoped, unlike a bare tokenized term', () => {
  // The false positive this fixes: searching the bare text corp.example.com
  // matched a message FROM bob@other.example.net, because MiniSearch's AND means
  // "all terms appear somewhere in the document" and the RECIPIENT matched.
  const docs = [
    doc({ id: 'from-alice', headerMessageId: '<a@x>', subject: 'report', from: 'alice@corp.example.com', to: 'me@corp.example.com' }),
    doc({ id: 'from-bob', headerMessageId: '<b@x>', subject: 'report', from: 'bob@other.example.net', to: 'me@corp.example.com' }),
  ];
  const bare = ids(engineWith(docs).search('report corp.example.com', 100, { now: NOW }).results).sort();
  assert.deepEqual(bare, ['from-alice', 'from-bob'], 'precondition: the bare term matches both');

  const scoped = ids(engineWith(docs).search('report from:corp.example.com', 100, { now: NOW }).results);
  assert.deepEqual(scoped, ['from-alice'], 'from: must not match on the recipient');
});

test('search: from: finds a bare address the tokenizer mangles', () => {
  // "<bob@other.example.net>" indexes as ["<bob","other","example","net>"], so
  // the term `bob` only matches via fuzzy at a large score penalty. A substring
  // filter over the stored header has no such problem.
  const docs = [doc({ id: 'b', headerMessageId: '<b@x>', subject: 'report', from: '<bob@other.example.net>' })];
  const found = ids(engineWith(docs).search('report from:bob', 100, { now: NOW }).results);
  assert.deepEqual(found, ['b']);
});

test('search: the full target query — sender plus date range', () => {
  const docs = [
    doc({ id: 'hit', headerMessageId: '<1@x>', subject: 'invoice', from: 'alice@corp.com', date: june2024() }),
    doc({ id: 'wrong-date', headerMessageId: '<2@x>', subject: 'invoice', from: 'alice@corp.com', date: may2024() }),
    doc({ id: 'wrong-sender', headerMessageId: '<3@x>', subject: 'invoice', from: 'bob@corp.com', date: june2024() }),
  ];
  const r = engineWith(docs).search('invoice from:alice@corp.com date:2024-06..2024-07', 100, { now: NOW });
  assert.deepEqual(ids(r.results), ['hit']);
  assert.equal(r.errors.length, 0);
});

test('search: a rejected ambiguous date applies NO filter and surfaces the error', () => {
  // The critical safety property: an unparseable date must never silently
  // degrade into an unfiltered search that looks like it worked.
  const engine = engineWith(datedDocs());
  const r = engine.search('invoice date:7/6/2024', 100, { now: NOW });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Ambiguous/);
  assert.equal(r.filters.after, null);
});

test('search: an explicit date filter damps the recency boost', () => {
  // Asserted on the score rather than on ordering, because ordering is only a
  // visible consequence for WIDE ranges — see the next test. The mechanism is
  // exact: with a date range the score is the raw text score, and without one
  // it is that score times the recency factor.
  const date = june2024();
  const docs = [doc({ id: 'a', headerMessageId: '<1@x>', subject: 'quarterly invoice', date })];
  const undamped = engineWith(docs).search('invoice', 100, { now: NOW }).results[0];
  const damped = engineWith(docs).search('invoice date:2024-06', 100, { now: NOW }).results[0];
  const factor = OmniEngine.recencyFactor(date, NOW);
  assert.ok(factor > 1, 'precondition: the boost is active for this date');
  assert.ok(Math.abs(undamped.score - damped.score * factor) < 1e-12, `${undamped.score} vs ${damped.score} * ${factor}`);
});

test('search: damping visibly reorders only for a wide date range', () => {
  // Worth pinning because it is counter-intuitive: inside a NARROW range the
  // recency curve barely varies (June vs July 2024 differ by 1.009x, Dec 2025 vs
  // Jan 2026 by 1.030x), so damping changes nothing observable there. It is a
  // wide range — where the curve spans years — that damping actually rescues
  // from being re-sorted by date.
  const docs = [
    doc({ id: 'old-strong', headerMessageId: '<1@x>', subject: 'invoice invoice', date: new Date(2005, 5, 1, 12).getTime() }),
    doc({ id: 'new-weak', headerMessageId: '<2@x>', subject: 'invoice for the quarterly report attached here', date: new Date(2026, 0, 14, 12).getTime() }),
  ];
  const unfiltered = ids(engineWith(docs).search('invoice', 100, { now: NOW }).results);
  assert.equal(unfiltered[0], 'new-weak', 'without a range, recency leads');

  const wide = ids(engineWith(docs).search('invoice date:2000..2026', 100, { now: NOW }).results);
  assert.equal(wide[0], 'old-strong', 'with an explicit range, relevance leads');
});

test('search: filters compose with dedup and the limit', () => {
  const docs = [
    doc({ id: '1', headerMessageId: '<same@x>', subject: 'travel receipt', folderName: 'All Mail', date: june2024() }),
    doc({ id: '2', headerMessageId: '<same@x>', subject: 'travel receipt', folderName: 'Inbox', date: june2024() }),
    doc({ id: '3', headerMessageId: '<other@x>', subject: 'travel receipt', folderName: 'Inbox', date: may2024() }),
  ];
  const r = engineWith(docs).search('receipt date:2024-06', 100, { now: NOW });
  assert.equal(r.results.length, 1, 'the May message is filtered out and the label copies collapse');
  assert.deepEqual(Array.from(r.results[0].folders).sort(), ['All Mail', 'Inbox']);
});

test('search: an empty query with no filters still returns nothing', () => {
  const engine = engineWith(datedDocs());
  const r = engine.search('   ', 100, { now: NOW });
  assert.equal(r.results.length, 0);
  assert.equal(r.errors.length, 0);
});

// ---------------------------------------------------------------------------
// Paging — total, offset windows, and the ceiling
//
// These replace the old hard 100-result cap. The cap was invisible: a search
// matching 1,247 messages returned 100 and said nothing, so "is that all of
// them?" had no answer. rank() now orders every match, page() serves windows of
// it, and `total` states the real count.
// ---------------------------------------------------------------------------

// A ranked list of N synthetic records. page() is a pure slicer over whatever
// rank() produced, so the ceiling and window arithmetic can be tested directly
// without pushing thousands of documents through MiniSearch.
const fakeRanked = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

test('rank: returns the complete ordered list, not a page', () => {
  const engine = engineWith([
    doc({ id: 'a', headerMessageId: '<a@x>', subject: 'release plan', date: NOW - days(3) }),
    doc({ id: 'b', headerMessageId: '<b@x>', subject: 'release plan', date: NOW - days(2) }),
    doc({ id: 'c', headerMessageId: '<c@x>', subject: 'release plan', date: NOW - days(1) }),
  ]);
  const r = engine.rank('release', { now: NOW });
  assert.equal(r.ranked.length, 3);
  assert.deepEqual(ids(r.ranked), ['c', 'b', 'a'], 'newest first — already recency-sorted');
});

test('search: total reports every match even when the page shows fewer', () => {
  // The regression this guards: the old contract returned a bare truncated array,
  // so a caller could not tell a complete 100 from a truncated 100.
  const engine = engineWith([
    doc({ id: 'a', headerMessageId: '<a@x>', subject: 'release plan', date: NOW - days(3) }),
    doc({ id: 'b', headerMessageId: '<b@x>', subject: 'release plan', date: NOW - days(2) }),
    doc({ id: 'c', headerMessageId: '<c@x>', subject: 'release plan', date: NOW - days(1) }),
  ]);
  const r = engine.search('release', 2, { now: NOW });
  assert.equal(r.results.length, 2);
  assert.equal(r.total, 3);
  assert.equal(r.hasMore, true);
});

test('search: total counts unique messages, not raw label hits', () => {
  // Three docs, two of them label copies of one message: the user is counting
  // messages, so total must say 2 — the same collapse the page itself does.
  const engine = engineWith([
    doc({ id: '1', headerMessageId: '<same@x>', subject: 'travel receipt', folderName: 'All Mail' }),
    doc({ id: '2', headerMessageId: '<same@x>', subject: 'travel receipt', folderName: 'Inbox' }),
    doc({ id: '3', headerMessageId: '<other@x>', subject: 'travel receipt', folderName: 'Inbox' }),
  ]);
  const r = engine.search('receipt', 100, { now: NOW });
  assert.equal(r.total, 2);
  assert.equal(r.results.length, 2);
});

test('search: hasMore is false once the last result is on the page', () => {
  const engine = engineWith([
    doc({ id: 'a', headerMessageId: '<a@x>', subject: 'release plan' }),
    doc({ id: 'b', headerMessageId: '<b@x>', subject: 'release plan' }),
  ]);
  const r = engine.search('release', 100, { now: NOW });
  assert.equal(r.hasMore, false);
  assert.equal(r.total, 2);
});

test('search: consecutive pages walk the ranked list with no gap or repeat', () => {
  // The bug this pins: paging that re-ranks per request would re-run the recency
  // curve against a newer `now` and could swap two results across the boundary,
  // showing one message twice and hiding another. Pages must tile the list.
  const engine = engineWith(
    Array.from({ length: 7 }, (_, i) =>
      doc({ id: `m${i}`, headerMessageId: `<m${i}@x>`, subject: 'release plan', date: NOW - days(i) }),
    ),
  );
  const all = ids(engine.rank('release', { now: NOW }).ranked);
  const p1 = engine.search('release', 3, { now: NOW, offset: 0 });
  const p2 = engine.search('release', 3, { now: NOW, offset: 3 });
  const p3 = engine.search('release', 3, { now: NOW, offset: 6 });
  assert.deepEqual([...ids(p1.results), ...ids(p2.results), ...ids(p3.results)], all);
  assert.deepEqual([p1.hasMore, p2.hasMore, p3.hasMore], [true, true, false]);
  assert.deepEqual([p1.offset, p2.offset, p3.offset], [0, 3, 6]);
});

test('search: an offset past the end returns nothing but still reports the total', () => {
  const engine = engineWith([doc({ id: 'a', headerMessageId: '<a@x>', subject: 'release plan' })]);
  const r = engine.search('release', 100, { now: NOW, offset: 50 });
  assert.equal(r.results.length, 0);
  assert.equal(r.total, 1, 'the count is a property of the query, not of the page');
  assert.equal(r.hasMore, false);
});

test('page: a negative or garbage offset is treated as the first page, never a tail slice', () => {
  // slice(0, -5) silently drops the LAST five results instead of erroring, so an
  // unvalidated offset would quietly show the worst matches. Clamp, don't trust.
  const ranked = fakeRanked(10);
  for (const bad of [-5, NaN, undefined, null, '3']) {
    const r = OmniEngine.page(ranked, 4, bad);
    assert.equal(r.offset, 0, `offset ${String(bad)} must clamp to 0`);
    assert.deepEqual(Array.from(r.results, (x) => x.id), ['0', '1', '2', '3']);
  }
});

test('page: a garbage limit falls back to the default page size, never an empty page', () => {
  const ranked = fakeRanked(500);
  for (const bad of [0, -1, NaN, null]) {
    assert.equal(OmniEngine.page(ranked, bad).results.length, OmniEngine.DEFAULT_LIMIT);
  }
});

test('page: paging cannot walk past MAX_RESULTS, and says so via capped', () => {
  // The ceiling is a UI-thread protection, not a preference: prefix matching on
  // one letter matches most of the archive, and every result crosses two
  // structured-clone hops with the middle one on Thunderbird's main thread.
  const MAX = OmniEngine.MAX_RESULTS;
  const ranked = fakeRanked(MAX + 500);

  const last = OmniEngine.page(ranked, 100, MAX - 100);
  assert.equal(last.results.length, 100);
  assert.equal(last.hasMore, false, 'at the ceiling there is no reachable next page');
  assert.equal(last.capped, true);
  assert.equal(last.total, MAX + 500, 'total stays honest about what actually matched');

  // A large limit must not be able to straddle the ceiling.
  const straddle = OmniEngine.page(ranked, 1000, MAX - 100);
  assert.equal(straddle.results.length, 100);

  const beyond = OmniEngine.page(ranked, 100, MAX + 100);
  assert.equal(beyond.results.length, 0);
});

test('page: capped is false whenever the whole list is reachable', () => {
  const r = OmniEngine.page(fakeRanked(OmniEngine.MAX_RESULTS), 100, 0);
  assert.equal(r.capped, false);
  assert.equal(r.hasMore, true);
});

test('search: a rejected date still reports a zero total alongside the error', () => {
  const engine = engineWith(datedDocs());
  const r = engine.search('budget date:7/6/2024', 100, { now: NOW });
  assert.ok(r.errors.length > 0);
  assert.equal(r.total, 0);
  assert.equal(r.hasMore, false);
});
