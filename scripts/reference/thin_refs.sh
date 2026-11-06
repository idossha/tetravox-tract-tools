#!/usr/bin/env bash
# A tenth of the real tractogram and its MRtrix references: what the hidden e2e drives by hand.
#   MRTRIX_BIN=<dir> scripts/reference/thin_refs.sh <out dir>
set -euo pipefail
OUT="${1:?usage: thin_refs.sh <out dir>}"
BIN="${MRTRIX_BIN:?set MRTRIX_BIN}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D=/Users/idohaber/datasets/000/derivatives
TCK="${TRACT_TOOLS_TCK:-$D/ti-toolbox/tract_validation/mrtrix_ref/tracks_ifod2_200k.tck}"
ASEG="${TRACT_TOOLS_ASEG:-$D/qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-aseg_dseg.nii.gz}"
WEIGHTS="${TRACT_TOOLS_WEIGHTS:-$D/ti-toolbox/tract_validation/mrtrix_ref/sift2_weights.txt}"
mkdir -p "$OUT"
n="$("$BIN/tckinfo" "$TCK" -count | awk '/actual count/{print $NF}')"
python3 -c "print(' '.join('1' if i % 10 == 0 else '0' for i in range($n)))" > "$OUT/every10.txt"
"$BIN/tckedit" -quiet -force "$TCK" "$OUT/thin.tck" -tck_weights_in "$OUT/every10.txt" -minweight 0.5
python3 - "$WEIGHTS" "$OUT/thin_weights.txt" <<'PY'
import sys
rows = [l for l in open(sys.argv[1]) if not l.startswith("#")]
w = " ".join(rows).split()
open(sys.argv[2], "w").write(" ".join(w[::10]) + "\n")
PY
TRACT_TOOLS_TCK="$OUT/thin.tck" TRACT_TOOLS_WEIGHTS="$OUT/thin_weights.txt" "$HERE/whole_refs.sh" "$OUT"
"$BIN/mrconvert" -quiet -force "$OUT/m10.mif" "$OUT/left_thalamus_mask.nii.gz" -datatype uint8
