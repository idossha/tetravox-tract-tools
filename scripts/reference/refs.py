"""The independent reader: nibabel and numpy read what MRtrix 3.0.8 wrote. No TypeScript is involved."""
from pathlib import Path

import nibabel as nb
import numpy as np
from nibabel.streamlines import load as load_streamlines

SELECTIONS = ["inc_A", "inc_AB", "exc_B", "ends_A", "sph", "sph_exc", "len"]


def tsf_values(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    text = raw[: raw.index(b"\nEND\n")].decode()
    offset = next(int(l.split()[2]) for l in text.splitlines() if l.startswith("file:"))
    values = np.frombuffer(raw, "<f4", offset=offset)
    # Streamlines are NaN-separated and the file ends in Inf. FA itself is finite here.
    return values[np.isfinite(values)]


def nearest(points: np.ndarray, data: np.ndarray, affine: np.ndarray) -> np.ndarray:
    inv = np.linalg.inv(affine)
    ijk = np.floor(points @ inv[:3, :3].T + inv[:3, 3] + 0.5).astype(int)
    ok = np.all((ijk >= 0) & (ijk < np.array(data.shape)), axis=1)
    out = np.zeros(len(points), data.dtype)
    out[ok] = data[tuple(ijk[ok].T)]
    return out


def table(path: Path) -> np.ndarray:
    return np.loadtxt(path, comments="#", ndmin=2)


def read_all(mx: Path) -> dict:
    ref = mx / "ref"
    streamlines = [s.astype(np.float32) for s in load_streamlines(str(mx / "sub2k.tck")).streamlines]
    points = np.concatenate(streamlines)
    offsets = np.concatenate([[0], np.cumsum([len(s) for s in streamlines])]).astype(np.uint32)
    nodes = nb.load(ref / "nodes.nii.gz")
    node_data = np.asarray(nodes.dataobj, dtype=np.int32)
    out = {
        "offsets": offsets,
        "points": points,
        "fa_tsf": tsf_values(mx / "fa.tsf"),
        "node_data": node_data,
        "affine": nodes.affine,
        "roi_ids": [int(x) for x in (ref / "top.txt").read_text().split()],
        "selections": {k: sorted(int(x) for x in (ref / f"{k}.sel.txt").read_text().split()) for k in SELECTIONS},
        "assign": {k: table(ref / f"as_{k}.txt").astype(np.int32) for k in ["radial", "end", "rad8"]},
        "matrix": {k: np.loadtxt(ref / f"con_{k}.csv", delimiter=",", comments="#") for k in ["radial", "end", "rad8"]},
        "fa_stats": {k: table(ref / f"fa_{k}.txt").ravel() for k in ["mean", "median", "min", "max"]},
    }
    for name in "ABC":
        roi = nb.load(ref / f"roi{name}.nii.gz")
        out[f"roi{name}"] = nearest(points, np.asarray(roi.dataobj) >= 0.5, roi.affine)
    out["node_at_point"] = nearest(points, node_data, nodes.affine)
    return out
