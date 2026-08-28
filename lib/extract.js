'use strict';
// Pure, messenger-free text extraction. Turns a MIME tree (from
// messenger.messages.getFull) into an index doc. Shared by the main-thread
// indexer (incremental updates) and the extractor worker pool (bulk rebuild),
// so the CPU-heavy HTML stripping can run off the main thread and across cores.
// Exposes globalThis.OmniExtract — works both as a background script and via
// importScripts() inside a worker.
(function () {
  const PREVIEW_LEN = 200;
  // Default cap on indexed body length (chars). Bounds the index size / memory /
  // cold-load time; the caller can override per-message (the configurable
  // "Indexed body length" setting, threaded through buildDoc). Smaller = smaller
  // resident index = faster, more consistent cold loads on low-RAM machines.
  const DEFAULT_MAX_BODY = 4000;
  // Hard ceiling on how much raw body text the HTML/quote stripping regexes ever
  // see, regardless of the (much smaller) indexed-body cap. Message bodies are
  // attacker-controlled, and a few of the strip patterns (the greedy <blockquote>
  // match, the line-wise quote scan) can do near-quadratic work on a pathological
  // body — a huge message, many unclosed <blockquote> tags, or one enormous line.
  // Bounding the input keeps that worst case linear-ish. 100k is ~5x the largest
  // selectable body length, and the indexed "new" text is normally at the top
  // (top-posting), so this never costs real content. Belt-and-suspenders: stripping
  // runs in the extractor worker pool, so even an unbounded stall couldn't freeze
  // the UI — this just stops it wasting a core.
  const MAX_EXTRACT_INPUT = 100000;

  function stripHtml(html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      // Drop quoted reply content: Gmail/Apple Mail wrap the quoted message in
      // <blockquote>. The match is greedy (first open → last close) so nested
      // quote levels in a deep thread all go in one shot. (Outlook quotes a
      // border <div> instead of a blockquote; that's caught downstream by
      // stripQuoted via the header block, since we keep newlines below.)
      .replace(/<blockquote[\s\S]*<\/blockquote>/gi, ' ')
      // Turn block-level boundaries into newlines BEFORE dropping tags, so the
      // line-based stripQuoted pass (run on this output in extractText) can see
      // Outlook's "From:/Sent:/…" header block on its own lines.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#\d+;/g, ' ')
      // Collapse runs of spaces/tabs but preserve newlines (and cap blank runs).
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function collectParts(part, plain, html) {
    if (!part) return;
    const ct = (part.contentType || '').toLowerCase();
    if (typeof part.body === 'string' && part.body.length) {
      if (ct.startsWith('text/plain')) plain.push(part.body);
      else if (ct.startsWith('text/html')) html.push(part.body);
    }
    for (const child of part.parts || []) collectParts(child, plain, html);
  }

  function cap(text, maxBody) {
    const limit = maxBody > 0 ? maxBody : DEFAULT_MAX_BODY;
    return text.length > limit ? text.slice(0, limit) : text;
  }

  // True if a (non-decrypted) MIME tree is an OpenPGP/S-MIME encrypted message,
  // or carries an inline-PGP armored block. Signed-but-not-encrypted mail is NOT
  // treated as encrypted (its content is plaintext).
  function isEncrypted(part) {
    if (!part) return false;
    const ct = (part.contentType || '').toLowerCase();
    if (ct.indexOf('multipart/encrypted') !== -1) return true; // PGP/MIME
    if (ct.indexOf('application/pgp-encrypted') !== -1) return true;
    if (ct.indexOf('pkcs7-mime') !== -1) return true; // S/MIME (application/[x-]pkcs7-mime)
    if (
      ct.startsWith('text/') &&
      typeof part.body === 'string' &&
      part.body.indexOf('-----BEGIN PGP MESSAGE-----') !== -1
    ) {
      return true;
    }
    for (const child of part.parts || []) if (isEncrypted(child)) return true;
    return false;
  }

  // Remove quoted reply text from a plain-text body so a long thread doesn't
  // index the same content once per message. Drops '>'-quoted lines and truncates
  // at common attribution / "Original Message" markers (top-posting is the norm:
  // new text on top, quote below). If stripping would leave nothing (a quote-only
  // message, e.g. a bare forward), keep the original so we still index it.
  // Attribution opener ("On … wrote:") and its terminators, in several languages.
  // Tested against the current line joined with the next ~2, so the match still
  // fires when the client wrapped a long attribution across lines.
  const ATTR_OPENER = /^\s*(On|Am|Le|El)\b/i;
  const ATTR_TERMINATOR = /\b(wrote:|schrieb.*:|a écrit\s*:|escribió:)\s*$/i;
  // Outlook quote header block: a "From:" line followed shortly by a "Sent:"/
  // "Date:" line (localised). Requiring the pair keeps false-positives low.
  const OUTLOOK_FROM = /^\s*(From|Von|De)\s*:/i;
  const OUTLOOK_SENT = /^\s*(Sent|Date|Gesendet|Envoyé)\s*:/i;
  // "Forwarded message" banner, in two shapes: dash-delimited (Thunderbird, e.g.
  // "-------- Forwarded Message --------") and the Apple-Mail "Begin forwarded
  // message:" header — both localised (EN/DE/FR/ES).
  const FWD_DASHED = /^\s*-{2,}\s*(original message|forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado)\s*-{2,}/i;
  const FWD_BEGIN = /^\s*(begin forwarded message|anfang der weitergeleiteten nachricht|début du message transféré|inicio del mensaje reenviado)\s*:/i;

  function stripQuoted(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*>/.test(line)) continue; // quoted line
      if (FWD_DASHED.test(line) || FWD_BEGIN.test(line)) break;
      // Attribution line ("On … wrote:"), possibly wrapped onto the next 1-2
      // lines — join and test the combined string against the terminators.
      if (ATTR_OPENER.test(line)) {
        const joined = lines.slice(i, i + 3).join(' ');
        if (ATTR_TERMINATOR.test(line) || ATTR_TERMINATOR.test(joined)) break;
      }
      // Outlook header block: "From:" now, "Sent:"/"Date:" within the next 3.
      if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_SENT.test(l))) break;
      out.push(line);
    }
    const stripped = out.join('\n').trim();
    return stripped || text.trim();
  }

  // Bound the input to the (potentially quadratic) strip passes — see
  // MAX_EXTRACT_INPUT. Slicing by UTF-16 code unit can leave a lone high surrogate
  // at the cut; drop it so the text stays valid (same guard as previewOf).
  function capInput(s) {
    if (s.length <= MAX_EXTRACT_INPUT) return s;
    let p = s.slice(0, MAX_EXTRACT_INPUT);
    const last = p.charCodeAt(p.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) p = p.slice(0, -1);
    return p;
  }

  function extractText(full) {
    const plain = [];
    const html = [];
    collectParts(full, plain, html);
    let text = plain.join('\n').trim();
    if (text) return stripQuoted(capInput(text));
    // HTML-only body: <blockquote> quotes are dropped in stripHtml; run the same
    // line-based pass on the result to catch Outlook's header-block quotes (which
    // aren't blockquotes), since stripHtml now preserves block newlines.
    if (html.length) return stripQuoted(stripHtml(capInput(html.join('\n'))));
    return '';
  }

  // First PREVIEW_LEN chars of the body, without splitting a surrogate pair at
  // the cut (slicing by UTF-16 code unit can leave a lone high surrogate, which
  // renders as a broken character). Drop a dangling high surrogate.
  function previewOf(text) {
    let p = text.slice(0, PREVIEW_LEN);
    const last = p.charCodeAt(p.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) p = p.slice(0, -1);
    return p;
  }

  // headerMeta carries the already-resolved header fields (built on the main
  // thread, since they come off the MessageHeader object): id, headerMessageId,
  // subject, from, to, date (ms), folderName, hasAttachment, attachmentNames.
  function makeDoc(headerMeta, text, available, encrypted) {
    return {
      id: headerMeta.id,
      headerMessageId: headerMeta.headerMessageId || '',
      encrypted: !!encrypted,
      subject: headerMeta.subject || '',
      from: headerMeta.from || '',
      to: headerMeta.to || '',
      body: text,
      preview: previewOf(text),
      date: headerMeta.date || 0,
      folderName: headerMeta.folderName || '',
      accountId: headerMeta.accountId || '',
      bodyAvailable: available,
      hasAttachment: !!headerMeta.hasAttachment,
      attachmentNames: Array.isArray(headerMeta.attachmentNames) ? headerMeta.attachmentNames : [],
    };
  }

  // Build a doc from a NON-decrypted MIME tree. Returns { doc } normally, or
  // { needsDecrypt: true } when the message is encrypted and the caller opted to
  // index encrypted bodies — the decrypt read must happen on the main thread.
  function buildDoc(headerMeta, full, indexEncrypted, maxBody) {
    if (isEncrypted(full)) {
      if (!indexEncrypted) return { doc: makeDoc(headerMeta, '', false, true) };
      return { needsDecrypt: true };
    }
    const text = cap(extractText(full), maxBody);
    return { doc: makeDoc(headerMeta, text, text.length > 0, false) };
  }

  // Build a doc from an already-decrypted MIME tree (encrypted message, opted in).
  function buildDecryptedDoc(headerMeta, full, maxBody) {
    const text = cap(extractText(full), maxBody);
    return { doc: makeDoc(headerMeta, text, text.length > 0, true) };
  }

  globalThis.OmniExtract = {
    PREVIEW_LEN,
    DEFAULT_MAX_BODY,
    isEncrypted,
    extractText,
    makeDoc,
    buildDoc,
    buildDecryptedDoc,
  };
})();
