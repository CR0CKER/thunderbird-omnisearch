'use strict';
// The search page. Sends queries/commands to the background script (which owns
// the index) and renders ranked results.
(function () {
  const $ = (id) => document.getElementById(id);
  const queryInput = $('q');
  const clearBtn = $('clear');
  const resultsEl = $('results');
  const statusEl = $('status');
  const progressEl = $('progress');
  const emptyEl = $('empty');
  const chipsEl = $('chips');
  const loadingEl = $('loading');

  // Launched as the centered standalone window (background opens
  // ui/search.html#modal) rather than the toolbar-anchored popup. Enables
  // Escape-to-close and self-resizing so the window grows from just the search
  // field to fit results. The <html> also carries class "modal" for layout.
  const isModal = location.hash === '#modal';
  let modalWinId = null;
  // The window's opening height. Must track SPOTLIGHT_H in background.js. The
  // window never shrinks below this, so the empty/loading state never triggers a
  // resize — it only grows to fit real results. We use a fixed constant rather
  // than reading window.outerHeight at init because on GNOME/Wayland the
  // compositor may not have applied the requested open height yet when this runs;
  // a 0/stale read there would collapse the floor and let the empty state resize
  // on open — the flicker. See window-positioning notes.
  const MODAL_MIN_H = 140;
  let modalMinHeight = 0;

  // Resize the window to fit its content (header + results), capped, so it grows
  // as results appear and shrinks back (no lower than the opening size) when the
  // query is cleared. Driven by a ResizeObserver on the body; updating the window
  // height doesn't change body height (natural/content-sized), so no feedback loop.
  function fitModalWindow() {
    if (!isModal || modalWinId == null) return;
    const maxContent = Math.min(560, Math.round((screen.availHeight || 900) * 0.7));
    const content = Math.min(document.body.scrollHeight, maxContent);
    const chrome = Math.max(0, window.outerHeight - window.innerHeight);
    // Grow to fit content (header on open, then results), floored so the window
    // never shrinks below its opening size. The loading hint is the field
    // placeholder (not a height-changing banner), so the empty/loading state
    // doesn't grow-then-shrink — that was the original flicker.
    const target = Math.max(modalMinHeight, content + chrome + 2);
    if (Math.abs(target - window.outerHeight) <= 4) return; // ignore sub-pixel churn
    // Only change height — the window grows straight down from its anchored
    // position (set in background.js for the expanded height). We never move the
    // top, so there's no jerky repositioning as results appear.
    messenger.windows.update(modalWinId, { height: target }).catch(() => {});
  }

  // Show the "not ready yet" hint, worded for what's actually happening:
  // "Indexing…" while a (re)build runs, "Loading…" while the index loads from
  // disk. In the toolbar popup this is the #loading banner; in the centered
  // window we use the field's placeholder instead so the hint never changes the
  // window's height (which would cause an open-time grow-then-shrink flicker).
  const basePlaceholder = queryInput.placeholder;
  const loadingTextEl = loadingEl.querySelector('span:last-of-type');
  function showLoadingHint(show, building) {
    const msg = building ? 'Indexing your mail…' : 'Loading your mail index…';
    if (isModal) {
      queryInput.placeholder = show ? msg : basePlaceholder;
    } else {
      loadingEl.hidden = !show;
      if (show && loadingTextEl) loadingTextEl.textContent = msg;
    }
  }

  function send(msg) {
    return messenger.runtime.sendMessage(msg);
  }

  async function getSettings() {
    try {
      const result = await messenger.storage.local.get('settings');
      return result.settings || {};
    } catch (e) {
      return {};
    }
  }

  function fmtDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // The field is usable immediately (type-ahead): you can start typing while the
  // index loads/builds. The "Loading…" indicator stays up until the index is
  // genuinely ready — meaning it has finished loading AND any (re)build is done
  // AND the first results for a typed query are actually on screen. That last
  // part is what closes the visible gap: we never hide the indicator before
  // search output appears. See refreshStatus() for the readiness logic.
  let ready = false;
  // Safety net only: unstick the indicator if the background never answers at
  // all (it normally replies 'loading' within ~500ms, so this won't fire during
  // a slow cold load). Does not block the readiness-driven auto-search.
  function forceReady() {
    if (ready) return;
    ready = true;
    showLoadingHint(false);
  }

  function renderStatus(s) {
    if (s.state === 'loading') {
      // The #loading banner already says "Loading your mail index…"; keep the
      // status line clear so we don't flash a misleading "0 messages indexed".
      progressEl.hidden = true;
      statusEl.textContent = '';
      return;
    }
    if (s.state === 'building') {
      progressEl.hidden = false;
      progressEl.value = s.progress || 0;
      const pct = Math.round((s.progress || 0) * 100);
      if (s.total) {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} / ${s.total.toLocaleString()} messages (${pct}%)`;
      } else {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} messages so far`;
      }
    } else {
      progressEl.hidden = true;
      if (s.state === 'empty') {
        // The Rebuild control lives in Settings, not this popup, so make the word
        // itself the trigger — otherwise "click Rebuild" points at nothing here.
        statusEl.replaceChildren();
        statusEl.append('No index yet — ');
        const rebuildLink = document.createElement('button');
        rebuildLink.type = 'button';
        rebuildLink.className = 'linkbtn';
        rebuildLink.textContent = 'Rebuild';
        rebuildLink.addEventListener('click', () => void startRebuild());
        statusEl.append(rebuildLink, ' to index your mail.');
      } else {
        // Ready. This row used to read "78,900 messages indexed · updated
        // 15:00" — information you read once and then never again, occupying the
        // most visible space in the window. The index count and freshness still
        // live on the Settings page (options.js), which is also where a save
        // error is reported, so nothing diagnostic is lost here.
        //
        // Filter templates go here instead. Reusing this existing row is what
        // makes permanent discoverability affordable: the row is already part of
        // the window's opening height, so nothing resizes on open — which is why
        // the hint had to hide in the empty state before.
        // Build once, not on every poll: refreshStatus() runs twice a second,
        // and re-creating these buttons that often would rip focus away from a
        // keyboard user who had tabbed onto one. Other states set textContent,
        // which clears the row, so this rebuilds when returning from them.
        if (!statusEl.querySelector('.templates')) {
          statusEl.replaceChildren(renderFilterTemplates());
        }
        syncTemplateVisibility();
      }
    }
  }

  // Filter templates shown in the status row while the field is empty. Each is a
  // button: clicking inserts the bare operator ("date:") and focuses the field
  // so the user types the value. The example beside it is illustration, not
  // inserted text — it is rendered muted precisely so it reads as "your value
  // goes here" rather than as content.
  //
  // Examples deliberately show BOTH accepted date forms — year-first and a
  // spelled month — because value format is where this feature has misled users
  // repeatedly: knowing `date:` exists is useless if you then write 7/6/2024.
  // The range form (date:A..B) is taught by the empty-state hint instead; it is
  // too long to keep this row on one line, and the row must not wrap (see the
  // .templates comment in search.css).
  const FILTER_TEMPLATES = [
    { op: 'from', example: 'alice' },
    { op: 'to', example: 'bob' },
    { op: 'date', example: '2024-06' },
    { op: 'after', example: '2024-06' },
    { op: 'before', example: '7 july 2024' },
  ];

  // Append "op:" to the query and put the caret after it, ready for a value.
  function insertOperator(op) {
    const current = queryInput.value.replace(/\s+$/, '');
    queryInput.value = (current ? current + ' ' : '') + op + ':';
    syncQueryUi();
    queryInput.focus();
    const end = queryInput.value.length;
    queryInput.setSelectionRange(end, end);
    // A bare "date:" resolves to no filter and no error (the parser treats a
    // trailing incomplete value as still-being-typed), so this re-runs safely.
    void runSearch();
  }

  function renderFilterTemplates() {
    const row = document.createElement('div');
    row.className = 'templates';
    for (const { op, example } of FILTER_TEMPLATES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'template-chip';
      chip.title = `Add a ${op}: filter — for example ${op}:${example}`;
      chip.setAttribute('aria-label', `Add ${op} filter, for example ${op} ${example}`);

      const plus = document.createElement('span');
      plus.className = 't-plus';
      plus.textContent = '+';
      plus.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = 't-op';
      name.textContent = `${op}:`;

      const eg = document.createElement('span');
      eg.className = 't-example';
      eg.textContent = example;

      chip.append(plus, name, eg);
      chip.addEventListener('click', () => insertOperator(op));
      row.appendChild(chip);
    }
    return row;
  }

  // Templates are a cold-start affordance, not a permanent toolbar. They hide as
  // soon as the field has text, which also keeps them from sitting directly
  // above the ACTIVE filter chips — those look similar but mean the opposite
  // (click to remove, not to add), and showing both at once invites misclicks.
  function syncTemplateVisibility() {
    statusEl.classList.toggle('has-query', queryInput.value.trim().length > 0);
  }

  // One-line pointer at the filter syntax, built from DOM nodes so the examples
  // can be marked up as code without innerHTML.
  function filterHint() {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.append('Tip: narrow a search with ');
    for (const [i, example] of ['from:alice', 'date:2024-06', 'date:2024-06..2024-07'].entries()) {
      if (i) hint.append(i === 2 ? ' or ' : ', ');
      const code = document.createElement('code');
      code.textContent = example;
      hint.appendChild(code);
    }
    hint.append('.');
    return hint;
  }

  // Describe the active date/sender filters in the user's own terms, so a
  // zero-result search reads as "nothing matched in that window" rather than
  // looking like the search is broken.
  function describeFilters(filters) {
    if (!filters) return '';
    const parts = [];
    if (filters.from) parts.push(`from ${filters.from}`);
    if (filters.to) parts.push(`to ${filters.to}`);
    const d = (ms) => new Date(ms).toLocaleDateString();
    if (filters.after != null && filters.before != null) parts.push(`between ${d(filters.after)} and ${d(filters.before)}`);
    else if (filters.after != null) parts.push(`on or after ${d(filters.after)}`);
    else if (filters.before != null) parts.push(`on or before ${d(filters.before)}`);
    return parts.join(', ');
  }

  // Label a chip with the RESOLVED meaning of its filter rather than the text
  // that was typed — "1 Jun 2024 – 31 Jul 2024", not "date:2024-06..2024-07".
  // A range that came out a month wider than intended is then visible before it
  // quietly returns the wrong mail.
  function chipLabel(entry) {
    if (entry.op === 'from' || entry.op === 'to') return `${entry.op}: ${entry.value}`;
    const d = (ms) => new Date(ms).toLocaleDateString();
    if (entry.after != null && entry.before != null) {
      // A single day resolves to the same date at both ends; say it once.
      const a = d(entry.after);
      const b = d(entry.before);
      return a === b ? a : `${a} – ${b}`;
    }
    if (entry.after != null) return `on or after ${d(entry.after)}`;
    return `on or before ${d(entry.before)}`;
  }

  // A geometrically centred ✕, matching the inline-SVG approach already used for
  // the settings button. currentColor so it follows the theme and hover state.
  function closeIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '10');
    svg.setAttribute('height', '10');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M3.5 3.5 L8.5 8.5 M8.5 3.5 L3.5 8.5');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  // Rebuild the query from the chips the user kept, plus the leftover free
  // text. Reconstructing beats cutting the removed operator out of the raw
  // string, which would be ambiguous whenever the same text appears twice.
  function removeFilter(applied, index, freeText) {
    const kept = applied.filter((_, i) => i !== index).map((a) => a.source);
    queryInput.value = [...kept, freeText].join(' ').trim();
    syncQueryUi();
    queryInput.focus();
    void runSearch();
  }

  function renderChips(applied, freeText) {
    chipsEl.replaceChildren();
    for (const [index, entry] of (applied || []).entries()) {
      const chip = document.createElement('span');
      chip.className = 'chip';

      const label = document.createElement('span');
      label.className = 'chip-label';
      // textContent, never innerHTML: from:/to: values come from the query but
      // are echoed back alongside mail-derived content elsewhere in this list.
      label.textContent = chipLabel(entry);
      label.title = entry.source; // what was typed, on hover

      const remove = document.createElement('button');
      remove.className = 'chip-remove';
      remove.type = 'button';
      // Drawn, not typed. The "×" character sits on the font's math axis, above
      // the centre of its em box, so it renders high inside the round hover
      // background no matter how the box itself is centred — flex centring the
      // line box does not move the glyph within it. An SVG has no such metrics.
      remove.appendChild(closeIcon());
      remove.title = `Remove ${entry.source}`;
      remove.setAttribute('aria-label', `Remove filter ${chipLabel(entry)}`);
      remove.addEventListener('click', () => removeFilter(applied, index, freeText));

      chip.append(label, remove);
      chipsEl.appendChild(chip);
    }
  }

  function renderResults(results, query, errors, filters, applied, freeText) {
    resultsEl.replaceChildren();
    emptyEl.replaceChildren();
    renderChips(applied, freeText || '');

    // A rejected date operator MUST be shown. Dropping it silently would run an
    // unfiltered search that looks like it worked — exactly the failure the
    // parser's reject-rather-than-guess rule exists to prevent.
    if (errors && errors.length) {
      emptyEl.textContent = errors.join(' ');
      return;
    }

    const scope = describeFilters(filters);
    if (!query.trim() && !scope) return;
    if (results.length === 0) {
      emptyEl.textContent = scope ? `No matches ${scope}.` : 'No matches.';
      // The filters are invisible unless something points at them, and a search
      // that found nothing is when someone is most receptive to learning they
      // exist. Deliberately NOT shown at rest: an always-present hint would add
      // height to the centered window's opening size and make it resize on open.
      emptyEl.appendChild(filterHint());
      return;
    }
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'result';
      li.tabIndex = 0; // focusable for keyboard navigation

      // Built entirely with DOM nodes + textContent, never innerHTML: result
      // fields (subject/from/to/preview) come from email content and are therefore
      // attacker-controlled. textContent cannot inject markup, so there is no HTML
      // escaping to get right — and the addons-linter's "unsafe innerHTML" warning
      // goes away because no markup string is ever assigned.
      const subject = document.createElement('span');
      subject.className = 'subject';
      subject.textContent = r.subject || '(no subject)';
      if (r.encrypted || !r.bodyAvailable) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        if (r.encrypted) {
          badge.title = 'Encrypted message — indexed by subject/sender only';
          badge.textContent = 'encrypted';
        } else {
          badge.title = 'Indexed by header only';
          badge.textContent = 'header-only';
        }
        subject.appendChild(badge); // .badge margin-left provides the gap
      }

      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = fmtDate(r.date);

      const row = document.createElement('div');
      row.className = 'row';
      row.append(subject, date);

      // A deduplicated result lists every folder the email appears in (e.g. a
      // Gmail message in both Inbox and All Mail). Fall back to the single
      // folderName for older result payloads.
      const folders = (r.folders && r.folders.length ? r.folders : [r.folderName]).filter(Boolean);
      const folder = document.createElement('span');
      folder.className = 'folder';
      folder.textContent = folders.join(' · ');

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.append(`${r.from} → ${r.to} · `, folder);

      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = r.preview;

      li.append(row, meta, preview);
      li.addEventListener('click', async () => {
        // headerMessageId is the stable identity the background reopens by; the
        // numeric id is only a hint (it changes across restarts). accountId
        // disambiguates the same Message-ID appearing in two accounts.
        await send({
          type: 'open',
          id: r.id,
          headerMessageId: r.headerMessageId,
          accountId: r.accountId,
        });
        // Close the popup once the message opens, unless the user opted to keep
        // it open in settings.
        const settings = await getSettings();
        if (!settings.keepOpenAfterResult) window.close();
      });
      resultsEl.appendChild(li);
    }
  }

  let searchSeq = 0;
  async function runSearch() {
    // Before the index is ready we don't search — the query just sits in the
    // field. refreshStatus() runs it the instant the index becomes ready, so a
    // word typed during load/indexing searches automatically (no competing
    // in-flight request while loading).
    if (!ready) return;
    const query = queryInput.value;
    const seq = ++searchSeq;
    let reply;
    try {
      reply = await send({ type: 'search', query });
    } catch (e) {
      statusEl.textContent = 'Search backend not responding — reload the add-on (Remove + Load again). ' + (e && e.message ? e.message : '');
      return;
    }
    if (seq !== searchSeq) return; // a newer keystroke superseded this one
    if (reply && reply.type === 'results') {
      renderResults(reply.results, query, reply.errors, reply.filters, reply.applied, reply.text);
    }
    else emptyEl.textContent = 'No response from the index.';
  }

  // Kick off a full index build from the empty-state "Rebuild" link. The
  // background returns immediately (the build runs async); the status poll then
  // picks up the 'building' state and shows progress, so we just nudge it.
  async function startRebuild() {
    try {
      await send({ type: 'rebuild' });
    } catch (e) {
      statusEl.textContent = 'Could not start indexing — open Settings to rebuild.';
      return;
    }
    void refreshStatus();
  }

  let gotReply = false;
  let searchedUpdatedAt = null;
  async function refreshStatus() {
    try {
      const reply = await send({ type: 'status' });
      if (!reply || reply.type !== 'status') return;
      gotReply = true;
      const s = reply.status;
      renderStatus(s);

      // 'loading' (cold load) and 'building' (rebuild) both mean the index isn't
      // usable yet — keep the indicator up (worded for which one) and don't search.
      const usable = s.state === 'ready' || s.state === 'empty';
      if (!usable) {
        showLoadingHint(true, s.state === 'building');
        return;
      }

      ready = true;
      // Auto-run the typed query the first time the index is usable, and again
      // whenever its contents change (updatedAt advances after a (re)build or new
      // mail). This shows results automatically no matter how long the load took,
      // without relying on a timer or on having observed the 'building' phase.
      const u = s.updatedAt || 0;
      if (queryInput.value.trim() && u !== searchedUpdatedAt) {
        searchedUpdatedAt = u;
        await runSearch(); // keep the indicator up until results are on screen
      }
      showLoadingHint(false);
    } catch (e) {
      statusEl.textContent = 'Background not responding — reload the add-on (Remove + Load again).';
    }
  }

  // Called by every path that changes the query text, so the chrome that depends
  // on it stays in step: the clear button, and the filter templates (which hide
  // once there is text). Folded into one function rather than remembered
  // separately at each call site.
  function syncQueryUi() {
    clearBtn.hidden = queryInput.value.length === 0;
    syncTemplateVisibility();
  }

  let debounce;
  queryInput.addEventListener('input', () => {
    syncQueryUi();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void runSearch(), 120);
  });

  clearBtn.addEventListener('click', () => {
    queryInput.value = '';
    syncQueryUi();
    resultsEl.replaceChildren();
    emptyEl.replaceChildren();
    // Chips must go with the query that produced them — a chip left behind
    // would claim a filter that is no longer being applied.
    chipsEl.replaceChildren();
    queryInput.focus();
  });

  // Esc clears the field when it has text; when empty, the anchored popup closes
  // natively, but the Spotlight window must close itself.
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (queryInput.value) {
        e.stopPropagation();
        e.preventDefault();
        clearBtn.click();
      } else if (isModal) {
        e.preventDefault();
        window.close();
      }
      return;
    }
    // Tab (or Down) from the search field jumps to the first result.
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown') {
      const items = resultsEl.querySelectorAll('li.result');
      if (items.length) {
        e.preventDefault();
        items[0].focus();
      }
    }
  });

  // Within the results: Tab/Down move down, Shift+Tab/Up move up (Up at the top
  // returns to the search field), Enter opens the focused result.
  resultsEl.addEventListener('keydown', (e) => {
    const items = [...resultsEl.querySelectorAll('li.result')];
    const current = items.indexOf(document.activeElement);
    if (current === -1) return;

    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (current < items.length - 1) items[current + 1].focus();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (current > 0) items[current - 1].focus();
      else queryInput.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[current].click();
    }
  });

  // Index controls (Rebuild / Verify & repair) now live in the settings page.
  // Close the search window once Settings opens so it doesn't linger over the
  // options tab. (The toolbar popup would close on blur anyway; the centered
  // window must close itself.) Await the open first so closing doesn't abort it.
  $('settings').addEventListener('click', async () => {
    try {
      await messenger.runtime.openOptionsPage();
    } finally {
      window.close();
    }
  });

  if (isModal) {
    document.documentElement.classList.add('modal');
    // Floor the window at its opening size so the empty/loading state never
    // resizes (only real results grow it) — kills the open-time flicker.
    modalMinHeight = MODAL_MIN_H;
    // Learn our own window id, then size to fit and keep fitting as content
    // (results) changes.
    messenger.windows
      .getCurrent()
      .then((w) => {
        modalWinId = w.id;
        fitModalWindow();
      })
      .catch(() => {});
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitModalWindow);
    }).observe(document.body);
    // Dismiss with Escape or by opening a result. (We deliberately do NOT close
    // on window blur: GNOME/Wayland fires a blur when you start dragging the
    // window, which made it vanish mid-move.)
  }

  // Show the (non-blocking) loading hint until the first status reply. The field
  // stays enabled and focused the whole time so the user can type immediately.
  showLoadingHint(true);
  queryInput.focus();
  // Safety net: only force-clear the hint if the background never answers at
  // all. If it's replying (e.g. "building" during a long rebuild) we leave the
  // indicator up until the index is genuinely ready.
  setTimeout(() => {
    if (!gotReply) forceReady();
  }, 8000);
  setInterval(() => void refreshStatus(), 500);
  void refreshStatus();
})();
