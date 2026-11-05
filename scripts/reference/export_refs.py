"""Dump every reference for test/agreement.test.ts. Usage: export_refs.py <mx dir> <out dir>."""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from refs import FA, read_all


WEIGHTS = Path(FA).parent / "sift2_weights.txt"


def main(mx: Path, out: Path) -> None:
    r = read_all(mx)
    out.mkdir(parents=True, exist_ok=True)
    r["offsets"].astype("<u4").tofile(out / "offsets.bin")
    r["points"].astype("<f4").tofile(out / "points.bin")
    r["fa_tsf"].astype("<f4").tofile(out / "fa_tsf.bin")
    np.asfortranarray(r["node_data"]).ravel(order="F").astype("<i4").tofile(out / "nodes.bin")
    r["node_at_point"].astype("<f4").tofile(out / "node_at_point.bin")
    for name in "ABC":
        r[f"roi{name}"].astype("u1").tofile(out / f"roi{name}.bin")
    for k, a in r["assign"].items():
        a.astype("<i4").tofile(out / f"as_{k}.bin")
    for k, m in r["matrix"].items():
        m.astype("<f8").tofile(out / f"con_{k}.bin")
    for k, v in r["fa_stats"].items():
        v.astype("<f8").tofile(out / f"fa_{k}.bin")
    if WEIGHTS.exists():
        rows = [l for l in WEIGHTS.read_text().splitlines() if not l.startswith("#")]
        np.array(rows[0].split()[:2000], dtype=np.float32).astype("<f4").tofile(out / "weights_first2000.bin")
        np.loadtxt(mx / "ref" / "con_w.csv", delimiter=",", comments="#").astype("<f8").tofile(out / "con_w.bin")
    # The engine's mat4 is column-major.
    aff = r["affine"]
    (out / "meta.json").write_text(
        json.dumps(
            {
                "dims": list(r["node_data"].shape),
                "affine": aff.T.ravel().tolist(),
                "inverseAffine": np.linalg.inv(aff).T.ravel().tolist(),
                "matrixSize": r["matrix"]["radial"].shape[0],
                "roiIds": r["roi_ids"],
                "selections": r["selections"],
            }
        )
    )
    print(f"exported {len(r['offsets']) - 1} streamlines, {len(r['points'])} points to {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
