#!/usr/bin/env bash
# Package the extension into thunderbird-omnisearch-<version>.xpi.
# No compilation needed — the extension is plain JS, loadable as-is. This only
# zips the loadable files for distribution. Run from the project root.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(grep -oE '"version"[^,]*' manifest.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
XPI="thunderbird-omnisearch-${VERSION}.xpi"

rm -f thunderbird-omnisearch-*.xpi

zip -r -q -X "$XPI" \
  manifest.json \
  background.js \
  lib \
  ui \
  options \
  icons \
  README.md \
  LICENSE \
  -x "*.DS_Store" "*.map" "icons/omnisearch-128.png" "lib/VENDOR.md"

echo "Built $XPI"
