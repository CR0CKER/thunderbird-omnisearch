# Vendored dependencies

This extension has **no build or install step** — it ships plain JS. Its one
runtime library is vendored (committed to the repo) and loaded via
`importScripts`, not installed from npm.

## `minisearch.js`

| | |
|---|---|
| **Library** | MiniSearch |
| **Version** | 7.2.0 |
| **Upstream** | <https://github.com/lucaong/minisearch> |
| **Build** | UMD bundle (defines `globalThis.MiniSearch`) |
| **License** | MIT |
| **SHA-256** | `6e1ae32ced7228cfab9d20552573fb3ef5a91ddb41e4950a5e927a515dd28e93` |

MiniSearch tokenizes **attacker-controlled email text**, so keeping it current
matters. It is pinned in [`../package.json`](../package.json) purely so GitHub's
dependency graph, Dependabot, and `osv-scanner` (CI) surface any advisory against
it — nothing is ever `npm install`ed at runtime.

### Verifying the vendored copy

```sh
sha256sum lib/minisearch.js
# must match the SHA-256 above
```

### Re-vendoring (version bump)

1. Bump the pin in `package.json` **and** the Version + SHA-256 here, in the same commit.
2. Download the matching UMD build from the upstream release (`dist/umd/index.js`)
   over HTTPS and verify its checksum before replacing `lib/minisearch.js`.
3. Keep the two-line provenance banner at the top of `lib/minisearch.js`.
4. Re-run the CI gates (`node --check`, `osv-scanner`) and smoke-test search in
   Thunderbird — a MiniSearch major can change the serialized index shape
   (`lib/engine.js` `toData`/`deserialize`).
