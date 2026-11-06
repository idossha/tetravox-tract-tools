#!/usr/bin/env bash
# Prove the comparator can fail: spoil one MRtrix reference at a time; every spoilt copy must come back red.
#   mutate_check.sh <export dir> <refs dir>   (the export must hold the files each row names)
set -uo pipefail
EXPORT="${1:?usage: mutate_check.sh <export dir> <refs dir>}"
REFS="${2:?usage: mutate_check.sh <export dir> <refs dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${TRACT_TOOLS_PYTHON:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
bad=0
spoil() { # label, file, python expression turning the text `t` into the spoilt text
  local label="$1" file="$2" code="$3"
  rm -rf "$WORK/r" && mkdir "$WORK/r"
  for f in "$REFS"/*; do ln -s "$f" "$WORK/r/"; done
  rm "$WORK/r/$file"
  "$PYTHON" -c "t=open('$REFS/$file').read(); open('$WORK/r/$file','w').write($code)"
  if out="$("$PYTHON" "$HERE/compare_export.py" "$EXPORT" "$WORK/r")"; then
    echo "NOT CAUGHT $label"; bad=1
  else
    echo "caught     $label: $(printf '%s\n' "$out" | grep '^MISS' | head -1 | cut -c1-110)"
  fi
}
[ -f "$EXPORT/connectome_count.csv" ] && {
  spoil "one count in the matrix" con_radial4.csv "t.replace(',27699,',',27700,',1) if ',27699,' in t else __import__('re').sub(r'(\n0,)(\d+)',lambda m:m.group(1)+str(int(m.group(2))+1),t,1)"
  spoil "one mean length" con_length.csv "__import__('re').sub(r'(\n0,)([0-9.]+)',lambda m:m.group(1)+str(float(m.group(2))*1.01+1),t,1)"
  spoil "one FA matrix cell" con_fa.csv "__import__('re').sub(r'(\n0,)([0-9.]+)',lambda m:m.group(1)+str(float(m.group(2))*1.01+1),t,1)"
  spoil "one assignment" as_radial4.txt "(lambda L:'\n'.join(L[:-3]+['1 1']+L[-2:]))(t.split('\n'))"
  spoil "one streamline length" lengths.txt "(lambda L:'\n'.join(['999.0']+L[1:]))(t.split('\n'))" 
  spoil "one FA value" fa_mean.txt "__import__('re').sub(r'\n([0-9.e-]+) ',lambda m:'\n0.99 ',t,1)"
}
for name in inc_10 combo exc_ends_16; do
  [ -f "$EXPORT/streamlines.csv" ] && [ -f "$EXPORT/$name.tck" ] &&
    spoil "one kept streamline in $name" "$name.ids.txt" "'\n'.join(t.split('\n')[1:])"
done
[ -f "$EXPORT/both_16.tck" ] && spoil "a self-pair" as_end.txt "(lambda L:'\n'.join(L))([l.replace('16 16','16 15',1) for l in t.split('\n')])"
echo "${bad/#0/all caught}"
exit "$bad"
