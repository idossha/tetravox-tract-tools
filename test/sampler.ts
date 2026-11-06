import type { Sampler, VolumeGeometry } from '../src/kernels/connectome';

/**
 * `scene.sampleVolume`'s contract over a raw volume in Fortran order: nearest (half-up) or trilinear, NaN outside.
 * Trilinear past the outermost centres, within half a voxel, clamps to them, as MRtrix's Interp::Linear does.
 */
export function volumeSampler(data: ArrayLike<number>, geom: VolumeGeometry, order: 0 | 1 = 0, counted?: { points: number }): Sampler {
  const [nx, ny, nz] = geom.dims as [number, number, number];
  const m = geom.inverseAffine;
  return async (world) => {
    const n = world.length / 3;
    if (n > 2_000_000) throw new Error('more than 2,000,000 points');
    if (counted !== undefined) counted.points += n;
    const out = new Float32Array(n);
    for (let p = 0; p < n; p += 1) {
      const x = world[p * 3]!;
      const y = world[p * 3 + 1]!;
      const z = world[p * 3 + 2]!;
      const fi = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const fj = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      const fk = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      const i = Math.floor(fi + 0.5);
      const j = Math.floor(fj + 0.5);
      const k = Math.floor(fk + 0.5);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) {
        out[p] = NaN;
        continue;
      }
      if (order === 0) {
        out[p] = data[i + nx * (j + ny * k)]!;
        continue;
      }
      const clamp = (v: number, hi: number): number => Math.min(hi, Math.max(0, v));
      const li = clamp(Math.floor(fi), nx - 1);
      const lj = clamp(Math.floor(fj), ny - 1);
      const lk = clamp(Math.floor(fk), nz - 1);
      const hi = clamp(li + 1, nx - 1);
      const hj = clamp(lj + 1, ny - 1);
      const hk = clamp(lk + 1, nz - 1);
      const u = clamp(fi - li, 1);
      const v = clamp(fj - lj, 1);
      const w = clamp(fk - lk, 1);
      const at = (a: number, b: number, c: number): number => data[a + nx * (b + ny * c)]!;
      out[p] =
        (1 - w) * ((1 - v) * ((1 - u) * at(li, lj, lk) + u * at(hi, lj, lk)) + v * ((1 - u) * at(li, hj, lk) + u * at(hi, hj, lk))) +
        w * ((1 - v) * ((1 - u) * at(li, lj, hk) + u * at(hi, lj, hk)) + v * ((1 - u) * at(li, hj, hk) + u * at(hi, hj, hk)));
    }
    return out;
  };
}
