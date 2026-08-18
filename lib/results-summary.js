'use strict';
// The result-list footer's text, as a pure function of paging state.
//
// This lives in lib/ rather than inline in ui/search.js for one reason: it is a
// state machine that shipped broken. The first cut suppressed the footer
// whenever `!hasMore && shown >= total` — which is exactly the state the "All N
// matches shown" branch existed to render, making that branch unreachable. The
// symptom was that the footer vanished the instant paging finished, so the match
// count (the whole point of the feature) was visible only for the few
// milliseconds a page was in flight. Nothing about that involves the DOM or
// messenger.*, so it belongs under test rather than in the "verify by hand in
// Thunderbird" bucket.
(function () {
  // Returns the line to show, or null to show no footer at all.
  function footerText(page, pageSize) {
    const p = page || {};
    const shown = p.shown || 0;
    const total = p.total || 0;

    // A failed page must speak even when the numbers say the list is complete —
    // staying silent here would claim completeness we cannot vouch for.
    if (p.error) return p.error;
    if (!shown) return null;

    // The ONLY reason to show nothing: the whole result set arrived in the first
    // page. That is the common case (a handful of hits), and a permanent count
    // line there would add a row of height to a window sized to its content.
    // Note this tests `total`, not `hasMore` — keying it off the paging flags is
    // what made the completed state indistinguishable from the never-paged one.
    if (total <= pageSize) return null;

    const n = (x) => x.toLocaleString();
    if (p.loading) return 'Loading more…';
    if (p.hasMore) return `Showing ${n(shown)} of ${n(total)} matches`;
    // More matches exist than paging can reach; say so rather than implying the
    // list is complete.
    if (p.capped) return `Showing the top ${n(shown)} of ${n(total)} matches — narrow your search to see the rest`;
    return `All ${n(total)} matches shown`;
  }

  globalThis.OmniResults = { footerText };
})();
