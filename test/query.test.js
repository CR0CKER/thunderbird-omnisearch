'use strict';
// Tests for lib/query.js — the search-query operator parser.
//
// Run with the system node (no dependencies, no install):
//     node --test test/
//
// TZ is pinned to a NON-UTC zone deliberately, and before any Date is created.
// The bug these tests exist to catch is parsing a user's date string with
// `new Date(str)` / `Date.parse()`: an ISO-shaped string parses as UTC while the
// same date unpadded parses as local, a silent skew of the UTC offset. In a UTC
// CI runner both readings coincide and a broken implementation would pass, so
// the suite pins its own zone rather than trusting the environment.
process.env.TZ = 'Europe/Brussels';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const QUERY_JS = path.join(__dirname, '..', 'lib', 'query.js');

// lib/query.js is a pure IIFE assigning globalThis.OmniQuery — no messenger, no
// MiniSearch, no DOM. A bare vm sandbox is all it needs.
function loadOmniQuery() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(QUERY_JS, 'utf8'), sandbox, { filename: QUERY_JS });
  return sandbox.OmniQuery;
}

const OmniQuery = loadOmniQuery();

// A fixed "now" for the relative/preset cases. 15 Jan 2026, local.
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();

const parse = (q) => OmniQuery.parse(q, NOW);

// Expected boundaries are built with the LOCAL multi-argument Date constructor,
// which is the semantics under test: a user asking for June means their June.
const startOf = (y, m = 1, d = 1) => new Date(y, m - 1, d).getTime();
// End of a period = start of the next period minus 1ms, so month lengths, leap
// days and DST transitions are resolved by the engine rather than by arithmetic.
const endOfYear = (y) => new Date(y + 1, 0, 1).getTime() - 1;
const endOfMonth = (y, m) => new Date(y, m, 1).getTime() - 1;
const endOfDay = (y, m, d) => new Date(y, m - 1, d + 1).getTime() - 1;

// ---------------------------------------------------------------------------
// Free text with no operators
// ---------------------------------------------------------------------------

test('plain text passes through untouched, with no filters', () => {
  const r = parse('quarterly budget');
  assert.equal(r.text, 'quarterly budget');
  assert.equal(r.filters.after, null);
  assert.equal(r.filters.before, null);
  assert.equal(r.errors.length, 0);
});

test('an empty query yields empty text and no filters', () => {
  const r = parse('   ');
  assert.equal(r.text, '');
  assert.equal(r.errors.length, 0);
});

// ---------------------------------------------------------------------------
// Period snapping — the rule that makes the syntax teachable
// ---------------------------------------------------------------------------

test('date: a bare year covers the whole year', () => {
  const r = parse('date:2024');
  assert.equal(r.filters.after, startOf(2024));
  assert.equal(r.filters.before, endOfYear(2024));
});

test('date: a month covers the whole month', () => {
  const r = parse('date:2024-06');
  assert.equal(r.filters.after, startOf(2024, 6));
  assert.equal(r.filters.before, endOfMonth(2024, 6));
});

test('date: a day covers that whole day, to the last millisecond', () => {
  const r = parse('date:2024-06-15');
  assert.equal(r.filters.after, startOf(2024, 6, 15));
  assert.equal(r.filters.before, endOfDay(2024, 6, 15));
});

test('after: snaps to the START of its period', () => {
  const r = parse('after:2024-06');
  assert.equal(r.filters.after, startOf(2024, 6));
  assert.equal(r.filters.before, null);
});

test('before: snaps to the END of its period — the anti-off-by-one-month rule', () => {
  // Gmail's before: is exclusive, so "before:2024-06" there means "before 1 June"
  // and excludes all of June. Ours includes June, which is what users mean.
  const r = parse('before:2024-06');
  assert.equal(r.filters.before, endOfMonth(2024, 6));
  assert.equal(r.filters.after, null);
});

test('date:A..B spans from the start of A to the end of B', () => {
  const r = parse('date:2024-06..2024-07');
  assert.equal(r.filters.after, startOf(2024, 6));
  assert.equal(r.filters.before, endOfMonth(2024, 7));
});

test('after:+before: is identical to the equivalent range — the target query', () => {
  const range = parse('invoice date:2024-06..2024-07');
  const pair = parse('invoice after:2024-06 before:2024-07');
  assert.equal(pair.filters.after, range.filters.after);
  assert.equal(pair.filters.before, range.filters.before);
  assert.equal(pair.text, 'invoice');
});

test('period ends respect leap years', () => {
  assert.equal(parse('before:2024-02').filters.before, endOfMonth(2024, 2)); // 29th
  assert.equal(parse('before:2023-02').filters.before, endOfMonth(2023, 2)); // 28th
  // Guard against a hardcoded 28/30/31: February 2024 must end on the 29th.
  assert.equal(new Date(parse('before:2024-02').filters.before).getDate(), 29);
});

test('year-first slash dates are accepted and identical to ISO', () => {
  assert.equal(parse('date:2024/06/15').filters.after, parse('date:2024-06-15').filters.after);
  assert.equal(parse('date:2024/06').filters.before, parse('date:2024-06').filters.before);
});

// ---------------------------------------------------------------------------
// Timezone — the hazard most likely to ship broken
// ---------------------------------------------------------------------------

test('boundaries are LOCAL midnight, not UTC midnight', () => {
  // If the implementation used new Date('2024-06-01'), this would be off by the
  // UTC offset (2h in the pinned zone) and mail from late on 31 May would leak in.
  const r = parse('after:2024-06');
  const d = new Date(r.filters.after);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getMonth(), 5);
  assert.notEqual(r.filters.after, Date.parse('2024-06-01')); // the bug, pinned
});

test('a message late on 31 May is outside after:2024-06; just after midnight is inside', () => {
  const after = parse('after:2024-06').filters.after;
  assert.ok(new Date(2024, 4, 31, 23, 30).getTime() < after, 'late 31 May must be excluded');
  assert.ok(new Date(2024, 5, 1, 0, 30).getTime() >= after, 'early 1 June must be included');
});

// ---------------------------------------------------------------------------
// Ambiguous dates — reject uniformly, never guess
// ---------------------------------------------------------------------------

test('an ambiguous slash date is rejected with both readings named', () => {
  const r = parse('invoice date:7/6/2024');
  assert.equal(r.filters.after, null, 'no filter may be applied from an ambiguous date');
  assert.equal(r.filters.before, null);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /7\/6\/2024/);
  assert.match(r.errors[0], /7 June/);
  assert.match(r.errors[0], /6 July/);
});

test('day-first slash dates are rejected even when only one reading is possible', () => {
  // 13 cannot be a month, so 13/6/2024 is technically unambiguous. It is still
  // rejected, deliberately: accepting it while rejecting 7/6/2024 would mean the
  // same format sometimes works and sometimes does not. One rule instead —
  // start with the year, or spell the month.
  for (const value of ['13/6/2024', '6/13/2024', '7/6/24']) {
    const r = parse(`date:${value}`);
    assert.equal(r.filters.after, null, `${value} must not set a filter`);
    assert.equal(r.errors.length, 1, `${value} must report exactly one error`);
  }
});

test('a rejection claims ambiguity only when the readings genuinely differ', () => {
  // This assertion has been narrowed twice, each time because it claimed more
  // than was true. It first required byte-identical messages; that was wrong,
  // because "7/6/2024" has two real readings to name while "13/6/2024" does not
  // (13 cannot be a month). It then required a shared trailing sentence; that
  // became wrong too, once messages started suggesting the correction for the
  // date the user actually typed. The shared *rule* is asserted separately, by
  // "every rejection teaches the same year-first rule".
  assert.match(parse('date:7/6/2024').errors[0], /^Ambiguous/, 'two differing readings');
  for (const value of ['13/6/2024', '6/13/2024', '7/7/2024']) {
    assert.match(parse(`date:${value}`).errors[0], /^Unsupported/, `${value} has no competing reading`);
  }
  // A two-digit year is still ambiguous in the day/month sense.
  assert.match(parse('date:7/6/24').errors[0], /^Ambiguous/);
});

test('a complete but out-of-range date is an error, not a silent drop', () => {
  const r = parse('date:2024-13');
  assert.equal(r.filters.after, null);
  assert.equal(r.errors.length, 1);
});

// ---------------------------------------------------------------------------
// Month names (EN/DE/FR/ES) — the unambiguous escape hatch the error suggests
// ---------------------------------------------------------------------------

test('month names are accepted, quoted or hyphenated', () => {
  const june = parse('date:2024-06');
  for (const q of ['date:"June 2024"', 'date:june-2024', 'date:"june 2024"']) {
    assert.equal(parse(q).filters.after, june.filters.after, q);
    assert.equal(parse(q).filters.before, june.filters.before, q);
  }
});

test('a day with a month name resolves to that day', () => {
  const r = parse('date:"7 June 2024"');
  assert.equal(r.filters.after, startOf(2024, 6, 7));
  assert.equal(r.filters.before, endOfDay(2024, 6, 7));
});

test('German, French and Spanish month names work, accents included', () => {
  const june = parse('date:2024-06').filters.after;
  for (const q of ['date:"Juni 2024"', 'date:"juin 2024"', 'date:"junio 2024"']) {
    assert.equal(parse(q).filters.after, june, q);
  }
  // Accented forms must normalise, not fail.
  const feb = parse('date:2024-02').filters.after;
  assert.equal(parse('date:"février 2024"').filters.after, feb);
});

test('the suggestion offered by the ambiguity error actually parses', () => {
  // Guards against the error text drifting away from what the parser accepts.
  assert.notEqual(parse('date:"7 June 2024"').filters.after, null);
  assert.notEqual(parse('date:2024-06-07').filters.after, null);
  assert.notEqual(parse('date:2024-07-06').filters.after, null);
});

// ---------------------------------------------------------------------------
// Colons in ordinary text must survive
// ---------------------------------------------------------------------------

test('an unknown operator stays free text', () => {
  const r = parse('Re: Q3:2024 numbers');
  assert.equal(r.errors.length, 0);
  assert.equal(r.filters.after, null);
  assert.match(r.text, /Q3:2024/);
});

test('a known operator with a non-date value stays free text, with no error', () => {
  // Someone searching for the phrase "after:party" must not get a date error.
  const r = parse('after:party');
  assert.equal(r.errors.length, 0);
  assert.equal(r.filters.after, null);
  assert.equal(r.text, 'after:party');
});

test('a quoted operator is text, not an operator', () => {
  const r = parse('"from:" boilerplate');
  assert.equal(r.filters.from, null);
  assert.match(r.text, /from:/);
});

// ---------------------------------------------------------------------------
// Partial input — the popup parses on every keystroke
// ---------------------------------------------------------------------------

test('input that is still being typed yields no filter and no error', () => {
  // Typing "date:2024-06" passes through each of these. An error on every
  // keystroke would make the field unusable, and a throw would kill the worker.
  for (const q of ['date:2', 'date:20', 'date:2024-', 'date:2024-0', 'date:', 'from:', 'date:2024-06..']) {
    const r = parse(q);
    assert.equal(r.errors.length, 0, `${q} should not error while incomplete`);
    assert.equal(r.filters.after, null, `${q} should not set a filter`);
  }
});

test('parse never throws on hostile or malformed input', () => {
  const inputs = ['date:..', 'date:....', 'from:"', '"', 'date:2024-06..2024-05', ':::', 'date:"" ', 'after:'];
  for (const q of inputs) {
    assert.doesNotThrow(() => parse(q), `threw on ${JSON.stringify(q)}`);
  }
});

test('a reversed range is reported rather than silently returning nothing', () => {
  const r = parse('date:2024-07..2024-06');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /range/i);
});

// ---------------------------------------------------------------------------
// from: / to:
// ---------------------------------------------------------------------------

test('from: and to: are extracted and lowercased, and leave the text clean', () => {
  const r = parse('invoice from:Alice@Corp.com to:me');
  assert.equal(r.filters.from, 'alice@corp.com');
  assert.equal(r.filters.to, 'me');
  assert.equal(r.text, 'invoice');
});

test('a quoted sender value keeps its spaces', () => {
  const r = parse('from:"alice smith"');
  assert.equal(r.filters.from, 'alice smith');
  assert.equal(r.text, '');
});

test('operators are recognised case-insensitively', () => {
  const r = parse('FROM:alice DATE:2024-06');
  assert.equal(r.filters.from, 'alice');
  assert.equal(r.filters.after, startOf(2024, 6));
});

test('the full target query parses completely', () => {
  const r = parse('invoice from:alice@corp.com date:2024-06..2024-07');
  assert.equal(r.text, 'invoice');
  assert.equal(r.filters.from, 'alice@corp.com');
  assert.equal(r.filters.after, startOf(2024, 6));
  assert.equal(r.filters.before, endOfMonth(2024, 7));
  assert.equal(r.errors.length, 0);
});

// ---------------------------------------------------------------------------
// hasFilters — the flag the engine uses to pick the wildcard path and to damp
// the recency boost
// ---------------------------------------------------------------------------

test('hasFilters reflects whether any filter is active', () => {
  assert.equal(OmniQuery.hasFilters(parse('invoice').filters), false);
  assert.equal(OmniQuery.hasFilters(parse('date:2024').filters), true);
  assert.equal(OmniQuery.hasFilters(parse('from:alice').filters), true);
  assert.equal(OmniQuery.hasFilters(parse('after:party').filters), false);
});

// ---------------------------------------------------------------------------
// Multi-word date values without quotes
//
// Regression: `date:7 july 2024` silently produced NO filter. The tokenizer
// split on the spaces, `date:7` was treated as "still being typed" and dropped
// in silence, and `july 2024` fell through as free text — so the search ran
// unfiltered and returned 2026 mail whose subject merely contained "July".
// That is the exact silent-wrongness the reject-rather-than-guess rule exists
// to prevent, arrived at from the other direction. Quoting is no longer
// required, and a value that cannot be resolved is never dropped in silence.
// ---------------------------------------------------------------------------

test('an unquoted multi-word date is parsed, not split into free text', () => {
  const quoted = parse('date:"7 July 2024"');
  const bare = parse('date:7 july 2024');
  assert.equal(bare.filters.after, quoted.filters.after);
  assert.equal(bare.filters.before, quoted.filters.before);
  assert.equal(bare.text, '', 'the date words must not leak into the search text');
  assert.equal(bare.errors.length, 0);
});

test('an unquoted month-and-year value is parsed', () => {
  const r = parse('date:july 2024');
  assert.equal(r.filters.after, startOf(2024, 7));
  assert.equal(r.filters.before, endOfMonth(2024, 7));
  assert.equal(r.text, '');
});

test('a multi-word date combines with free text on either side', () => {
  const r = parse('invoice date:7 july 2024 receipt');
  assert.equal(r.filters.after, startOf(2024, 7, 7));
  assert.equal(r.text, 'invoice receipt');
});

test('after:/before: also accept unquoted multi-word values', () => {
  const r = parse('after:june 2024 before:july 2024');
  assert.equal(r.filters.after, startOf(2024, 6));
  assert.equal(r.filters.before, endOfMonth(2024, 7));
  assert.equal(r.text, '');
});

test('greedy consumption stops at the shortest value that actually parses', () => {
  // "2024 budget report" is not a date; only "2024" is. The other words must
  // stay searchable rather than being swallowed by the operator.
  const r = parse('date:2024 budget report');
  assert.equal(r.filters.after, startOf(2024));
  assert.equal(r.text, 'budget report');
});

test('an unresolvable date value is reported, never silently dropped', () => {
  // The regression's root cause: `date:7` followed by more words used to vanish
  // in silence. If it cannot be resolved and the user has clearly moved on, say so.
  const r = parse('date:7 something else');
  assert.equal(r.filters.after, null);
  assert.equal(r.errors.length, 1, 'must not fail silently');
});

test('a trailing incomplete value stays silent — the user is still typing it', () => {
  // The distinction that keeps the field usable: an incomplete value at the END
  // of the query is mid-typing, not a mistake.
  for (const q of ['date:2', 'date:2024-', 'invoice date:20']) {
    const r = parse(q);
    assert.equal(r.errors.length, 0, `${q} should stay quiet`);
    assert.equal(r.filters.after, null);
  }
});

// ---------------------------------------------------------------------------
// Rejection messages must be true and actionable
//
// Regression: `7/7/2024` produced "7 July 2024 or 7 July 2024?" — the two
// readings coincide, so there was nothing ambiguous to report. The messages now
// name only readings that actually differ, and suggest the correction derived
// from what the user typed rather than a fixed example of another date.
// ---------------------------------------------------------------------------

test('a slash date whose two readings coincide is not called ambiguous', () => {
  const r = parse('date:7/7/2024');
  assert.equal(r.filters.after, null, 'still refused — the year-first rule is uniform');
  assert.doesNotMatch(r.errors[0], /^Ambiguous/);
  assert.doesNotMatch(r.errors[0], /(7 July 2024).*\1/, 'must not offer the same reading twice');
});

test('a rejection suggests the correction for the date the user actually typed', () => {
  assert.match(parse('date:7/7/2024').errors[0], /2024-07-07/);
  assert.match(parse('date:13/6/2024').errors[0], /2024-06-13/);
  assert.match(parse('date:6/13/2024').errors[0], /2024-06-13/);
  // Genuinely ambiguous: both corrections are offered.
  const both = parse('date:7/6/2024').errors[0];
  assert.match(both, /2024-06-07/);
  assert.match(both, /2024-07-06/);
});

test('rejection messages do not tell the user to add quotes', () => {
  // Quoting stopped being necessary, so advising it would send people down the
  // path that made `date:7 july 2024` fail in the first place.
  for (const v of ['7/6/2024', '7/7/2024', '13/6/2024']) {
    assert.doesNotMatch(parse(`date:${v}`).errors[0], /"[0-9]+ [A-Z][a-z]+ [0-9]{4}"/, v);
  }
});

test('every rejection teaches the same year-first rule', () => {
  for (const q of ['date:7/6/2024', 'date:7/7/2024', 'date:13/6/2024', 'date:7 something else']) {
    assert.match(parse(q).errors[0], /year first/i, q);
  }
});

// ---------------------------------------------------------------------------
// Month-name-first dates, and the last silent hole
//
// Regression: `after:july 7 2024` produced NO filter. Only day-before-month was
// accepted, so `after:july` was not date-shaped, fell through to free text, and
// the whole query ran as a text search returning mail from 2015 and 2022. The
// "never drop a filter silently" guard added earlier only covered values that
// were *incomplete*, not values that failed to look like dates at all.
// ---------------------------------------------------------------------------

test('month-name-first dates are accepted, in either word order', () => {
  const dayFirst = parse('date:7 july 2024');
  for (const q of ['date:july 7 2024', 'date:July 7, 2024', 'date:jul 7 2024']) {
    const r = parse(q);
    assert.equal(r.filters.after, dayFirst.filters.after, q);
    assert.equal(r.filters.before, dayFirst.filters.before, q);
    assert.equal(r.text, '', `${q} must not leak words into the search text`);
  }
});

test('after: accepts a month-name-first date — the reported case', () => {
  const r = parse('after:july 7 2024');
  assert.equal(r.filters.after, startOf(2024, 7, 7));
  assert.equal(r.filters.before, null);
  assert.equal(r.text, '');
  assert.equal(r.errors.length, 0);
});

test('a month name alone is reported rather than searched as text', () => {
  // `after:july` cannot resolve — no year. Previously it silently became free
  // text and the search ran unfiltered, which is indistinguishable from success.
  const r = parse('after:july nonsense here');
  assert.equal(r.filters.after, null);
  assert.equal(r.errors.length, 1, 'must not fail silently');
});

test('a trailing month name stays silent — still being typed', () => {
  const r = parse('after:july');
  assert.equal(r.errors.length, 0);
  assert.equal(r.filters.after, null);
});

test('a non-date value after a date operator is still ordinary text', () => {
  // The discrimination that keeps `after:party` searchable: "party" is not a
  // month name and does not start with a digit, so it is not date-shaped.
  for (const q of ['after:party', 'before:noon tomorrow please']) {
    const r = parse(q);
    assert.equal(r.errors.length, 0, q);
    assert.match(r.text, /party|noon/, q);
  }
});

test('month-name-first works in the other supported languages', () => {
  const july = parse('date:2024-07-07').filters.after;
  for (const q of ['date:juli 7 2024', 'date:juillet 7 2024', 'date:julio 7 2024']) {
    assert.equal(parse(q).filters.after, july, q);
  }
});

// ---------------------------------------------------------------------------
// `applied` — what the UI needs to render removable filter chips
//
// A chip has to be removable, and removing one must not do string surgery on
// the raw query (a repeated substring would make that ambiguous). So the parser
// reports the exact source text it consumed per operator; the UI rebuilds the
// query from the remaining sources plus the leftover free text.
// ---------------------------------------------------------------------------

test('applied reports the source text consumed by each operator', () => {
  const r = parse('invoice from:alice date:2024-06');
  // Array.from re-homes the vm sandbox's array into this realm; assert/strict
  // otherwise rejects it on prototype identity even when the contents match.
  const sources = Array.from(r.applied, (a) => a.source).sort();
  assert.deepEqual(sources, ['date:2024-06', 'from:alice']);
  assert.equal(r.text, 'invoice');
});

test('applied captures a multi-word date value in full', () => {
  // The whole point: "date:7 july 2024" spans three tokens, and dropping the
  // chip must remove all three, not just the first.
  const r = parse('invoice date:7 july 2024');
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].source, 'date:7 july 2024');
});

test('rebuilding from applied sources plus text round-trips the filters', () => {
  const original = 'invoice from:alice date:2024-06..2024-07';
  const r = parse(original);
  const rebuilt = [...r.applied.map((a) => a.source), r.text].join(' ');
  const again = parse(rebuilt);
  assert.equal(again.filters.after, r.filters.after);
  assert.equal(again.filters.before, r.filters.before);
  assert.equal(again.filters.from, r.filters.from);
  assert.equal(again.text, r.text);
});

test('dropping one applied entry removes exactly that filter', () => {
  const r = parse('invoice from:alice date:2024-06');
  const kept = r.applied.filter((a) => a.op !== 'date');
  const rebuilt = [...kept.map((a) => a.source), r.text].join(' ');
  const after = parse(rebuilt);
  assert.equal(after.filters.after, null, 'the date filter is gone');
  assert.equal(after.filters.from, 'alice', 'the sender filter survives');
  assert.equal(after.text, 'invoice');
});

test('applied carries what each chip needs to label itself', () => {
  const r = parse('from:alice date:2024-06 before:2024-08');
  const byOp = Object.fromEntries(r.applied.map((a) => [a.op, a]));
  assert.equal(byOp.from.value, 'alice');
  assert.equal(byOp.date.after, startOf(2024, 6));
  assert.equal(byOp.date.before, endOfMonth(2024, 6));
  assert.equal(byOp.before.before, endOfMonth(2024, 8));
  assert.equal(byOp.before.after, null);
});

test('a rejected or unresolved operator contributes no chip', () => {
  // A chip claiming a filter that is not actually applied would be a lie.
  for (const q of ['date:7/6/2024', 'after:party', 'date:2']) {
    assert.equal(parse(q).applied.length, 0, q);
  }
});

// ---------------------------------------------------------------------------
// Relative durations and named periods
//
// NOW is 15 January 2026, a Thursday — so "this-week" spans Mon 12 to Sun 18
// and the week boundary is actually exercised rather than landing on it.
// ---------------------------------------------------------------------------

const startOfDayAgo = (days) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

test('newer_than: starts at the beginning of the day N days ago', () => {
  const r = parse('newer_than:7d');
  assert.equal(r.filters.after, startOfDayAgo(7));
  assert.equal(r.filters.before, null, 'newer_than sets no upper bound');
});

test('older_than: ends just before that same instant', () => {
  const r = parse('older_than:7d');
  assert.equal(r.filters.before, startOfDayAgo(7) - 1);
  assert.equal(r.filters.after, null, 'older_than sets no lower bound');
});

test('newer_than and older_than are exactly complementary', () => {
  // No overlap and no gap: every message falls in exactly one of the two.
  // Snapping both to the same day boundary is what makes this hold.
  const newer = parse('newer_than:30d').filters.after;
  const older = parse('older_than:30d').filters.before;
  assert.equal(newer, older + 1);
});

test('duration units cover days, weeks, months and years', () => {
  assert.equal(parse('newer_than:1w').filters.after, startOfDayAgo(7));
  assert.equal(parse('newer_than:14d').filters.after, startOfDayAgo(14));
  // Months and years step the calendar, so they respect month lengths rather
  // than assuming 30/365 days.
  const monthAgo = new Date(NOW);
  monthAgo.setMonth(monthAgo.getMonth() - 3);
  monthAgo.setHours(0, 0, 0, 0);
  assert.equal(parse('newer_than:3m').filters.after, monthAgo.getTime());
  const yearAgo = new Date(NOW);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  yearAgo.setHours(0, 0, 0, 0);
  assert.equal(parse('newer_than:1y').filters.after, yearAgo.getTime());
});

test('durations are case-insensitive and reported as a chip', () => {
  assert.equal(parse('newer_than:7D').filters.after, startOfDayAgo(7));
  const r = parse('invoice newer_than:7d');
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].source, 'newer_than:7d');
  assert.equal(r.text, 'invoice');
});

test('a bad duration is reported, and an empty one stays quiet', () => {
  const bad = parse('newer_than:7x mail');
  assert.equal(bad.filters.after, null);
  assert.equal(bad.errors.length, 1);
  // Still being typed at the end of the query: no filter, no complaint.
  assert.equal(parse('newer_than:').errors.length, 0);
  assert.equal(parse('newer_than:').filters.after, null);
});

test('date:today and date:yesterday cover exactly those days', () => {
  const today = parse('date:today');
  assert.equal(today.filters.after, startOfDayAgo(0));
  assert.equal(today.filters.before, startOfDayAgo(-1) - 1);

  const yesterday = parse('date:yesterday');
  assert.equal(yesterday.filters.after, startOfDayAgo(1));
  assert.equal(yesterday.filters.before, startOfDayAgo(0) - 1);
});

test('date:this-week runs Monday to Sunday', () => {
  // Monday-start is the ISO convention. It is a real choice — some locales
  // start on Sunday — so it is pinned here rather than left to chance.
  const r = parse('date:this-week');
  const start = new Date(r.filters.after);
  const end = new Date(r.filters.before);
  assert.equal(start.getDay(), 1, 'starts on a Monday');
  assert.equal(start.getDate(), 12);
  assert.equal(end.getDay(), 0, 'ends on a Sunday');
  assert.equal(end.getDate(), 18);
});

test('date:this-month and date:this-year match the calendar period', () => {
  const month = parse('date:this-month');
  assert.equal(month.filters.after, startOf(2026, 1));
  assert.equal(month.filters.before, endOfMonth(2026, 1));

  const year = parse('date:this-year');
  assert.equal(year.filters.after, startOf(2026));
  assert.equal(year.filters.before, endOfYear(2026));
});

test('named periods work with after:, before: and ranges', () => {
  // They are periods like any other value, so the period rule applies unchanged.
  assert.equal(parse('after:today').filters.after, startOfDayAgo(0));
  assert.equal(parse('after:today').filters.before, null);
  assert.equal(parse('before:yesterday').filters.before, startOfDayAgo(0) - 1);

  const span = parse('date:yesterday..today');
  assert.equal(span.filters.after, startOfDayAgo(1));
  assert.equal(span.filters.before, startOfDayAgo(-1) - 1);
});

test('named periods are case-insensitive', () => {
  assert.equal(parse('date:This-Month').filters.after, parse('date:this-month').filters.after);
});

test('an unknown word after a date operator is still plain text', () => {
  // date:tomorrow is not supported; it must not become a silent no-op filter,
  // and it must not error either — it is simply not a date, like after:party.
  const r = parse('date:tomorrow');
  assert.equal(r.filters.after, null);
  assert.equal(r.errors.length, 0);
  assert.match(r.text, /date:tomorrow/);
});
