// Behaviour with no MRtrix reference: expected values are worked by hand from the definitions.
import { describe, expect, it } from 'vitest';
import { assignFromPair, assignRadial, buildConnectome, edgeCategories, edgeKey, MAX_SAMPLE_POINTS, radialOffsets } from '../src/kernels/connectome';
import { MAX_WRITE_BYTES, matrixCsv, selectionTxt } from '../src/kernels/export';
import { parseLookup } from '../src/kernels/lut';
import { combine, lengthToleranceMm, parseHeader, ruleKey } from '../src/kernels/select';
import { statInto } from '../src/kernels/stats';
import { volumeSampler } from './sampler';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('statistics', () => {
  const offsets = Uint32Array.of(0, 3);
  const span = { offsets, first: 0, last: 1, pointBase: 0 };
  // Segments of 1 and 3 mm, so the weights are 0.5, 2, 1.5.
  const points = Float32Array.of(0, 0, 0, 1, 0, 0, 4, 0, 0);
  it('weights the mean by half of the adjoining segments', () => {
    const out = new Float32Array(1);
    statInto(out, 'mean', span, points, Float32Array.of(1, 2, 3));
    expect(out[0]).toBeCloseTo((0.5 * 1 + 2 * 2 + 1.5 * 3) / 4, 6);
  });
  it('skips non-finite samples, and is NaN with none left', () => {
    const out = new Float32Array(1);
    statInto(out, 'max', span, points, Float32Array.of(1, NaN, 3));
    expect(out[0]).toBe(3);
    statInto(out, 'median', span, points, Float32Array.of(NaN, 2, 4));
    expect(out[0]).toBe(3);
    statInto(out, 'mean', span, points, Float32Array.of(NaN, NaN, NaN));
    expect(out[0]).toBeNaN();
  });
});

describe('lookup tables', () => {
  it('reads FreeSurfer and MRtrix rows', () => {
    const names = parseLookup(
      '# comment\n0 Unknown 0 0 0 0\n17 Left-Hippocampus 220 216 20 0\n1 L.BSTS Left-Banks_STS 25 100 40 255\n  2 "L.CAC" "Left caudal" 1 2 3 4\n\nnot a row\n'
    );
    expect(names.get(17)).toBe('Left-Hippocampus');
    expect(names.get(1)).toBe('Left-Banks_STS');
    expect(names.get(2)).toBe('"Left caudal"'.replace(/"/g, ''));
    expect(names.size).toBe(4);
  });
});

describe('header', () => {
  it('derives the tolerance tckedit measured with, and none without a step size', () => {
    const h = parseHeader(JSON.stringify([['step_size', '1.0'], ['downsample_factor', '2']]));
    expect(lengthToleranceMm(h)).toBe(0.25);
    expect(lengthToleranceMm(parseHeader('{"x":1}'))).toBe(0);
    expect(lengthToleranceMm(parseHeader('not json'))).toBe(0);
    expect(lengthToleranceMm(new Map([['step_size', '0.5']]))).toBe(0.25);
  });
});

describe('combination', () => {
  it('needs every include, rejects on any exclude, and ANDs the extra mask', () => {
    const i1 = Uint8Array.of(1, 1, 1, 0);
    const i2 = Uint8Array.of(1, 1, 0, 1);
    const ex = Uint8Array.of(0, 1, 0, 0);
    expect([...combine({ n: 4, includes: [i1, i2], excludes: [ex] }).selected]).toEqual([1, 0, 0, 0]);
    expect(combine({ n: 4, includes: [i1], excludes: [], extra: Uint8Array.of(0, 1, 1, 1) }).count).toBe(2);
    expect(combine({ n: 2, includes: [], excludes: [], lengths: Float32Array.of(10, 20), minMm: 15, maxMm: null }).count).toBe(1);
  });
  it('a rule key ignores label order and effect, and tells tests apart', () => {
    const base = { kind: 'region', effect: 'include', endsOnly: false, volume: 'a.nii', labels: [3, 1] } as const;
    expect(ruleKey(base)).toBe(ruleKey({ ...base, labels: [1, 3], effect: 'exclude' }));
    expect(ruleKey({ ...base, endsOnly: true })).not.toBe(ruleKey(base));
  });
});

describe('radial search', () => {
  const geom = { dims: [20, 20, 20], affine: identity, inverseAffine: identity };
  const vol = new Int32Array(8000);
  const at = (i: number, j: number, k: number): number => i + 20 * (j + 20 * k);
  vol[at(13, 10, 10)] = 7;
  vol[at(10, 7, 10)] = 9;
  vol[at(19, 19, 19)] = 5;
  it('picks the nearest centre to the point, not to the voxel, within a strict radius', async () => {
    const s = volumeSampler(vol, geom);
    // 3 mm from both voxels' lattice distance, but the point leans toward +x.
    expect([...(await assignRadial(Float32Array.of(10.4, 10, 10), geom, 4, s))]).toEqual([7]);
    expect([...(await assignRadial(Float32Array.of(10, 9.6, 10), geom, 4, s))]).toEqual([9]);
    expect([...(await assignRadial(Float32Array.of(10, 10, 10), geom, 3, s))]).toEqual([0]);
    expect([...(await assignRadial(Float32Array.of(5, 5, 5), geom, 4, s))]).toEqual([0]);
  });
  it('treats a point off the grid as still able to reach a labelled voxel', async () => {
    const s = volumeSampler(vol, geom);
    expect([...(await assignRadial(Float32Array.of(21, 19, 19), geom, 4, s))]).toEqual([5]);
  });
  it('never asks the sampler for more than its bound', async () => {
    let worst = 0;
    const s = volumeSampler(vol, geom);
    const n = MAX_SAMPLE_POINTS + 10;
    const pts = new Float32Array(n * 3).fill(10);
    const got = await assignRadial(pts, geom, 2, async (w) => {
      worst = Math.max(worst, w.length / 3);
      return s(w);
    });
    expect(worst).toBeLessThanOrEqual(MAX_SAMPLE_POINTS);
    expect(got.length).toBe(n);
  }, 60_000);
  it('offsets ascend by distance and honour anisotropy', () => {
    const { offsets } = radialOffsets({ dims: [9, 9, 9], affine: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], inverseAffine: identity }, 2);
    expect(offsets[0]).toMatchObject({ i: 0, j: 0, k: 0, norm: 0 });
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]!.norm).toBeGreaterThanOrEqual(offsets[i - 1]!.norm);
    expect(offsets.some((o) => o.i === 2)).toBe(false);
  });
});

describe('connectome', () => {
  it('sums weights, means a field with them, and rounds a precomputed pair', () => {
    const assign = assignFromPair(Float32Array.of(1, 2, 0, 3), Float32Array.of(2, 1, 4, 3));
    const c = buildConnectome(assign, { weights: Float32Array.of(1, 3, 9, 2), metric: Float32Array.of(10, 20, 99, NaN) });
    const e = c.edges.get(edgeKey(1, 2))!;
    expect(e.count).toBe(2);
    expect(e.weight).toBe(4);
    expect(e.metric).toBeCloseTo((10 + 3 * 20) / 4);
    expect(c.nodes).toEqual([1, 2, 3]);
    expect(c.edges.get(edgeKey(3, 3))!.metric).toBeNaN();
  });
  it('gives each distinct edge a category and leaves unassigned at 0', () => {
    const { ids, names } = edgeCategories(Int32Array.of(1, 2, 2, 1, 0, 4, 3, 3));
    expect([...ids]).toEqual([1, 1, 0, 2]);
    expect(names.get(1)).toEqual([1, 2]);
  });
});

describe('export', () => {
  it('writes a symmetric matrix over ids 1..N', () => {
    const c = buildConnectome(Int32Array.of(1, 3, 3, 1, 2, 2));
    const out = matrixCsv(c, 3, 'count');
    expect(out).toEqual({ ok: true, text: '0,0,2\n0,1,0\n2,0,0\n' });
  });
  it('refuses a matrix above the cap, naming sizes, rather than truncating', () => {
    const out = matrixCsv(buildConnectome(Int32Array.of(1, 1)), 3000, 'count');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/8 MiB/);
  });
  it('writes one row in file order, through sourceIndex', () => {
    const out = selectionTxt(Float32Array.of(1, 0, 0), Uint32Array.of(2, 0, 1), 3);
    expect(out).toEqual({ ok: true, text: '0 0 1\n' });
  });
  it('refuses a subset, and a selection above the cap', () => {
    const subset = selectionTxt(new Float32Array(2), Uint32Array.of(0, 1), 3);
    expect(subset.ok).toBe(false);
    if (!subset.ok) expect(subset.reason).toMatch(/2 of 3/);
    const n = MAX_WRITE_BYTES / 2 + 1;
    const big = selectionTxt(new Float32Array(n), new Uint32Array(n), n);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toMatch(/8 MiB/);
  });
});
