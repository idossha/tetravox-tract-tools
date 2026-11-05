// The kernels against the committed subset of MRtrix 3.0.8's outputs (test/fixture/mrtrix.json.gz).
// Regenerate: python3 scripts/reference/make_fixture.py <mx dir>. `pnpm run agreement` runs all 2000.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assignEndVoxel, assignRadial, buildConnectome, edgeMask } from '../src/kernels/connectome';
import { combine, lengthsInto, lengthToleranceMm, markRegion, markSphere } from '../src/kernels/select';
import { STATS, statInto } from '../src/kernels/stats';
import { volumeSampler } from './sampler';

const doc = JSON.parse(gunzipSync(readFileSync('test/fixture/mrtrix.json.gz')).toString());
const typed = <T>(C: new (b: ArrayBuffer, o: number, n: number) => T, b64: string, bytes: number): T => {
  const raw = Buffer.from(b64, 'base64');
  const copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer;
  return new C(copy, 0, raw.length / bytes);
};

const ids: number[] = doc.ids;
const n = ids.length;
const offsets = typed(Uint32Array, doc.offsets, 4);
const points = typed(Float32Array, doc.points, 4);
const span = { offsets, first: 0, last: n, pointBase: 0 };

const mark = (key: string, ends = false): Uint8Array => {
  const hits = new Uint8Array(n);
  markRegion(hits, span, Float32Array.from(typed(Uint8Array, doc.roi[key], 1)), new Set([1]), ends);
  return hits;
};
const sphere = (center: [number, number, number], radiusMm: number, test: 'point' | 'segment' = 'point'): Uint8Array => {
  const hits = new Uint8Array(n);
  markSphere(hits, span, points, { kind: 'sphere', effect: 'include', endsOnly: false, center, radiusMm, test });
  return hits;
};
const selectedIds = (m: Float32Array): number[] => ids.filter((_, i) => m[i] === 1);

const geom = { dims: doc.dims as number[], affine: doc.affine as number[], inverseAffine: doc.inverseAffine as number[] };
const [nx, ny, nz] = geom.dims as [number, number, number];
const volume = new Int32Array(nx * ny * nz);
{
  const v = typed(Int16Array, doc.voxels, 2);
  const l = typed(Int16Array, doc.labels, 2);
  for (let i = 0; i < l.length; i += 1) volume[v[i * 3]! + nx * (v[i * 3 + 1]! + ny * v[i * 3 + 2]!)] = l[i]!;
}
const endpoints = new Float32Array(n * 6);
for (let s = 0; s < n; s += 1) {
  endpoints.set(points.subarray(offsets[s]! * 3, offsets[s]! * 3 + 3), s * 6);
  endpoints.set(points.subarray((offsets[s + 1]! - 1) * 3, offsets[s + 1]! * 3), s * 6 + 3);
}
const pairsEqual = (got: Int32Array, ref: Int32Array): void => {
  for (let s = 0; s < n; s += 1) {
    expect([got[s * 2]!, got[s * 2 + 1]!].sort((p, q) => p - q)).toEqual([ref[s * 2]!, ref[s * 2 + 1]!].sort((p, q) => p - q));
  }
};

describe('selection against tckedit', () => {
  it('has streamlines to check', () => {
    expect(n).toBeGreaterThan(50);
    for (const k of Object.keys(doc.selections)) expect(doc.selections[k].length).toBeGreaterThan(0);
  });
  it('include A', () => expect(selectedIds(combine({ n, includes: [mark('A')], excludes: [] }).selected)).toEqual(doc.selections.inc_A));
  it('include A and B', () =>
    expect(selectedIds(combine({ n, includes: [mark('A'), mark('B')], excludes: [] }).selected)).toEqual(doc.selections.inc_AB));
  it('include A exclude B', () =>
    expect(selectedIds(combine({ n, includes: [mark('A')], excludes: [mark('B')] }).selected)).toEqual(doc.selections.exc_B));
  it('include A, ends only', () =>
    expect(selectedIds(combine({ n, includes: [mark('A', true)], excludes: [] }).selected)).toEqual(doc.selections.ends_A));
  it('sphere', () => expect(selectedIds(combine({ n, includes: [sphere([0, 0, 10], 12)], excludes: [] }).selected)).toEqual(doc.selections.sph));
  it('sphere minus sphere', () =>
    expect(selectedIds(combine({ n, includes: [sphere([0, 0, 10], 12)], excludes: [sphere([20, 0, 10], 8)] }).selected)).toEqual(doc.selections.sph_exc));
  it('length, with the tolerance tckedit derives from step_size and downsample_factor', () => {
    const lengths = new Float32Array(n);
    lengthsInto(lengths, span, points);
    const toleranceMm = lengthToleranceMm(new Map([['step_size', '0.5'], ['downsample_factor', '3']]));
    const got = combine({ n, includes: [], excludes: [], lengths, minMm: 60, maxMm: 120, toleranceMm });
    expect(selectedIds(got.selected)).toEqual(doc.selections.len);
    // This subset carries the streamlines that need the tolerance: without it the count differs.
    expect(combine({ n, includes: [], excludes: [], lengths, minMm: 60, maxMm: 120 }).count).toBeLessThan(got.count);
  });
  it('segment mode is a superset of point mode, and finds a sphere between two points', () => {
    const s = 3;
    const a = offsets[s]! + 10;
    const mid: [number, number, number] = [
      (points[a * 3]! + points[a * 3 + 3]!) / 2,
      (points[a * 3 + 1]! + points[a * 3 + 4]!) / 2,
      (points[a * 3 + 2]! + points[a * 3 + 5]!) / 2,
    ];
    for (const [c, r] of [[[0, 0, 10], 12], [mid, 0.05]] as const) {
      const p = sphere([...c] as [number, number, number], r);
      const g = sphere([...c] as [number, number, number], r, 'segment');
      for (let i = 0; i < n; i += 1) if (p[i] === 1) expect(g[i]).toBe(1);
    }
    expect(sphere(mid, 0.05)[s]).toBe(0);
    expect(sphere(mid, 0.05, 'segment')[s]).toBe(1);
  });
});

describe('assignment against tck2connectome', () => {
  const sample = volumeSampler(volume, geom);
  it('end voxel', async () => pairsEqual(await assignEndVoxel(endpoints, sample), typed(Int32Array, doc.assign.end, 4)));
  it('radial 4 mm', async () => pairsEqual(await assignRadial(endpoints, geom, 4, sample), typed(Int32Array, doc.assign.radial, 4)));
  it('radial 8 mm', async () => pairsEqual(await assignRadial(endpoints, geom, 8, sample), typed(Int32Array, doc.assign.rad8, 4)));
  it('samples unresolved endpoints only: resolved ones never reach a second shell', async () => {
    const counted = { points: 0 };
    const got = await assignRadial(endpoints, geom, 4, volumeSampler(volume, geom, counted));
    let labelledEnd = 0;
    const end = await assignEndVoxel(endpoints, sample);
    end.forEach((v) => (labelledEnd += v !== 0 ? 1 : 0));
    expect(got.length).toBe(n * 2);
    const whole = 2 * n * 257; // voxels within 4 mm of a centre, if every endpoint walked all of them
    expect(labelledEnd).toBeGreaterThan(0);
    expect(counted.points).toBeLessThan(whole / 10);
  });
  it('the matrix counts each assigned streamline once and skips node 0', async () => {
    const assign = typed(Int32Array, doc.assign.radial, 4);
    const c = buildConnectome(assign);
    let assigned = 0;
    for (let s = 0; s < n; s += 1) if (assign[s * 2] !== 0 && assign[s * 2 + 1] !== 0) assigned += 1;
    let total = 0;
    for (const e of c.edges.values()) total += e.count;
    expect(total).toBe(assigned);
    for (const e of c.edges.values()) {
      const mask = edgeMask(assign, e.a, e.b);
      expect(mask.reduce((sum, v) => sum + v, 0)).toBe(e.count);
    }
    expect(c.nodes).not.toContain(0);
  });
});

describe('statistics against tcksample -stat_tck', () => {
  const fa = typed(Float32Array, doc.fa, 4);
  // MRtrix printed 10 significant digits and sampled in its own precision before fa.tsf rounded to
  // float32, so 1e-5 absorbs the rounding of a value near 0.5 summed over a few hundred points.
  it.each(STATS)('%s', (stat) => {
    const got = new Float32Array(n);
    statInto(got, stat, span, points, fa);
    const ref: number[] = doc.fa_stats[stat];
    for (let s = 0; s < n; s += 1) expect(Math.abs(got[s]! - ref[s]!)).toBeLessThan(1e-5);
  });
});
