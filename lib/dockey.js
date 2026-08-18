'use strict';
// The document key: the single answer to "is this a message I already have?".
// Exposes globalThis.OmniKey.
//
// This module is deliberately tiny and dependency-free because it is loaded on
// BOTH sides of the worker boundary — as a background script (manifest.json) and
// via importScripts in lib/engine.worker.js. The watermark catch-up runs on the
// main thread, since that is the only place messenger.* exists, and it must
// compute exactly the key the worker stores documents under. Two copies of this
// rule would drift, and the drift would look like mail silently going missing.
//
// Why not the numeric id: a MessageHeader.id is "an internal tracking number
// that does not remain after a restart". Thunderbird reissues those numbers from
// a low, dense range each session — measured on a real profile, the stored ids
// filled 99.7% of the contiguous range [3..79079] — so a stored id does not go
// dead, it starts addressing a DIFFERENT message. Keyed on that, upsert cannot
// tell an update from an insert and reconcile cannot tell missing from present.
// The RFC Message-ID is the stable identity; see docs/adr/0001.
(function () {
  // NUL separator: it cannot occur in an account id or a Message-ID, so the
  // composite key is unambiguous. Written as the ESCAPE '\0' — a literal NUL
  // byte in the source makes git classify this file as binary, which silently
  // costs you every diff (git diff / log -p / PR review) on it.
  const SEP = '\0';

  // Scoped per account: the same Message-ID can legitimately exist in two
  // accounts, and those are two different messages to the user (and must reopen
  // from the right account — see lib/open.js).
  //
  // A message with no Message-ID falls back to the numeric id, which is unstable
  // by definition. That is deliberate: such a doc simply never collapses with
  // another, which is the safe failure — worse than a stable key, better than
  // merging two unrelated messages. In practice Thunderbird synthesizes an
  // `md5:` pseudo Message-ID, so this path is rare (229 of 78,859 docs on the
  // reference profile, all of which still had a usable id).
  function docKey(doc) {
    if (!doc) return '';
    const mid = doc.headerMessageId || '';
    if (!mid) return 'id:' + (doc.id == null ? '' : String(doc.id));
    return (doc.accountId || '') + SEP + mid;
  }

  globalThis.OmniKey = { docKey, SEP };
})();
