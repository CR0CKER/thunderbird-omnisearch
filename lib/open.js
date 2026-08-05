'use strict';
// Opening a search result. Split out of background.js so the id-resolution
// logic is unit-testable without a running Thunderbird (test/open.test.js
// drives it with a fake `messenger`). Exposes globalThis.OmniOpen.
//
// The identity problem this file exists to solve: an index doc stores the
// message's numeric Thunderbird id, but per the WebExtension docs that id is
// "an internal tracking number that does not remain after a restart" and it
// "does not follow an email that has been moved to a different folder". The
// tracker reissues those numbers each session, so a stored id doesn't merely go
// dead — it silently starts addressing a DIFFERENT message. Opening it then
// succeeds and shows the user unrelated mail. The RFC Message-ID
// (headerMessageId) is the stable identity, so it — not the numeric id — is the
// authority here. The numeric id is treated as a cache hint that must be
// validated before use.
(function () {
  // Resolve a search result to the numeric id of the message it actually refers
  // to *right now*, or null if that message can't be found. Every id returned
  // has been confirmed to exist in this session.
  async function resolveMessageId(msg) {
    const expected = msg.headerMessageId || '';
    const cached = Number(msg.id);
    const hasCached = Number.isFinite(cached);

    // No RFC Message-ID (rare, but legal mail). There is no stable identity to
    // check against, so the cached id is genuinely all we have — confirm it at
    // least still resolves to something rather than opening blind.
    if (!expected) {
      if (!hasCached) return null;
      try {
        await messenger.messages.get(cached);
        return cached;
      } catch (e) {
        return null;
      }
    }

    // Fast path: the cached id is usually still correct (no restart since
    // indexing), so verify it rather than paying for a query on every open.
    // The Message-ID comparison is what makes this safe — a reissued id fails
    // it and falls through to the authoritative lookup below.
    if (hasCached) {
      try {
        const header = await messenger.messages.get(cached);
        if (header && header.headerMessageId === expected) return cached;
      } catch (e) {
        // Id no longer valid at all — re-resolve below.
      }
    }

    // Authoritative lookup by the stable Message-ID.
    try {
      const q = await messenger.messages.query({ headerMessageId: expected });
      const list = (q && q.messages) || [];
      if (!list.length) return null;
      // The same Message-ID can exist in more than one account (the user is on
      // both sides of a thread), and search dedups per account — so reopen the
      // copy from the account the result was indexed from. Falling back to the
      // first hit keeps pre-0.5.2 index entries (no accountId) working.
      if (msg.accountId) {
        const sameAccount = list.find((m) => m.folder && m.folder.accountId === msg.accountId);
        if (sameAccount) return sameAccount.id;
      }
      return list[0].id;
    } catch (e) {
      console.error('[OmniSearch] could not re-resolve message:', e);
      return null;
    }
  }

  // Display a message by numeric id, falling back to selecting it in the active
  // mail tab on builds where messageDisplay.open is unavailable.
  async function tryOpen(id) {
    if (!Number.isFinite(id)) return false;
    try {
      await messenger.messageDisplay.open({ messageId: id, location: 'tab' });
      return true;
    } catch (e) {
      try {
        const [tab] = await messenger.mailTabs.query({ active: true, currentWindow: true });
        if (!tab) return false;
        await messenger.mailTabs.setSelectedMessages(tab.id, [id]);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // Open a search result. Resolution happens first and always: we never open a
  // stored id we haven't confirmed still points at the same message.
  async function openMessage(msg) {
    const id = await resolveMessageId(msg);
    if (id == null) {
      console.error('[OmniSearch] could not find message', msg.id, msg.headerMessageId);
      return;
    }
    if (!(await tryOpen(id))) {
      console.error('[OmniSearch] could not open message', id, msg.headerMessageId);
    }
  }

  globalThis.OmniOpen = { resolveMessageId, tryOpen, openMessage };
})();
