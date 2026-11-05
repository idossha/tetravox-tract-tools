"""Build test/fixture/mrtrix.json.gz: a committed subset of the MRtrix references, read by nibabel/numpy.

Usage: make_fixture.py <mx dir>. Deterministic. Streamlines are the shortest from each selection, the
ones that decide the length tolerance, and the shortest of the rest; their expected values are simply
the full run's restricted to them, so MRtrix still wrote every number. Label voxels are kept only where an
endpoint decides on them: its nearest labelled centre, plus those within 2 mm further as distractors. That
leaves every kept endpoint's answer unchanged at any radius.
"""
import base64
import gzip
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from refs import SELECTIONS, read_all

PER_SET = 8
FILLER = 60
LENGTH_BOUNDARY_MM = 0.15
DISTRACTOR_MM = 2.0


def b64(a: np.ndarray) -> str:
    return base64.b64encode(a.tobytes()).decode()


def main(mx: Path) -> None:
    r = read_all(mx)
    off, pts = r["offsets"], r["points"]
    n = len(off) - 1
    npts = np.diff(off)
    seg = [np.linalg.norm(np.diff(pts[off[i] : off[i + 1]], axis=0), axis=1).sum() for i in range(n)]
    seg = np.array(seg)

    picked: set[int] = set()
    for k in SELECTIONS:
        ids = sorted(r["selections"][k], key=lambda i: npts[i])
        picked.update(ids[:PER_SET])
        rest = sorted(set(range(n)) - set(r["selections"][k]), key=lambda i: npts[i])
        picked.update(rest[:2])
    near = np.nonzero((np.abs(seg - 60) < LENGTH_BOUNDARY_MM) | (np.abs(seg - 120) < LENGTH_BOUNDARY_MM))[0]
    picked.update(int(i) for i in sorted(near, key=lambda i: npts[i])[:14])
    picked.update(int(i) for i in np.argsort(npts)[:FILLER])
    # Every streamline the radial and end modes disagree on makes the search itself matter.
    differs = np.nonzero(np.any(r["assign"]["radial"] != r["assign"]["end"], axis=1))[0]
    picked.update(int(i) for i in sorted(differs, key=lambda i: npts[i])[:40])
    ids = sorted(picked)

    keep_pts = np.concatenate([np.arange(off[i], off[i + 1]) for i in ids])
    sub_off = np.concatenate([[0], np.cumsum(npts[ids])]).astype(np.uint32)

    ends = np.array([[pts[off[i]], pts[off[i + 1] - 1]] for i in ids]).reshape(-1, 3)
    inv = np.linalg.inv(r["affine"])
    centres = np.floor(ends @ inv[:3, :3].T + inv[:3, 3] + 0.5).astype(int)
    shape = np.array(r["node_data"].shape)
    vol = np.zeros(shape, bool)
    labelled = np.argwhere(r["node_data"] > 0)
    labelled_world = labelled @ r["affine"][:3, :3].T + r["affine"][:3, 3]
    for p in ends:
        d = np.linalg.norm(labelled_world - p, axis=1)
        keep = labelled[d <= d.min() + DISTRACTOR_MM]
        vol[tuple(keep.T)] = True
    ijk = np.argwhere(vol)
    labels = r["node_data"][tuple(ijk.T)]

    aff = r["affine"]
    doc = {
        "source": "MRtrix 3.0.8 outputs read back by scripts/reference/refs.py",
        "ids": ids,
        "offsets": b64(sub_off),
        "points": b64(pts[keep_pts].astype("<f4")),
        "fa": b64(r["fa_tsf"][keep_pts].astype("<f4")),
        "nodeAtPoint": b64(r["node_at_point"][keep_pts].astype("<f4")),
        "roi": {k: b64(r[f"roi{k}"][keep_pts].astype("u1")) for k in "AB"},
        "dims": shape.tolist(),
        "affine": aff.T.ravel().tolist(),
        "inverseAffine": inv.T.ravel().tolist(),
        "voxels": b64(ijk.astype("<i2")),
        "labels": b64(labels.astype("<i2")),
        "selections": {k: sorted(set(r["selections"][k]) & set(ids)) for k in SELECTIONS},
        "assign": {k: b64(a[ids].astype("<i4")) for k, a in r["assign"].items()},
        "fa_stats": {k: v[ids].tolist() for k, v in r["fa_stats"].items()},
    }
    out = Path(__file__).parents[2] / "test" / "fixture" / "mrtrix.json.gz"
    out.write_bytes(gzip.compress(json.dumps(doc, sort_keys=True).encode(), 9, mtime=0))
    print(f"{out}: {len(ids)} streamlines, {len(keep_pts)} points, {len(labels)} voxels, {out.stat().st_size} bytes")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
