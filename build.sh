#!/usr/bin/env bash
# Package the extension into a .xpi. No compilation needed — the extension is
# plain JS, loadable as-is; this only zips the loadable files. Run from the
# project root.
#
#   ./build.sh              development build, filename stamped with the branch
#                           and commit it came from
#   ./build.sh --release    clean thunderbird-omnisearch-<version>.xpi, the name
#                           attached to GitHub releases and uploaded to ATN
#
# Why the stamp: the built .xpi is whatever branch happened to be checked out at
# the time, and a stale one looks identical to a fresh one. That cost real
# debugging once — a fix was "tested" against a build that predated it. The
# stamp makes the mismatch visible in the filename and in Thunderbird's add-on
# list. It degrades to the clean name outside a git checkout, so building from a
# source archive (as an ATN reviewer does) still works.
set -euo pipefail

cd "$(dirname "$0")"

RELEASE=""
case "${1:-}" in
  --release) RELEASE=1 ;;
  "") ;;
  *) echo "usage: $0 [--release]" >&2; exit 2 ;;
esac

VERSION=$(grep -oE '"version"[^,]*' manifest.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

STAMP=""
if [ -z "$RELEASE" ] && git rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)
  SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  # Uncommitted changes mean the build matches no commit at all — say so.
  DIRTY=""
  git diff --quiet HEAD -- 2>/dev/null || DIRTY="-dirty"
  # Slashes are common in branch names and illegal-ish in filenames.
  SAFE_BRANCH=$(printf '%s' "$BRANCH" | tr '/' '-' | tr -cd 'A-Za-z0-9._-')
  STAMP="+${SAFE_BRANCH}-${SHA}${DIRTY}"
fi

XPI="thunderbird-omnisearch-${VERSION}${STAMP}.xpi"

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
if [ -n "$STAMP" ]; then
  echo "  development build — run './build.sh --release' for the release artifact"
fi
