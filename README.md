# OmniSearch for Thunderbird

[![CI](https://github.com/CR0CKER/thunderbird-omnisearch/actions/workflows/ci.yml/badge.svg)](https://github.com/CR0CKER/thunderbird-omnisearch/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/CR0CKER/thunderbird-omnisearch)](https://github.com/CR0CKER/thunderbird-omnisearch/releases)
[![License: MIT](https://img.shields.io/github/license/CR0CKER/thunderbird-omnisearch)](LICENSE)

A fast, forgiving search for your email. Start typing and OmniSearch shows the
most relevant messages right away — even if you misspell a word or only remember
part of it.

It keeps its own search index instead of relying on Thunderbird's built-in
search (Gloda), which often fails to find messages that are clearly there,
including mail you sent yourself. OmniSearch builds a separate index, keeps it up
to date as your mail changes, and can check and repair itself so messages do not
quietly go missing from search.

## What it does

**Finds the right email quickly**

- Ranks the most relevant messages first, and gives extra weight to matches in
  the subject, sender, and recipient over matches deep in the body.
- Strongly favours recent mail: of two comparable matches the newer one comes
  first, and the preference stays noticeable for about a year before fading out.
  Where you matched still counts for more — a years-old email with your search
  word in its *subject* stays above one from today that only mentions it in
  passing in the body.
- Tolerates typos, so "reciept" still finds "receipt".
- Searches as you type, matching partial words ("invo" finds "invoice").
- Searches mail that Thunderbird's own search misses.

**Cleaner results**

- Ignores quoted replies when indexing, so a long back-and-forth thread does not
  flood your results with the same text repeated in every reply. The original
  message is still findable. This works with the common reply and forward styles
  from Gmail, Apple Mail, Outlook, and Thunderbird, including German, French, and
  Spanish wording.
- Shows each Gmail or IMAP message once, even when it appears in several places
  at once (for example both All Mail and Inbox). The result lists every folder
  the message lives in, such as "Inbox, All Mail".
- Each result shows the sender, date, folder(s), and a short preview. A small
  label marks messages indexed by header only (body not downloaded yet) or
  encrypted.

**Two ways to search** (choose one in Settings)

- Centered window (the default): a search box that opens in the middle of the
  screen and grows as results come in. Press Esc to close it.
- Toolbar popup: a small search panel that drops down from the toolbar button.

Either one opens from the toolbar button or the Alt+S keyboard shortcut. You can
work entirely from the keyboard: type your search, press Tab or the Down arrow to
jump into the results, move through them with the arrow keys, press Enter to open
the selected message, and press Esc to clear the box. Opening a result jumps to
that message in Thunderbird, and the search window closes unless you choose to
keep it open.

**Stays up to date on its own**

- Updates the index automatically as mail arrives or is moved, copied, edited, or
  deleted.
- "Verify and repair" re-checks every folder against the index, removing stale
  entries and adding anything missing, so a message can never stay permanently
  hidden from search.
- The index is saved to disk, so it is ready almost instantly after you restart
  Thunderbird rather than being rebuilt every time.

**Private by design**

- No internet access at all. OmniSearch has no network permissions, so your mail
  and your search index never leave your computer.
- Encrypted email (OpenPGP and S/MIME) is indexed by subject and sender only by
  default. The decrypted contents are never written to disk unless you
  deliberately turn that on. See [SECURITY.md](SECURITY.md) for the details.

## Installing

There is no build step — the extension is plain JavaScript. To make the
installable file, run `./build.sh` (it needs the `zip` tool), which produces a
`.xpi` file. To install it for personal use: in Thunderbird's `about:config`, set
`xpinstall.signatures.required` to `false`, then install the `.xpi` through
Add-ons Manager, gear icon, "Install Add-on From File". 

After installing, click the magnifier button in the toolbar (or press Alt+S) to
open search. The first time, it builds the index in the background. The Alt+S
shortcut is set up automatically; you can change it under Add-ons Manager, gear
icon, "Manage Extension Shortcuts".

## What gets indexed

- Junk (Spam) and Trash are left out by default. Every other folder of every
  included account is indexed. You can opt Junk and Trash back in under Settings.
- Encrypted messages are indexed by subject and sender only by default, so no
  decrypted text is written to the index. You can opt in to index their contents.
- For IMAP accounts, a message body has to be downloaded to your computer before
  it can be indexed. Thunderbird downloads IMAP bodies "on demand" by default, so
  messages you have not opened yet are indexed by header only and shown with a
  "header-only" label. To make every IMAP body searchable, go to Account
  Settings, then Synchronization & Storage, turn on keeping messages on this
  computer, synchronize all messages (do this per folder; subfolders are not
  automatic), then rebuild the index.

## Settings

Open settings from the gear icon in the search window, or from Add-ons Manager,
OmniSearch, gear icon, Options.

| Setting | Default | What it does |
|---|---|---|
| Search interface | Centered window | Choose the centered, Spotlight-style window or the toolbar popup. |
| Keep the search popup open after opening a result | Off | Leaves the search window open instead of closing it when you open a message. |
| Keep the search index loaded for instant results | Off | Holds the index in memory so reopening search is instant. Uses a little more memory and battery in the background. |
| Accounts to index | All included | Turn individual accounts on or off. New accounts are included automatically. |
| Include Junk (Spam) and Trash folders | Off | Adds those folders to search. |
| Index the contents of encrypted emails | Off | Indexes the decrypted bodies of OpenPGP/S-MIME mail. Their text is then stored unencrypted in the index. |
| Indexed body length per email | 4,000 characters | How much of each email's body is searchable. Smaller keeps the index lighter and faster to load; larger makes more of long emails searchable. Changing it needs a rebuild. |
| Rebuild index | — | Re-indexes all of your mail from scratch. |
| Verify and repair | — | Checks the index against your folders and fixes any differences. |

### Applying changes without a full rebuild

When you change which accounts are indexed, or toggle Junk and Trash, an "Apply
now" banner appears. Applying only adds the newly included messages and removes
the newly excluded ones, which is much faster than a full rebuild. The one
exception is the "index encrypted bodies" option: because it changes how messages
are read, its banner offers a full rebuild instead.

## Your privacy and security

The search index is stored unencrypted inside your Thunderbird profile, similar
to the full-text index Thunderbird already keeps for its own search. For ordinary
mail, this is roughly the same exposure as the messages Thunderbird already stores
on your computer. Encrypted mail is indexed by header only unless you opt in. The
add-on has no internet access, so nothing can be sent anywhere. For the best
protection of data at rest, use full-disk encryption. The full threat model and
the reasoning behind these choices are in [SECURITY.md](SECURITY.md).

## Under the hood

OmniSearch is built on [MiniSearch](https://github.com/lucaong/minisearch), the
same search engine used by the [Obsidian OmniSearch](https://github.com/scambier/obsidian-omnisearch)
plugin. To keep Thunderbird responsive on large mailboxes, the heavy work — the
search index itself, saving and loading it, and extracting text from messages —
runs in background worker threads, so the main Thunderbird window never freezes
while indexing or searching. The index is saved in a compact form that loads
quickly even for very large mailboxes.

## License

MIT. Includes MiniSearch (MIT). It does not reuse the GPL-3 code of Obsidian
OmniSearch — only the same underlying engine and general approach.
