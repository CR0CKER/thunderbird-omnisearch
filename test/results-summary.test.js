'use strict';
// Tests for lib/results-summary.js — the result-list footer's state machine.
//
// Run with the system node (no dependencies, no install):
//     node --test 'test/*.test.js'
//
// Why these tests exist: the first implementation of this logic suppressed the
// footer whenever `!hasMore && shown >= total`, which is exactly the state the
// "All N matches shown" branch was written to render. That branch was therefore
// unreachable, and because pages after the first are served from the worker's
// rank cache (near-instant), the footer existed only for the few milliseconds a
// page was in flight. The match count — the entire reason paging replaced the
// old hard 100-result cap — was effectively invisible, and it read as a feature
// that had not been implemented at all.
//
// The lesson worth keeping: "nothing more to load" and "nothing worth saying"
// are different conditions. Suppression keys off `total`, never off the paging
// flags.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'lib');

function loadOmniResults() {
  const sandbox = { console };
  vm.createContext(sandbox);
  const full = path.join(LIB, 'results-summary.js');
  vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  return sandbox.OmniResults;
}

const OmniResults = loadOmniResults();
const PAGE = 100;
// Locale-independent: assert against the same formatting the UI would produce
// rather than hardcoding a thousands separator that varies by machine.
const n = (x) => x.toLocaleString();

const state = (over) => ({ shown: 0, total: 0, hasMore: false, capped: false, loading: false, error: '', ...over });

test('footer: everything arrived in the first page — say nothing', () => {
  // A two-result search must not grow the window by a row to tell the user it
  // found two results.
  assert.equal(OmniResults.footerText(state({ shown: 2, total: 2 }), PAGE), null);
  assert.equal(OmniResults.footerText(state({ shown: 100, total: 100 }), PAGE), null);
});

test('footer: a truncated first page reports the real total', () => {
  const t = OmniResults.footerText(state({ shown: 100, total: 1247, hasMore: true }), PAGE);
  assert.equal(t, `Showing ${n(100)} of ${n(1247)} matches`);
});

test('footer: paging to the end still reports the total — the regression', () => {
  // THE bug: this state used to be suppressed, so the count disappeared the
  // instant the last page landed and the user never saw how many matched.
  const t = OmniResults.footerText(state({ shown: 1247, total: 1247 }), PAGE);
  assert.notEqual(t, null, 'the footer must survive the end of paging');
  assert.equal(t, `All ${n(1247)} matches shown`);
});

test('footer: a completed short-but-paged set still reports its total', () => {
  // 101 matches: page 1 truncates, page 2 completes it. Still worth stating,
  // because the user has already been shown a "of 101" they need resolved.
  const t = OmniResults.footerText(state({ shown: 101, total: 101 }), PAGE);
  assert.equal(t, `All ${n(101)} matches shown`);
});

test('footer: the ceiling is reported as a ceiling, not as completeness', () => {
  const t = OmniResults.footerText(state({ shown: 5000, total: 12043, capped: true }), PAGE);
  assert.match(t, /^Showing the top/);
  assert.match(t, /narrow your search/);
  assert.ok(t.includes(n(12043)), 'the true total is stated even though it is unreachable');
});

test('footer: an in-flight page says so', () => {
  assert.equal(OmniResults.footerText(state({ shown: 100, total: 1247, hasMore: true, loading: true }), PAGE), 'Loading more…');
});

test('footer: a failed page speaks even when the numbers look complete', () => {
  // Falling through to "All N matches shown" here would claim a completeness we
  // cannot vouch for — the tail never loaded.
  const t = OmniResults.footerText(state({ shown: 300, total: 300, error: "Couldn't load more results — boom" }), PAGE);
  assert.equal(t, "Couldn't load more results — boom");
});

test('footer: an error is reported even for a single-page result set', () => {
  const t = OmniResults.footerText(state({ shown: 5, total: 5, error: 'nope' }), PAGE);
  assert.equal(t, 'nope', 'the one-page shortcut must not swallow an error');
});

test('footer: no results at all shows nothing (the empty state owns that message)', () => {
  assert.equal(OmniResults.footerText(state({ shown: 0, total: 0 }), PAGE), null);
});

test('footer: tolerates a missing or partial page object without throwing', () => {
  // renderResultsFooter runs on every render; an exception here would take the
  // whole result list down with it.
  assert.equal(OmniResults.footerText(undefined, PAGE), null);
  assert.equal(OmniResults.footerText({}, PAGE), null);
});
