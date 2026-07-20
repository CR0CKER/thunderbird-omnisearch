# Security & privacy of the OmniSearch index

A review of how indexed email is stored, how exposed it is, and the threat model.

## What is stored, and where

OmniSearch keeps its own search index in the extension's **IndexedDB**, which
Thunderbird writes — **unencrypted** — inside your profile directory, under
roughly:

```
<profile>/storage/default/moz-extension+++<extension-uuid>/idb/
```

The index contains, per message:

- **Stored verbatim** (recoverable as-is): `subject`, `from`, `to`, `date`,
  folder name, the message's RFC `Message-ID`, and a **~200-character preview**
  of the body.
- **Tokenized into the inverted index**: the full text of `subject`, `from`,
  `to`, and the body (capped by the *Indexed body length* setting — **default
  4,000 chars**, up to 20,000). The raw body is *not* stored verbatim, but the
  inverted index reveals the **set of words** each message contains (and the
  verbatim preview), which leaks a great deal of content.

There is no separate copy of attachments, and no body text beyond the preview is
stored verbatim.

## Is it more exposed than your original mail?

**For ordinary (unencrypted) mail: roughly the same exposure.** Thunderbird
already stores your messages unencrypted in the profile (mbox/maildir), and its
own **Gloda** database (`global-messages-db.sqlite`) already keeps a full-text
index of message bodies there. OmniSearch's index lives in the same profile with
the same file permissions, so it does not create a materially new at-rest
exposure for normal mail — it's a second index alongside one Thunderbird already
maintains.

**For OpenPGP / S-MIME encrypted mail: handled safely by default.** Encrypted
messages are stored as *ciphertext* at rest in your message store. Thunderbird's
body-reading APIs decrypt by default, which would write decrypted plaintext to
the index — so OmniSearch reads bodies with **`decrypt: false`** and **indexes
encrypted messages by header only** (subject/from/to/date). No decrypted content
of encrypted mail is written to disk unless you explicitly opt in via Settings →
*"Index the contents of encrypted emails"* (off by default). Results from
encrypted messages show an **"encrypted"** badge.

## Threat model — when could content be compromised?

- **Any process running as your user account** can read the IndexedDB files,
  just as it can read your mbox/maildir files and the Gloda database. The OS does
  not sandbox one of your apps from another's files. So local malware running as
  you can read the index — but it could already read your actual mail. The index
  is not a *new* capability for such malware, **except** that it exposes the
  decrypted content of encrypted messages (which the raw store does not).
- **Other Thunderbird extensions**: IndexedDB is origin-isolated per extension
  (keyed to this add-on's UUID), so another extension cannot read OmniSearch's
  database directly. (An extension granted `messagesRead` could read your mail
  itself anyway.)
- **Network / exfiltration**: OmniSearch requests **no host permissions and no
  network access** (`permissions`: `messagesRead`, `accountsRead`, `storage`,
  `unlimitedStorage` only). It cannot send your index anywhere. Everything stays
  on disk locally.
- **At rest / device theft**: the index is only as protected as the profile
  directory. Full-disk or encrypted-home protects the index and your mail
  equally; without it, both are readable from the raw disk.

## Recommendations

1. **Use full-disk or encrypted-home encryption.** It protects the index, your
   mail store, and Gloda together. This is the single biggest mitigation.
2. **Encrypted (GPG/S-MIME) mail is handled safely by default** — indexed by
   header only, with no decrypted plaintext on disk. Only enable *"Index the
   contents of encrypted emails"* if you accept that their decrypted text will
   then be stored unencrypted in the index.
3. **To purge the index, use Settings → *Clear index***, which deletes it from
   disk (IndexedDB) — including the decrypted contents of any encrypted emails you
   opted to index. Note that **removing the add-on** does not guarantee the
   IndexedDB is wiped immediately; as a belt-and-suspenders measure you can also
   delete the `moz-extension+++<uuid>` storage directory from the profile.

## Summary

For normal mail, the index is about as exposed as data Thunderbird already keeps
unencrypted (Gloda). It adds **no network exposure**. **Encrypted (OpenPGP/S-MIME)
mail is indexed by header only by default**, so its decrypted content is not
written to disk unless you opt in. Use full-disk encryption to protect everything
at rest.
