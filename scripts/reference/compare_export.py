"""Compare a Tract tools export with what MRtrix wrote, over every streamline. Prints one row per check; exit 1 on a miss.

  compare_export.py <export dir> <reference dir from whole_refs.sh> [--mrtrix-bin DIR]

The export may hold any subset: a check needs its files. numpy reads both sides; no TypeScript is involved.
Tolerances, and what each absorbs:
  counts, membership, assignments, point coordinates: exact.
  length per streamline: 0.0015 mm + 1e-5 relative, for tckstats -dump's 6 significant digits.
  FA per streamline: 1e-5 relative + 1e-6, for tcksample's 10 printed digits and float32 sampling.
  length, FA and weight matrices: 2e-3 relative + 1e-3, for tck2connectome's float32 accumulation, printed in 6 to 10 digits.
"""
import csv
import subprocess
import sys
from pathlib import Path

import numpy as np

rows = []


def row(name, n, measure, ok, limit="0"):
    rows.append((name, n, measure, limit, "ok" if ok else "MISS"))


def matrix(path):
    return np.loadtxt(path, delimiter=",", comments="#")


def table(path):
    return np.loadtxt(path, comments="#", ndmin=2)


def ids(path):
    return np.array(path.read_text().split(), dtype=np.int64) if path.exists() else None


def tck(path):
    raw = path.read_bytes()
    head = raw[: raw.index(b"\nEND\n")].decode("latin1")
    offset = next(int(l.split()[2]) for l in head.splitlines() if l.startswith("file:"))
    count = next(int(l.split()[1]) for l in head.splitlines() if l.startswith("count:"))
    return count, np.frombuffer(raw, "<f4", offset=offset)


def compare_tracks(ours, theirs, bin_dir):
    n_ours, a = tck(ours)
    n_theirs, b = tck(theirs)
    same = n_ours == n_theirs and a.shape == b.shape and np.array_equal(a, b, equal_nan=True)
    row(f"{ours.stem}.tck points against tckedit", n_theirs, f"count {n_ours} vs {n_theirs}, {a.size // 3} triples", same)
    if bin_dir is not None:
        out = subprocess.run([f"{bin_dir}/tckinfo", str(ours), "-count"], capture_output=True, text=True)
        actual = next((l.split()[-1] for l in out.stdout.splitlines() if "actual count" in l), "?")
        row(f"{ours.stem}.tck through tckinfo", n_theirs, f"actual count {actual}", out.returncode == 0 and actual == str(n_theirs))


def main() -> int:
    export, ref = Path(sys.argv[1]), Path(sys.argv[2])
    bin_dir = sys.argv[sys.argv.index("--mrtrix-bin") + 1] if "--mrtrix-bin" in sys.argv else None
    n = int((ref / "count.txt").read_text())
    radial = table(ref / "as_radial4.txt").astype(np.int64)
    end = table(ref / "as_end.txt").astype(np.int64)
    rows_csv = None
    if (export / "streamlines.csv").exists():
        with open(export / "streamlines.csv") as f:
            reader = csv.DictReader(f)
            rows_csv = {k: [] for k in reader.fieldnames}
            for r in reader:
                for k in reader.fieldnames:
                    rows_csv[k].append(r[k])

    for name, ref_name, exact, limit in [
        ("connectome_count.csv", "con_radial4.csv", True, "0"),
        ("connectome_end.csv", "con_end.csv", True, "0"),
        ("connectome_count_sym.csv", "con_radial4_sym.csv", True, "0"),
        ("connectome_length.csv", "con_length.csv", False, "2e-3 rel + 1e-3"),
        ("connectome_weight.csv", "con_weight.csv", False, "2e-3 rel + 1e-3"),
        ("connectome_fa.csv", "con_fa.csv", False, "2e-3 rel + 1e-3"),
    ]:
        if not (export / name).exists():
            continue
        a, b = matrix(export / name), matrix(ref / ref_name)
        shape = a.shape == b.shape
        d = np.abs(a - b) if shape else np.array([np.inf])
        if exact:
            row(f"{name} against {ref_name}", int(b.sum()), f"sum|diff| {d.sum():g}, shape {a.shape}", shape and d.sum() == 0)
        else:
            worst = float((d / (2e-3 * np.abs(b) + 1e-3)).max())
            row(f"{name} against {ref_name}", int((b != 0).sum()), f"max|diff| {d.max():.3g}, sum|diff| {d.sum():.3g}", shape and worst <= 1, limit)

    if (export / "edges.csv").exists() and (export / "connectome_count.csv").exists():
        with open(export / "edges.csv") as f:
            edges = list(csv.DictReader(f))
        con = matrix(ref / "con_radial4.csv")
        from_edges = np.zeros_like(con)
        for e in edges:
            from_edges[int(e["id_a"]) - 1, int(e["id_b"]) - 1] = int(e["n"])
        row("edges.csv n against con_radial4.csv", len(edges), f"sum|diff| {np.abs(from_edges - con).sum():g}", np.abs(from_edges - con).sum() == 0)
        length = matrix(ref / "con_length.csv")
        worst = max(abs(float(e["length_mean_mm"]) - length[int(e["id_a"]) - 1, int(e["id_b"]) - 1]) / (2e-3 * length[int(e["id_a"]) - 1, int(e["id_b"]) - 1] + 1e-3) for e in edges)
        row("edges.csv length_mean_mm against con_length.csv", len(edges), f"worst/limit {worst:.3g}", worst <= 1, "2e-3 rel + 1e-3")
        # Every per-streamline length from tckstats, grouped by MRtrix's own assignments.
        lengths = np.loadtxt(ref / "lengths.txt", comments="#").ravel()
        off = 0
        for e in edges:
            a, b = int(e["id_a"]), int(e["id_b"])
            own = lengths[((radial[:, 0] == a) & (radial[:, 1] == b)) | ((radial[:, 0] == b) & (radial[:, 1] == a))]
            off = max(off, abs(float(e["length_median_mm"]) - np.median(own)), abs(float(e["length_min_mm"]) - own.min()), abs(float(e["length_max_mm"]) - own.max()))
        row("edges.csv length median, min, max against tckstats grouped by assignments", len(edges), f"max|diff| {off:.3g} mm", off <= 0.01, "0.01 mm (6 printed digits of a sum)")

    if (export / "nodes.csv").exists():
        with open(export / "nodes.csv") as f:
            nodes = list(csv.DictReader(f))
        con = matrix(ref / "con_radial4_sym.csv")
        off = con.copy()
        np.fill_diagonal(off, 0)
        bad = sum(int(x["degree"]) != int((off[int(x["id"]) - 1] > 0).sum()) or int(x["strength"]) != int(off[int(x["id"]) - 1].sum()) for x in nodes)
        row("nodes.csv degree and strength against con_radial4_sym.csv", len(nodes), f"{bad} differ", bad == 0)

    if rows_csv is not None:
        index = np.array(rows_csv["file_index"], dtype=np.int64)
        lengths = np.loadtxt(ref / "lengths.txt", comments="#").ravel()
        ours = np.array(rows_csv["length_mm"], dtype=np.float64)
        d = np.abs(ours - lengths[index])
        limit = 0.0015 + 1e-5 * lengths[index]
        row("streamlines.csv length against tckstats -dump", len(index), f"max|diff| {d.max():.3g} mm, {int((d > limit).sum())} over", bool((d <= limit).all()), "0.0015 mm + 1e-5 rel")
        if "fa" in rows_csv:
            fa = np.loadtxt(ref / "fa_mean.txt", comments="#").ravel()
            ours = np.array([float(x) if x != "" else np.nan for x in rows_csv["fa"]])
            d = np.abs(ours - fa[index])
            limit = 1e-6 + 1e-5 * np.abs(fa[index])
            row("streamlines.csv fa against tcksample -stat_tck mean", len(index), f"max|diff| {np.nanmax(d):.3g}, {int(np.count_nonzero(~(d <= limit)))} over", bool((d <= limit).all()), "1e-5 rel + 1e-6")
        if "weight" in rows_csv and (ref / "weights.txt").exists():
            w = np.loadtxt(ref / "weights.txt", comments="#").ravel()
            ours = np.array(rows_csv["weight"], dtype=np.float64)
            d = np.abs(ours - w[index])
            row("streamlines.csv weight against the weights file", len(index), f"max|diff| {d.max():.3g}", bool((d <= 1e-6 * np.abs(w[index]) + 1e-6).all()), "float32 rounding")
        if "node_a" in rows_csv:
            a = np.array(rows_csv["node_a"], dtype=np.int64)
            b = np.array(rows_csv["node_b"], dtype=np.int64)
            ours = np.sort(np.stack([a, b], 1), axis=1)
            theirs = np.sort(radial[index], axis=1)
            row("streamlines.csv regions against -out_assignments (radial 4 mm)", len(index), f"{int((ours != theirs).any(1).sum())} streamlines differ", bool((ours == theirs).all()))
        # Which tract each streamline is in, against tckedit's own list.
        tracts = rows_csv["tracts"]
        names = sorted({x for t in tracts for x in t.split(";") if x != ""})
        for name in names:
            mine = set(index[[name in t.split(";") for t in tracts]].tolist())
            expected = ids(ref / f"{name}.ids.txt")
            if expected is not None:
                sym = len(mine ^ set(expected.tolist()))
                row(f"tract {name} against tckedit", len(expected), f"symmetric difference {sym}", sym == 0)
            elif name.startswith("both_"):
                label = int(name.split("_")[1])
                theirs = set(np.nonzero((end[:, 0] == label) & (end[:, 1] == label))[0].tolist())
                sym = len(mine ^ theirs)
                row(f"tract {name} against tck2connectome -assignment_end_voxels self-pair", len(theirs), f"symmetric difference {sym}", sym == 0)

    for path in sorted(export.glob("*.tck")):
        if (ref / path.name).exists():
            compare_tracks(path, ref / path.name, bin_dir)

    if not rows:
        print("nothing to compare: no known files in the export")
        return 1
    width = max(len(r[0]) for r in rows)
    for name, count, measure, limit, status in rows:
        print(f"{status:4} {name:{width}}  n={count:<8} {measure}  [limit {limit}]")
    bad = sum(r[4] != "ok" for r in rows)
    print(f"{len(rows)} checks, {bad} missed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
