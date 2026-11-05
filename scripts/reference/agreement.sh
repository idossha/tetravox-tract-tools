#!/usr/bin/env bash
# All references, all streamlines. Usage: agreement.sh [mx dir] (or MX=...); MRTRIX_BIN adds the tckedit round trip.
set -euo pipefail
MX="${1:-${MX:?usage: agreement.sh <dir with sub2k.tck, fa.tsf and ref/>}}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
python3 "$(dirname "$0")/export_refs.py" "$MX" "$OUT"
TRACT_TOOLS_REFS="$OUT" pnpm exec vitest run test/agreement.test.ts --disable-console-intercept
if [ -n "${MRTRIX_BIN:-}" ]; then
  "$MRTRIX_BIN/tckedit" -quiet -force "$MX/sub2k.tck" "$OUT/rt.tck" -tck_weights_in "$OUT/ours_inc_AB.txt" -minweight 0.5
  echo "round trip through tckedit -tck_weights_in: $("$MRTRIX_BIN/tckinfo" "$OUT/rt.tck" -count | awk '/actual count/{print $NF}') kept (ref inc_AB: $(wc -w < "$MX/ref/inc_AB.sel.txt"))"
fi
