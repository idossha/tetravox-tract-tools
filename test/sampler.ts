import type { Sampler, VolumeGeometry } from '../src/kernels/connectome';

/** `scene.sampleVolume(..., {order: 0})`'s contract over a raw volume in Fortran order. */
export function volumeSampler(
  data: ArrayLike<number>,
  geom: VolumeGeometry,
  counted?: { points: number }
): Sampler {
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
      const i = Math.round(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
      const j = Math.round(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
      const k = Math.round(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
      out[p] = i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? NaN : data[i + nx * (j + ny * k)]!;
    }
    return out;
  };
}
