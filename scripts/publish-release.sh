#!/usr/bin/env bash
# Stage `dist/` as content-addressed release assets and print what the two catalogues need.
#
#   pnpm run build && scripts/publish-release.sh v0.1.0 [--upload]
#
# Every asset is uploaded **under its own sha256**, which is the layout Tetravox already uses for
# sample data (`scripts/sample-data/publish.sh`, "an asset's content is its name, so re-uploading can
# only ever be a no-op or a mistake") and what lets the app verify a download against its own URL. A
# human-named copy goes up beside it so a person reading the release page can tell what they are
# looking at; nothing reads it, and the app never fetches it.
#
# What it prints is not decoration: the `modules.lock` fragment is what Tetravox's release bundles,
# and the registry `versions[]` entry is what `idossha/tetravox-extensions` serves to File ▸
# Extensions…. Both carry the same hashes as the assets, and the app refuses any file whose bytes do
# not match.
set -euo pipefail

TAG="${1:?usage: publish-release.sh <tag> [--upload]}"
UPLOAD="${2:-}"
REPO="${TETRAVOX_TRACT_TOOLS_REPO:-idossha/tetravox-tract-tools}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES=(index.js manifest.json)
STAGE="$ROOT/.build/release"

rm -rf "$STAGE" && mkdir -p "$STAGE"
size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

entries=()
for name in "${FILES[@]}"; do
  src="$ROOT/dist/$name"
  sha="$(shasum -a 256 "$src" | cut -d' ' -f1)"
  bytes="$(size "$src")"
  cp "$src" "$STAGE/$sha"
  cp "$src" "$STAGE/$name"
  entries+=("$name $bytes $sha")
  echo "staged   $name  $bytes B  $sha"
done

if [ "$UPLOAD" = "--upload" ]; then
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 ||
    gh release create "$TAG" --repo "$REPO" --title "$TAG" --generate-notes
  for name in "${FILES[@]}"; do
    sha="$(shasum -a 256 "$ROOT/dist/$name" | cut -d' ' -f1)"
    gh release upload "$TAG" "$STAGE/$sha" --repo "$REPO" --clobber
    gh release upload "$TAG" "$STAGE/$name" --repo "$REPO" --clobber
  done
  echo "uploaded to https://github.com/$REPO/releases/tag/$TAG"
fi

node "$ROOT/scripts/print-fragments.mjs" "$TAG" "$REPO" "${entries[@]}"
