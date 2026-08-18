'use strict';
// OmniQuery: parses search-query operators (date:/after:/before:/from:/to:) out
// of the user's query string, leaving the free text for MiniSearch.
//
// Pure and dependency-free — no messenger, no MiniSearch, no DOM — so it unit-
// tests directly (test/query.test.js) and runs inside the engine worker.
//
// Design rule, and the reason the syntax is teachable in one line:
//   EVERY DATE VALUE DENOTES A PERIOD, AND OPERATORS SNAP TO ITS EDGES.
//     after:X   -> from the START of period X
//     before:X  -> to the END of period X
//     date:A..B -> from the start of A to the end of B
//     date:X    -> the whole of period X
// The period is whatever precision was typed: 2024 a year, 2024-06 a month,
// 2024-06-15 a day. So "date:2024-06..2024-07" is 1 June – 31 July inclusive.
// Gmail's before: is *exclusive*, forcing the user to name a month they don't
// want (before:2024/08/01 to include July). Ours includes the named period.
(function () {
  const OPERATORS = ['from', 'to', 'after', 'before', 'date'];

  // Month names in the languages lib/extract.js already handles (EN/DE/FR/ES).
  // Same hand-rolled approach — this extension has no _locales i18n machinery.
  // Accents are stripped before lookup, so "février" and "fevrier" both work.
  const MONTHS = {
    // English
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    // German
    januar: 1, februar: 2, marz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, dezember: 12,
    // French
    janvier: 1, fevrier: 2, mars: 3, avril: 4, juin: 6, juillet: 7, aout: 8,
    septembre: 9, octobre: 10, novembre: 11, decembre: 12,
    // Spanish
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
    agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  };

  const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // ---- Period construction (LOCAL time, always) ----------------------------
  //
  // Never `new Date(string)` / `Date.parse()`. An ISO-shaped string parses as
  // UTC while the same date unpadded parses as LOCAL — a silent skew of the UTC
  // offset, which would put mail from late on 31 May inside an "after June"
  // filter. Values are hand-parsed into integers and built with the local
  // multi-argument constructor. Period *ends* are the start of the next period
  // minus 1ms, so month lengths, leap days and DST are resolved by the Date
  // engine rather than by arithmetic.
  const startOfDay = (y, m, d) => new Date(y, m - 1, d).getTime();
  const period = (y, m, d) => {
    if (d != null) return { start: startOfDay(y, m, d), end: startOfDay(y, m, d + 1) - 1 };
    if (m != null) return { start: startOfDay(y, m, 1), end: startOfDay(y, m + 1, 1) - 1 };
    return { start: startOfDay(y, 1, 1), end: startOfDay(y + 1, 1, 1) - 1 };
  };

  // Parse outcomes are tagged rather than thrown: the popup parses on every
  // keystroke, and an exception in the engine worker kills the search.
  //   {ok}         a resolved period
  //   {incomplete} still being typed — no filter, no error, stay quiet
  //   {error}      complete but unusable — surface it to the user
  const OK = (p) => ({ ok: p });
  const INCOMPLETE = { incomplete: true };
  const ERR = (message) => ({ error: message });

  // Every rejection teaches the same rule — write the year first — so it is
  // learned in one encounter. Quoting is deliberately NOT suggested: it stopped
  // being necessary, and advising it sends people down the path that made
  // `date:7 july 2024` fail.
  const GUIDANCE = 'Write dates year first (e.g. 2024-06-07), or spell the month (e.g. 7 June 2024).';

  // Month names are accepted in every order people actually write them:
  //   "7 july 2024"  (day first)  "july 7 2024" (month first)  "july 2024"
  // A spelled month is unambiguous however it is ordered, which is exactly why
  // it is the escape hatch the rejection messages point at.
  const DAY_MONTH_YEAR_RE = /^(\d{1,2})[ -]([a-z]+)[ -](\d{4})$/;
  const MONTH_DAY_YEAR_RE = /^([a-z]+)[ -](\d{1,2})[ -](\d{4})$/;
  const MONTH_YEAR_RE = /^([a-z]+)[ -](\d{4})$/;
  const NUMERIC_RE = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/;
  const SLASH_FIRST_RE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/;

  const MONTH_LABEL = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // Resolve one date value to a period. Returns a tagged outcome (see above).
  function parsePeriod(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return INCOMPLETE;
    // Commas are punctuation people type in dates ("July 7, 2024"), never
    // meaningful here; collapse them and any doubled spaces away.
    const value = deaccent(raw.toLowerCase()).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

    // Still typing: a bare 1–3 digits, or anything ending in a separator.
    if (/^\d{1,3}$/.test(value) || /[-/]$/.test(value)) return INCOMPLETE;

    // Year-first numeric: the only unambiguous all-digit form, because a
    // 4-digit leading component can only be a year.
    const num = NUMERIC_RE.exec(value);
    if (num) {
      const y = +num[1];
      const m = num[2] == null ? null : +num[2];
      const d = num[3] == null ? null : +num[3];
      // A zero component is a prefix of a real one ("2024-0" on the way to
      // "2024-06"), so treat it as incomplete rather than wrong.
      if (m === 0 || d === 0) return INCOMPLETE;
      if (m != null && m > 12) return ERR(`Invalid month in "${raw}" — months run from 1 to 12.`);
      if (d != null && d > 31) return ERR(`Invalid day in "${raw}" — days run from 1 to 31.`);
      // Reject a day that does not exist in that month (e.g. 2024-02-30) rather
      // than letting Date silently roll it into the next month.
      if (d != null && new Date(y, m - 1, d).getMonth() !== m - 1) {
        return ERR(`"${raw}" is not a real date.`);
      }
      return OK(period(y, m, d));
    }

    // Month name in any order: "7 June 2024", "June 7 2024", "June 2024".
    let name = null;
    let day = null;
    let year = null;
    let m;
    if ((m = DAY_MONTH_YEAR_RE.exec(value))) [, day, name, year] = m;
    else if ((m = MONTH_DAY_YEAR_RE.exec(value))) [, name, day, year] = m;
    else if ((m = MONTH_YEAR_RE.exec(value))) [, name, year] = m;
    if (name) {
      const month = MONTHS[name];
      if (month) {
        const d = day == null ? null : +day;
        const y = +year;
        if (d != null && (d < 1 || new Date(y, month - 1, d).getMonth() !== month - 1)) {
          return ERR(`"${raw}" is not a real date.`);
        }
        return OK(period(y, month, d));
      }
      return null; // not a date at all — caller keeps it as free text
    }

    // Day/month-first slash date. REJECTED UNIFORMLY, including forms that are
    // technically unambiguous (13/6/2024 — 13 cannot be a month). Accepting
    // those while rejecting 7/6/2024 would make the same format work sometimes
    // and fail other times; one rule is easier to learn than an exception.
    // Search gives no feedback that a range was wrong — both readings return
    // plausible mail — so guessing here is silently, invisibly wrong.
    const slash = SLASH_FIRST_RE.exec(value);
    if (slash) {
      const a = +slash[1];
      const b = +slash[2];
      const y = slash[3].length === 4 ? slash[3] : `20${slash[3]}`;
      const pad = (n) => String(n).padStart(2, '0');
      // A reading is only offered if it describes a real date.
      const reading = (day, month) =>
        day >= 1 && day <= 31 && month >= 1 && month <= 12
          ? { iso: `${y}-${pad(month)}-${pad(day)}`, words: `${day} ${MONTH_LABEL[month - 1]} ${y}` }
          : null;
      const dayFirst = reading(a, b);
      const monthFirst = reading(b, a);

      // Genuinely ambiguous only when both readings exist AND differ. For
      // "7/7/2024" they coincide, and reporting "7 July 2024 or 7 July 2024?"
      // is nonsense — it is refused solely to keep the year-first rule uniform.
      if (dayFirst && monthFirst && dayFirst.iso !== monthFirst.iso) {
        return ERR(
          `Ambiguous date "${raw}" — did you mean ${dayFirst.words} or ${monthFirst.words}? ` +
            `Write it year first as ${dayFirst.iso} or ${monthFirst.iso}, or spell the month.`,
        );
      }
      // Suggest the correction for what was actually typed, rather than a fixed
      // example of some unrelated date.
      const only = dayFirst || monthFirst;
      if (only) {
        return ERR(`Unsupported date "${raw}" — write dates year first: ${only.iso} (or spell the month: ${only.words}).`);
      }
      return ERR(`Unsupported date "${raw}" — ${GUIDANCE}`);
    }

    return null; // not date-shaped — free text (e.g. "after:party")
  }

  // Resolve an operator's value into {after, before}, or a tagged outcome.
  function resolveDateOperator(op, rawValue) {
    const rangeParts = rawValue.split('..');
    if (rangeParts.length === 2) {
      if (!rangeParts[0] || !rangeParts[1]) return INCOMPLETE; // "2024-06.." mid-typing
      const a = parsePeriod(rangeParts[0]);
      const b = parsePeriod(rangeParts[1]);
      for (const part of [a, b]) {
        if (part == null) return null;
        if (part.incomplete) return INCOMPLETE;
        if (part.error) return part;
      }
      if (a.ok.start > b.ok.end) {
        return ERR(`"${rawValue}" is a backwards range — the start is after the end.`);
      }
      return OK({ after: a.ok.start, before: b.ok.end });
    }

    const p = parsePeriod(rawValue);
    if (p == null) return null;
    if (p.incomplete || p.error) return p;
    if (op === 'after') return OK({ after: p.ok.start, before: null });
    if (op === 'before') return OK({ after: null, before: p.ok.end });
    return OK({ after: p.ok.start, before: p.ok.end }); // date:
  }

  // Is this value evidently *meant* as a date, even though it did not resolve?
  // Digits or a spelled month say yes; "party" says no. Used to decide between
  // reporting an error and leaving the token as ordinary search text.
  function looksDateish(rawValue) {
    const v = deaccent(String(rawValue || '').toLowerCase()).trim();
    if (!v) return false;
    if (/^\d/.test(v)) return true;
    return Object.prototype.hasOwnProperty.call(MONTHS, v.split(/[\s,-]/)[0]);
  }

  // Split on whitespace, keeping "quoted phrases" together. A quoted token is
  // never treated as an operator, so `"from:"` searches for the literal text.
  function tokenize(query) {
    const tokens = [];
    // A token is a run of non-space characters in which a "quoted section"
    // counts as part of the same token — so `date:"June 2024"` stays one token
    // rather than splitting at the space, while `"from:"` is a standalone
    // quoted token. An unterminated quote simply matches nothing and is
    // skipped, which keeps mid-typing input from throwing.
    const re = /(?:"[^"]*"|[^\s"])+/g;
    let m;
    while ((m = re.exec(query)) !== null) {
      const whole = /^"([^"]*)"$/.exec(m[0]);
      if (whole) tokens.push({ text: whole[1], quoted: true });
      else tokens.push({ text: m[0], quoted: false });
    }
    return tokens;
  }

  // Parse a query into free text, filters, and any user-facing errors.
  // `now` is injected so relative/preset values (a later phase) and tests stay
  // deterministic. Never throws.
  function parse(query, now) {
    void now;
    const filters = { after: null, before: null, from: null, to: null };
    const errors = [];
    const textParts = [];
    // What the UI needs to render removable chips: the exact source text each
    // applied operator consumed, so removing a chip can rebuild the query from
    // the remaining sources plus the leftover free text. String-surgery on the
    // raw query would be ambiguous whenever a substring repeats. Only operators
    // that actually took effect are listed — a chip claiming a filter that was
    // rejected would be a lie.
    const applied = [];

    const tokens = tokenize(String(query || ''));
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const match = token.quoted ? null : /^([a-zA-Z_]+):([\s\S]*)$/.exec(token.text);
      const op = match && match[1].toLowerCase();
      if (!match || !OPERATORS.includes(op)) {
        textParts.push(token.text);
        continue;
      }

      // An operator whose value was quoted separately: from:"alice smith".
      // The tokenizer split it, so re-join is not needed — the regex captured
      // the quotes' contents only when the whole token was quoted, so handle
      // the `op:"value"` shape here.
      let rawValue = match[2];
      const quotedValue = /^"([^"]*)"$/.exec(rawValue);
      if (quotedValue) rawValue = quotedValue[1];

      if (op === 'from' || op === 'to') {
        if (!rawValue) continue; // "from:" while typing — no filter, no error
        filters[op] = rawValue.toLowerCase();
        applied.push({ op, source: token.text, value: filters[op] });
        continue;
      }

      // A date value may be several words — `date:7 july 2024`. The tokenizer
      // split on those spaces, so try the longest candidate first (this token
      // plus up to two following ones) and take the first that actually
      // resolves. Requiring quotes here was a real bug: `date:7 july 2024` had
      // `date:7` swallowed as "still typing" while `july 2024` fell through as
      // free text, so the search ran UNFILTERED and looked like it had worked.
      // Longest-first, accepting only a successful parse, means extra words are
      // never stolen from the search text: `date:2024 budget report` consumes
      // only `2024`.
      const maxExtra = Math.min(2, tokens.length - 1 - i);
      let outcome = null;
      let consumed = 0;
      for (let extra = maxExtra; extra >= 1; extra--) {
        const candidate = [rawValue, ...tokens.slice(i + 1, i + 1 + extra).map((t) => t.text)].join(' ').trim();
        const attempt = resolveDateOperator(op, candidate);
        if (attempt && attempt.ok) {
          outcome = attempt;
          consumed = extra;
          break;
        }
      }
      if (!outcome) outcome = resolveDateOperator(op, rawValue);
      // Capture the consumed source BEFORE advancing, so a multi-word value
      // ("date:7 july 2024") yields a chip that removes all of it, not just the
      // operator token.
      const source = [token.text, ...tokens.slice(i + 1, i + 1 + consumed).map((t) => t.text)].join(' ');
      i += consumed;

      if (outcome == null) {
        // Not date-shaped at all. `after:party` is a legitimate text search and
        // must stay one. But a value that clearly IS meant as a date — it starts
        // with digits, or with a month name — must not quietly become free text:
        // `after:july 7 2024` used to do exactly that and ran unfiltered,
        // which is indistinguishable from success. Same last-token rule as
        // elsewhere: at the end of the query the user is still typing it.
        if (looksDateish(rawValue)) {
          if (i < tokens.length - 1) errors.push(`Unrecognised date "${rawValue}" — ${GUIDANCE}`);
        } else {
          textParts.push(token.text);
        }
        continue;
      }
      if (outcome.incomplete) {
        // Incomplete is only benign while the user is still typing it, which
        // means it is the LAST thing in the query. Anywhere else they have
        // moved on and the value is simply unusable — say so rather than
        // dropping the filter in silence and running an unfiltered search.
        if (i < tokens.length - 1) {
          errors.push(`Incomplete date "${rawValue}" — ${GUIDANCE}`);
        }
        continue;
      }
      if (outcome.error) {
        errors.push(outcome.error);
        continue;
      }
      // Combining operators narrows: the latest bound of each kind wins.
      if (outcome.ok.after != null) filters.after = outcome.ok.after;
      if (outcome.ok.before != null) filters.before = outcome.ok.before;
      applied.push({ op, source, after: outcome.ok.after, before: outcome.ok.before });
    }

    return { text: textParts.join(' ').trim(), filters, errors, applied };
  }

  const hasFilters = (filters) =>
    !!filters && (filters.after != null || filters.before != null || !!filters.from || !!filters.to);

  // Build the MiniSearch `filter` predicate for these filters, or null when
  // there is nothing to filter. It reads STORED fields (date/from/to), which is
  // why no reindex is needed — and why from:/to: are genuinely field-scoped,
  // unlike a tokenized term, which matches any field in the document.
  function toPredicate(filters) {
    if (!hasFilters(filters)) return null;
    const { after, before, from, to } = filters;
    return (doc) => {
      const date = doc.date || 0;
      if (after != null && !(date >= after)) return false;
      if (before != null && !(date <= before)) return false;
      if (from && String(doc.from || '').toLowerCase().indexOf(from) === -1) return false;
      if (to && String(doc.to || '').toLowerCase().indexOf(to) === -1) return false;
      return true;
    };
  }

  globalThis.OmniQuery = { parse, hasFilters, toPredicate };
})();
