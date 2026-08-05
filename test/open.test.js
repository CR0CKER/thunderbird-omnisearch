'use strict';
// Tests for lib/open.js — resolving a search result back to the live message.
//
// Run with the system node (no dependencies, no install):
//     node --test test/
//
// Why these tests exist: the index stores each message's numeric Thunderbird id,
// but that id is "an internal tracking number that does not remain after a
// restart" and "does not follow an email that has been moved to a different
// folder" (Thunderbird WebExtension MessageHeader docs). After a restart the
// tracker hands the same numbers out to *different* messages, so a stored id
// silently addresses the wrong mail — opening succeeds, on the wrong message.
// The RFC Message-ID is the stable identity, and these tests pin that contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPEN_JS = path.join(__dirname, '..', 'lib', 'open.js');
const source = fs.readFileSync(OPEN_JS, 'utf8');

// lib/open.js is an IIFE that assigns globalThis.OmniOpen and calls the global
// `messenger`. Running it in a vm context lets us inject a fake Thunderbird and
// read the module out, with no bundler and no module system to fight.
function loadOmniOpen(messenger) {
  const errors = [];
  const sandbox = { messenger, console: { error: (...a) => errors.push(a) } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: OPEN_JS });
  return { OmniOpen: sandbox.OmniOpen, errors };
}

// A fake Thunderbird holding `messages` keyed by their CURRENT numeric id.
// `opened` records every id that messageDisplay.open() was asked for, which is
// what lets a test assert *which* message the user would actually have seen.
function fakeMessenger(messages) {
  const opened = [];
  return {
    opened,
    messages: {
      async get(id) {
        const m = messages.get(id);
        if (!m) throw new Error('no message with id ' + id);
        return m;
      },
      async query({ headerMessageId }) {
        const hits = [...messages.values()].filter((m) => m.headerMessageId === headerMessageId);
        return { messages: hits };
      },
    },
    messageDisplay: {
      async open({ messageId }) {
        if (!messages.has(messageId)) throw new Error('no message with id ' + messageId);
        opened.push(messageId);
      },
    },
    mailTabs: {
      async query() {
        return [{ id: 1 }];
      },
      async setSelectedMessages(_tabId, ids) {
        opened.push(...ids);
      },
    },
  };
}

// The state after a Thunderbird restart: the id the index recorded for the
// user's target mail (7) has been reassigned to a completely different message,
// and the target now lives under a different number (42).
function afterRestart() {
  return new Map([
    [7, { id: 7, headerMessageId: '<unrelated@example.com>', subject: 'Lunch tomorrow?' }],
    [42, { id: 42, headerMessageId: '<target@example.com>', subject: 'Q3 contract' }],
  ]);
}

test('opens the message whose Message-ID matches, not whatever now holds the stored id', async () => {
  const tb = fakeMessenger(afterRestart());
  const { OmniOpen } = loadOmniOpen(tb);

  // The search result as the index recorded it before the restart.
  await OmniOpen.openMessage({ id: '7', headerMessageId: '<target@example.com>' });

  assert.deepEqual(tb.opened, [42], 'must open the Q3 contract (id 42), never the unrelated id-7 message');
});

test('opens by the stored id when it still points at the same message', async () => {
  const messages = new Map([
    [7, { id: 7, headerMessageId: '<target@example.com>', subject: 'Q3 contract' }],
  ]);
  const tb = fakeMessenger(messages);
  const { OmniOpen } = loadOmniOpen(tb);

  await OmniOpen.openMessage({ id: '7', headerMessageId: '<target@example.com>' });

  assert.deepEqual(tb.opened, [7]);
});

test('re-resolves when the stored id no longer exists at all', async () => {
  const messages = new Map([
    [42, { id: 42, headerMessageId: '<target@example.com>', subject: 'Q3 contract' }],
  ]);
  const tb = fakeMessenger(messages);
  const { OmniOpen } = loadOmniOpen(tb);

  await OmniOpen.openMessage({ id: '7', headerMessageId: '<target@example.com>' });

  assert.deepEqual(tb.opened, [42]);
});

test('falls back to the stored id when the result carries no Message-ID', async () => {
  // Messages with no RFC Message-ID are never deduplicated and have no stable
  // identity — the stored id is genuinely all we have, so we still use it.
  const messages = new Map([[7, { id: 7, headerMessageId: '', subject: 'Draft' }]]);
  const tb = fakeMessenger(messages);
  const { OmniOpen } = loadOmniOpen(tb);

  await OmniOpen.openMessage({ id: '7', headerMessageId: '' });

  assert.deepEqual(tb.opened, [7]);
});

test('opens nothing and logs when the message cannot be found by either route', async () => {
  const tb = fakeMessenger(new Map());
  const { OmniOpen, errors } = loadOmniOpen(tb);

  await OmniOpen.openMessage({ id: '7', headerMessageId: '<gone@example.com>' });

  assert.deepEqual(tb.opened, [], 'must not open an arbitrary message as a consolation prize');
  assert.equal(errors.length, 1, 'the failure must be reported, not silent');
});

test('picks the copy in the expected account when a Message-ID appears in two accounts', async () => {
  // The same RFC Message-ID can legitimately exist in two different accounts
  // (the user is on both sides of a thread). The index dedups per account, so a
  // result must reopen in the account it was indexed from.
  const messages = new Map([
    [11, { id: 11, headerMessageId: '<shared@example.com>', folder: { accountId: 'account-A' } }],
    [22, { id: 22, headerMessageId: '<shared@example.com>', folder: { accountId: 'account-B' } }],
  ]);
  const tb = fakeMessenger(messages);
  const { OmniOpen } = loadOmniOpen(tb);

  await OmniOpen.openMessage({ id: '99', headerMessageId: '<shared@example.com>', accountId: 'account-B' });

  assert.deepEqual(tb.opened, [22]);
});

test('uses the mail-tab fallback when messageDisplay.open is unavailable', async () => {
  const messages = new Map([
    [42, { id: 42, headerMessageId: '<target@example.com>', subject: 'Q3 contract' }],
  ]);
  const tb = fakeMessenger(messages);
  tb.messageDisplay.open = async () => {
    throw new Error('messageDisplay.open not supported on this build');
  };
  const { OmniOpen } = loadOmniOpen(tb);

  await OmniOpen.openMessage({ id: '7', headerMessageId: '<target@example.com>' });

  assert.deepEqual(tb.opened, [42], 'the fallback must still open the correctly-resolved message');
});
