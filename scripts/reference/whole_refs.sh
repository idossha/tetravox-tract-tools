#!/usr/bin/env bash
# MRtrix's answers over the whole tractogram, on the real atlas: the expected values for every agreement check.
#   MRTRIX_BIN=<dir with tckedit> scripts/reference/whole_refs.sh <out dir>
# TRACT_TOOLS_TCK, _ASEG, _FA and _WEIGHTS override the inputs. Nothing is written beside them.
set -euo pipefail
OUT="${1:?usage: whole_refs.sh <out dir>}"
BIN="${MRTRIX_BIN:?set MRTRIX_BIN to a directory holding the MRtrix3 3.0.8 binaries}"
D=/Users/idohaber/datasets/000/derivatives
TCK="${TRACT_TOOLS_TCK:-$D/ti-toolbox/tract_validation/mrtrix_ref/tracks_ifod2_200k.tck}"
ASEG="${TRACT_TOOLS_ASEG:-$D/qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-aseg_dseg.nii.gz}"
FA="${TRACT_TOOLS_FA:-$D/ti-toolbox/tract_validation/mrtrix_ref/fa.nii.gz}"
WEIGHTS="${TRACT_TOOLS_WEIGHTS:-$D/ti-toolbox/tract_validation/mrtrix_ref/sift2_weights.txt}"
mkdir -p "$OUT"
cd "$OUT"
q=(-quiet -force)
"$BIN/mrinfo" -version | head -1 > version.txt

n="$("$BIN/tckinfo" "$TCK" -count | awk '/actual count/{print $NF}')"
python3 -c "print(' '.join(str(i) for i in range($n)))" > index.txt
echo "$n" > count.txt

# Regions: left thalamus, left cortex, right thalamus, brain stem. Kept streamlines are named by carrying
# their file index through -tck_weights_in/-tck_weights_out, so nobody has to match geometry.
for id in 10 3 49 16; do "$BIN/mrcalc" "${q[@]}" "$ASEG" "$id" -eq "m$id.mif"; done
edit() { # name, tckedit arguments
  local name="$1"; shift
  "$BIN/tckedit" "${q[@]}" "$TCK" "$name.tck" -tck_weights_in index.txt -tck_weights_out "$name.sel.txt" "$@"
  tr -s ' \n' '\n' < "$name.sel.txt" | grep -v '^#' | grep -v '^$' | awk '{printf "%d\n",$1}' > "$name.ids.txt"
}
edit inc_10 -include m10.mif
edit inc_10_3 -include m10.mif -include m3.mif
edit inc_10_exc_49 -include m10.mif -exclude m49.mif
edit ends_10 -include m10.mif -ends_only
edit ends_10_16 -include m10.mif -include m16.mif -ends_only
edit exc_ends_16 -exclude m16.mif -ends_only
edit sph -include 0,0,10,12
edit sph_exc -include 0,0,10,12 -exclude 20,0,10,8
edit len -minlength 40 -maxlength 180
edit combo -include m10.mif -exclude m49.mif -minlength 40 -maxlength 180

C=(-quiet -force "$TCK" "$ASEG")
"$BIN/tck2connectome" "${C[@]}" con_radial4.csv -assignment_radial_search 4 -out_assignments as_radial4.txt
"$BIN/tck2connectome" "${C[@]}" con_radial4_sym.csv -assignment_radial_search 4 -symmetric
"$BIN/tck2connectome" "${C[@]}" con_end.csv -assignment_end_voxels -out_assignments as_end.txt
"$BIN/tck2connectome" "${C[@]}" con_weight.csv -assignment_radial_search 4 -tck_weights_in "$WEIGHTS"
"$BIN/tck2connectome" "${C[@]}" con_length.csv -assignment_radial_search 4 -scale_length -stat_edge mean
"$BIN/tcksample" "${q[@]}" "$TCK" "$FA" fa_mean.txt -stat_tck mean
"$BIN/tcksample" "${q[@]}" "$TCK" "$FA" fa.tsf
"$BIN/tck2connectome" "${C[@]}" con_fa.csv -assignment_radial_search 4 -scale_file fa_mean.txt -stat_edge mean
"$BIN/tckstats" "${q[@]}" "$TCK" -dump lengths.txt > /dev/null
grep -v "^#" "$WEIGHTS" | tr -s " " "\n" | grep -v "^$" > weights.txt
echo "references in $OUT"
