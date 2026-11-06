// Behaviour with no MRtrix reference: expected values are worked by hand from the definitions.
import { describe, expect, it } from 'vitest';
import { assignFromPair, assignRadial, buildConnectome, edgeCategories, edgeKey, edgeMatches, edgesMask, nextShown, MAX_SAMPLE_POINTS, nodeStats, radialOffsets, summarize } from '../src/kernels/connectome';
import { edgesCsv, matrixCsv, matrixSvg, nodesCsv, selectionTxt, slug, tckChunk, tckEnd, tckHeader } from '../src/kernels/export';
import type { Edge } from '../src/kernels/connectome';
import { dateStamp, fromToPairs, groupColor, pickPair, regionMatches } from '../src/kernels/choose';
import { colorScale, colorTicks, hitTest, layoutMatrix, layoutPanelMatrix, rasterize } from '../src/kernels/heatmap';
import { parseLookup } from '../src/kernels/lut';
import { Fingerprint, methodsText } from '../src/kernels/methods';
import { combine, histogramOf, labelOf, lengthToleranceMm, markSphere, medianOf, parseHeader, regionHits, RegionIndexBuilder, sphereHits, sphereKey, spanOf } from '../src/kernels/select';
import { outsideIsZero, statInto } from '../src/kernels/stats';
import { uniqueName } from '../src/exporter';
import { upgradeRecipe } from '../src/model';
import { volumeSampler } from './sampler';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('choosing a network', () => {
  const edge = (a: number, b: number, count: number): Edge => ({ a, b, count } as Edge);
  const edges = [edge(3, 10, 100), edge(10, 42, 7), edge(3, 49, 9), edge(42, 49, 200), edge(3, 17, 4), edge(10, 10, 2)];
  it('from and to join either way round; no To is everything From has; a floor applies', () => {
    expect(fromToPairs(edges, [10], [3], 1)).toEqual([[3, 10]]);
    expect(fromToPairs(edges, [3], [10], 1)).toEqual([[3, 10]]);
    expect(fromToPairs(edges, [10], [], 1)).toEqual([[3, 10], [10, 42], [10, 10]]);
    expect(fromToPairs(edges, [10], [], 5)).toEqual([[3, 10], [10, 42]]);
  });
  it('a click starts a choice, then toggles, and clearing the last is no choice', () => {
    expect(pickPair(null, [1, 2])).toEqual([[1, 2]]);
    expect(pickPair([[1, 2]], [3, 4])).toEqual([[1, 2], [3, 4]]);
    expect(pickPair([[1, 2], [3, 4]], [2, 1])).toEqual([[3, 4]]);
    expect(pickPair([[1, 2]], [1, 2])).toBeNull();
  });
  it('a region search takes parts of a name in any order and case, or a whole id', () => {
    expect(regionMatches(10, 'Left-Thalamus', 'thal')).toBe(true);
    expect(regionMatches(10, 'Left-Thalamus', 'THALAMUS left')).toBe(true);
    expect(regionMatches(49, 'Right-Thalamus', 'left thal')).toBe(false);
    expect(regionMatches(10, 'Left-Thalamus', '10')).toBe(true);
    expect(regionMatches(10, 'Left-Thalamus', '1')).toBe(false);
    expect(regionMatches(10, 'Left-Thalamus', '  ')).toBe(true);
  });
  it('group colours match the tract layer, worked by hand from its palette', () => {
    // h = frac(0.6180339887) * 6 = 3.708 -> (0, x, c), with c = 0.665, x = c * (1 - |1.708 - 1|) = 0.1942, m = 0.285.
    expect(groupColor(1)).toEqual([73, 122, 242]);
  });
  it('a date stamp is local, sortable and a valid file name', () => {
    expect(dateStamp(new Date(2026, 10, 6, 9, 5))).toBe('20261106_0905');
  });
});

describe('ticking connections', () => {
  const ab: [number, number] = [1, 2];
  const cd: [number, number] = [3, 4];
  const ef: [number, number] = [5, 6];
  const all = [ab, cd, ef];
  it('starts from everything, and hiding one leaves the rest', () => {
    expect(nextShown(null, all, [ab], 'invert')).toEqual([cd, ef]);
    expect(nextShown(null, all, all, 'hide')).toEqual([]);
  });
  it('acts only on its targets, so a search can hide all then show a few', () => {
    expect(nextShown([], all, [cd], 'show')).toEqual([cd]);
    expect(nextShown([ab, cd], all, [cd, ef], 'hide')).toEqual([ab]);
    expect(nextShown([ab], all, [ab, cd], 'invert')).toEqual([cd]);
  });
  it('every tick on is no filter at all', () => {
    expect(nextShown([ab, cd], all, [ef], 'show')).toBeNull();
    expect(nextShown([], all, all, 'invert')).toBeNull();
  });
  it('a mask holds exactly the streamlines of its connections, in either direction', () => {
    const assign = Int32Array.from([1, 2, 2, 1, 3, 4, 5, 6, 0, 2]);
    expect([...edgesMask(assign, [ab, cd])]).toEqual([1, 1, 1, 0, 0]);
    expect([...edgesMask(assign, [])]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('the connection search', () => {
  const names: Record<number, string> = { 10: 'Left-Thalamus', 49: 'Right-Thalamus', 3: 'Left-Cerebral-Cortex' };
  const name = (id: number): string => names[id]!;
  const left = { a: 3, b: 10 };
  const right = { a: 3, b: 49 };
  it('matches any word order and case, across both regions', () => {
    expect(edgeMatches(left, 'THALAMUS', name)).toBe(true);
    expect(edgeMatches(left, 'cortex thalamus', name)).toBe(true);
    expect(edgeMatches(right, 'left-thalamus', name)).toBe(false);
    expect(edgeMatches(left, 'thalamus hippocampus', name)).toBe(false);
  });
  it('an empty search matches everything, and a whole id matches but part of one does not', () => {
    expect(edgeMatches(left, '   ', name)).toBe(true);
    expect(edgeMatches(left, '10', name)).toBe(true);
    expect(edgeMatches(left, '1', name)).toBe(false);
  });
});

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
  it('a point outside a sampled volume counts as 0, as tcksample reads it', () => {
    const out = new Float32Array(1);
    statInto(out, 'mean', span, points, outsideIsZero(Float32Array.of(NaN, 2, 3)));
    expect(out[0]).toBeCloseTo((2 * 2 + 1.5 * 3) / 4, 6);
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
    expect([...combine({ n: 4, includes: [i1, i2], excludes: [ex] }).keep]).toEqual([1, 0, 0, 0]);
    expect(combine({ n: 4, includes: [i1], excludes: [], extra: Uint8Array.of(0, 1, 1, 1) }).count).toBe(2);
    expect(combine({ n: 2, includes: [], excludes: [], lengths: Float32Array.of(10, 20), minMm: 15, maxMm: null }).count).toBe(1);
  });
  it('a median and a histogram of what is kept', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 2, 3])).toBe(2.5);
    expect(medianOf([])).toBeNaN();
    const h = histogramOf(Float32Array.of(0, 5, 10), 2);
    expect(h).toEqual({ lo: 0, hi: 10, counts: [1, 2] });
    expect(histogramOf(Float32Array.of(0, 5, 10), 2, Uint8Array.of(1, 0, 0)).counts).toEqual([1, 0]);
  });
});

describe('region index', () => {
  // Labels along three streamlines, the third with repeated visits; a 2-chunk build must not care.
  const values = Float32Array.of(0, 5, 5, 0, 7, 7, 7, 3, 3, 5, 3, 3);
  const offsets = Uint32Array.of(0, 5, 7, 12);
  const whole = (): ReturnType<RegionIndexBuilder['finish']> => {
    const b = new RegionIndexBuilder(3);
    b.add(0, offsets, values);
    return b.finish();
  };
  it('holds each streamline\'s labels once, and its two ends', () => {
    const i = whole();
    expect([...i.ptr]).toEqual([0, 2, 3, 5]);
    expect([...i.labels]).toEqual([5, 7, 7, 3, 5]);
    expect([...i.first]).toEqual([0, 7, 3]);
    expect([...i.last]).toEqual([7, 7, 3]);
  });
  it('answers every mode', () => {
    const i = whole();
    expect([...regionHits(i, [5], 'through')]).toEqual([1, 0, 1]);
    expect([...regionHits(i, [7], 'ends')]).toEqual([1, 1, 0]);
    expect([...regionHits(i, [7], 'both')]).toEqual([0, 1, 0]);
    expect([...regionHits(i, [3, 7], 'both')]).toEqual([0, 1, 1]);
    expect([...regionHits(i, [], 'through')]).toEqual([1, 1, 1]);
    expect([...regionHits(i, [], 'both')]).toEqual([0, 1, 1]);
  });
  it('agrees across chunk boundaries', () => {
    const b = new RegionIndexBuilder(3);
    b.add(0, Uint32Array.of(0, 5), values.slice(0, 5));
    b.add(1, Uint32Array.of(0, 2, 7), values.slice(5));
    expect(b.finish()).toEqual(whole());
  });
  it('a nonzero value is never background', () => {
    expect(labelOf(NaN)).toBe(0);
    expect(labelOf(0)).toBe(0);
    expect(labelOf(0.3)).toBe(1);
    expect(labelOf(7.2)).toBe(7);
  });
});

describe('spheres', () => {
  const offsets = Uint32Array.of(0, 3, 5);
  const points = Float32Array.of(0, 0, 0, 5, 0, 0, 10, 0, 0, 20, 0, 0, 22, 0, 0);
  const bits = (center: [number, number, number], radiusMm: number, test: 'point' | 'segment'): Uint8Array => {
    const out = new Uint8Array(2);
    markSphere(out, spanOf(offsets), points, { center, radiusMm, test });
    return out;
  };
  it('one code per streamline answers every mode', () => {
    const b = bits([0, 0, 0], 6, 'point');
    expect([...sphereHits(b, 'through')]).toEqual([1, 0]);
    expect([...sphereHits(b, 'ends')]).toEqual([1, 0]);
    expect([...sphereHits(b, 'both')]).toEqual([0, 0]);
    const inner = bits([5, 0, 0], 1, 'point');
    expect([...sphereHits(inner, 'through')]).toEqual([1, 0]);
    expect([...sphereHits(inner, 'ends')]).toEqual([0, 0]);
    expect([...sphereHits(bits([21, 0, 0], 2, 'point'), 'both')]).toEqual([0, 1]);
  });
  it('a segment crossing counts only when asked', () => {
    expect([...sphereHits(bits([21, 0, 0], 0.5, 'point'), 'through')]).toEqual([0, 0]);
    expect([...sphereHits(bits([21, 0, 0], 0.5, 'segment'), 'through')]).toEqual([0, 1]);
  });
  it('the key tells a test apart', () => {
    expect(sphereKey({ center: [1, 2, 3], radiusMm: 4, test: 'point' })).not.toBe(sphereKey({ center: [1, 2, 3], radiusMm: 4, test: 'segment' }));
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
  const lengths = Float32Array.of(10, 30, 99, 7);
  const assign = assignFromPair(Float32Array.of(1, 2, 0, 3), Float32Array.of(2, 1, 4, 3));
  const c = buildConnectome(assign, lengths, { weights: Float32Array.of(1, 3, 9, 2), values: Float32Array.of(10, 20, 99, NaN) });
  it('sums weights, means a value plainly, and rounds a precomputed pair', () => {
    const e = c.edges.get(edgeKey(1, 2))!;
    expect(e.count).toBe(2);
    expect(e.weight).toBe(4);
    expect(e.value).toBe(15);
    expect(e.lengthMean).toBe(20);
    expect(e.lengthMedian).toBe(20);
    expect([e.lengthMin, e.lengthMax]).toEqual([10, 30]);
    expect(c.nodes).toEqual([1, 2, 3]);
    expect(c.edges.get(edgeKey(3, 3))!.value).toBeNaN();
    expect(c.assigned).toBe(3);
  });
  it('lists each edge\'s streamlines by file index', () => {
    const e = c.edges.get(edgeKey(1, 2))!;
    expect([...c.members.subarray(e.from, e.to)]).toEqual([0, 1]);
  });
  it('degree and strength leave out a region connected to itself; density counts pairs', () => {
    expect(nodeStats(c)).toEqual([
      { id: 1, degree: 1, strength: 2, weight: 4 },
      { id: 2, degree: 1, strength: 2, weight: 4 },
      { id: 3, degree: 0, strength: 0, weight: 0 },
    ]);
    expect(summarize(c, 3, 4)).toEqual({ edges: 1, density: 1 / 3, assignedPct: 75 });
  });
  it('gives each distinct edge a category and leaves unassigned at 0', () => {
    const { ids, names } = edgeCategories(Int32Array.of(1, 2, 2, 1, 0, 4, 3, 3));
    expect([...ids]).toEqual([1, 1, 0, 2]);
    expect(names.get(1)).toEqual([1, 2]);
  });
});

describe('matrix drawing', () => {
  const c = buildConnectome(Int32Array.of(1, 2, 1, 2, 2, 3), Float32Array.of(1, 1, 1));
  it('colours only cells with a value, in both triangles', () => {
    const rgba = rasterize(c, [1, 2, 3], 'count');
    expect(rgba[(0 * 3 + 1) * 4 + 3]).toBe(255);
    expect(rgba[(1 * 3 + 0) * 4 + 3]).toBe(255);
    expect(rgba[(0 * 3 + 0) * 4 + 3]).toBe(0);
  });
  it('fits the square, its labels and its bar inside the box, and thins labels when they would collide', () => {
    const l = layoutMatrix(800, 600, 32, 120);
    expect(l.gutter + l.cell * 32).toBeLessThanOrEqual(600);
    expect(l.barX + l.barWidth + 40).toBeLessThanOrEqual(800);
    expect(l.labelEvery).toBe(1);
    const thin = layoutMatrix(500, 500, 200, 120);
    expect(thin.cell * thin.labelEvery).toBeGreaterThanOrEqual(11);
    expect(thin.cell * (thin.labelEvery - 1)).toBeLessThan(11);
  });
  it('in the panel, fits the width, keeps every label of an aseg at the default width, and thins only past the smallest font', () => {
    // 380 px is the 400 px docked panel's content; 135 px is "Left-Cerebellum-White-Matter" at 10 px.
    const aseg = layoutPanelMatrix(380, 32, 135);
    expect(aseg.gutter + aseg.cell * 32).toBeLessThanOrEqual(380);
    expect(aseg.barBelow).toBe(true);
    expect(aseg.barY).toBeGreaterThanOrEqual(aseg.gutter + aseg.cell * 32);
    expect(aseg.height).toBeGreaterThan(aseg.barY + aseg.barWidth);
    expect(aseg.labelEvery).toBe(1);
    expect(aseg.fontPx).toBe(8);
    expect(aseg.cell).toBeGreaterThan(7.6);
    // Dragging the panel wider gets the full font and bigger cells.
    const wide = layoutPanelMatrix(620, 32, 135);
    expect(wide.fontPx).toBe(10);
    expect(wide.cell).toBeGreaterThan(aseg.cell);
    // A popped-out window is capped, so the matrix stays on screen.
    expect(layoutPanelMatrix(3000, 32, 135).cell * 32).toBeLessThanOrEqual(640);
    const atlas = layoutPanelMatrix(380, 200, 135);
    expect(atlas.fontPx).toBe(8);
    expect(atlas.cell * atlas.labelEvery).toBeGreaterThanOrEqual(8 * 0.95);
    expect(atlas.cell * (atlas.labelEvery - 1)).toBeLessThan(8 * 0.95);
  });
  it('hits a cell, a row label and a column label, and nothing outside', () => {
    const l = { gutter: 100, cell: 10, nodes: 4, labelEvery: 1, fontPx: 10, barX: 150, barY: 100, barWidth: 12, barBelow: false, height: 200 };
    expect(hitTest(l, 125, 115)).toEqual({ kind: 'cell', row: 1, col: 2 });
    expect(hitTest(l, 50, 115)).toEqual({ kind: 'row', row: 1 });
    expect(hitTest(l, 125, 50)).toEqual({ kind: 'row', row: 2 });
    expect(hitTest(l, 50, 50)).toBeNull();
    expect(hitTest(l, 145, 115)).toBeNull();
  });
  it('a count scale is log with decades for ticks, a mean scale is linear', () => {
    const big = buildConnectome(Int32Array.from({ length: 2004 }, (_, i) => (i < 2000 ? (i % 2) + 1 : i < 2002 ? 3 : 4)), new Float32Array(1002).fill(5));
    const log = colorScale(big, 'count');
    expect(log.log).toBe(true);
    expect(colorTicks(log)).toEqual([1, 10, 100, 1000]);
    expect(log.toUnit(1)).toBe(0);
    expect(log.toUnit(1000)).toBe(1);
    const flat = colorScale(buildConnectome(Int32Array.of(1, 2, 3, 3), Float32Array.of(10, 30)), 'length');
    expect(flat.log).toBe(false);
    expect(colorTicks(flat)).toEqual([10, 15, 20, 25, 30]);
  });
});

describe('export', () => {
  const c = buildConnectome(Int32Array.of(1, 3, 3, 1, 2, 2), Float32Array.of(10, 20, 6), { weights: Float32Array.of(0.5, 0.25, 1), values: Float32Array.of(1, 3, 5) });
  const name = (id: number): string => ['', 'A,1', 'B', 'C'][id]!;
  it('writes the upper triangle over ids 1..N by default, as tck2connectome', () => {
    expect(matrixCsv(c, 3, 'count')).toBe('0,0,2\n0,1,0\n0,0,0\n');
    expect(matrixCsv(c, 3, 'count', true)).toBe('0,0,2\n0,1,0\n2,0,0\n');
    expect(matrixCsv(c, 3, 'length')).toBe('0,0,15\n0,6,0\n0,0,0\n');
    expect(matrixCsv(c, 3, 'weight')).toBe('0,0,0.75\n0,1,0\n0,0,0\n');
    expect(matrixCsv(c, 3, 'value')).toBe('0,0,2\n0,5,0\n0,0,0\n');
  });
  it('tables name both regions, quote a comma, and put the strongest first', () => {
    const lines = edgesCsv(c, name, { weight: true, value: 'fa' }).trim().split('\n');
    expect(lines[0]).toBe('region_a,region_b,id_a,id_b,n,length_mean_mm,length_median_mm,length_min_mm,length_max_mm,weight,fa');
    expect(lines[1]).toBe('"A,1",C,1,3,2,15,15,10,20,0.75,2');
    expect(lines[2]).toBe('B,B,2,2,1,6,6,6,6,1,5');
    expect(nodesCsv(c, [1, 2, 3, 4], name, false).trim().split('\n')).toEqual(['id,name,degree,strength', '1,"A,1",1,2', '2,B,0,0', '3,C,1,2', '4,,0,0']);
  });
  it('a selection is one row in file order', () => {
    expect(selectionTxt(Uint8Array.of(0, 1, 1))).toBe('0 1 1\n');
  });
  it('a .tck has a valid header on a float boundary, the source\'s lines and NaN and Inf where MRtrix puts them', () => {
    const head = tckHeader(new Map([['step_size', '0.5'], ['count', '999'], ['timestamp', '1']]), 2, 'made by a test');
    const text = new TextDecoder().decode(head);
    expect(text.startsWith('mrtrix tracks\ncount: 2\ndatatype: Float32LE\nstep_size: 0.5\ntimestamp: 1\ncommand_history: made by a test\nfile: . ')).toBe(true);
    const offset = Number(/file: \. (\d+)/.exec(text)![1]);
    expect(offset).toBe(head.length);
    expect(offset % 4).toBe(0);
    expect(text.indexOf('END\n')).toBeLessThan(offset);
    const bytes = tckChunk(Uint32Array.of(0, 1, 3), Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9), Uint8Array.of(0, 0, 1), 1);
    const floats = new Float32Array(bytes.buffer);
    expect([...floats.subarray(0, 6)]).toEqual([4, 5, 6, 7, 8, 9]);
    expect(floats.subarray(6).every(Number.isNaN)).toBe(true);
    expect(floats.length).toBe(9);
    expect(new Float32Array(tckEnd().buffer)[0]).toBe(Infinity);
  });
  it('a name becomes a file name that cannot clash or leave the folder', () => {
    const seen = new Set<string>();
    expect(uniqueName('Anterior thalamus (L)', 'tck', seen)).toBe('Anterior_thalamus_L.tck');
    expect(uniqueName('Anterior thalamus (L)', 'tck', seen)).toBe('Anterior_thalamus_L_2.tck');
    expect(slug('../../etc')).toBe('etc');
    expect(slug('///')).toBe('tract');
  });
  it('a figure as SVG holds a rect for each cell, its names and its ticks', () => {
    const svg = matrixSvg(c, [1, 2, 3], name, 'count', 'streamlines');
    expect(svg.match(/fill="rgb/g)!.length).toBe(3 + 64);
    expect(svg).toContain('>A,1<');
    expect(svg).toContain('>streamlines<');
    expect(() => JSON.stringify(svg)).not.toThrow();
  });
  it('methods say what was done, with parameters, fingerprints and the MRtrix command', () => {
    const text = methodsText({
      moduleVersion: '9',
      hostVersion: '1',
      when: 'today',
      tractogram: { name: 't.tck', path: '/d/t.tck', format: 'tck', streamlines: 10, points: 100, fingerprint: 'abc' },
      atlas: { name: 'a.nii', path: null, dims: [1, 2, 3], regions: 5, fingerprint: 'def' },
      network: { mode: 'radial', radiusMm: 4, pair: null, symmetric: false, matrixSize: 60 },
      weights: 'w',
      value: { label: 'fa', how: 'sampled' },
      namesFrom: 'FreeSurfer, assumed from label ids',
      tracts: [{ name: 'x', file: 'x.tck', count: 3, rules: [{ kind: 'sphere', effect: 'include', mode: 'through', center: [1, 2, 3], radiusMm: 4, test: 'point' }], minMm: 1, maxMm: null, connection: null, ruleText: ['Keep'] }],
      toleranceMm: 0.25,
      files: ['x.tck'],
    });
    for (const expected of ['abc', 'def', 'tck2connectome t.tck a.nii out.csv -assignment_radial_search 4', '-scale_length -stat_edge mean', 'tckedit t.tck x.tck -include 1,2,3,4 -minlength 1', 'upper triangle', '60 rows', '10 streamlines', 'FreeSurfer, assumed from label ids']) {
      expect(text).toContain(expected);
    }
  });
  it('a fingerprint sees a changed word', () => {
    const a = new Fingerprint();
    a.add(Uint32Array.of(1, 2, 3));
    const b = new Fingerprint();
    b.add(Uint32Array.of(1, 2, 4));
    expect(a.hex()).not.toBe(b.hex());
    expect(a.hex()).toHaveLength(16);
  });
});

describe('an old scene block', () => {
  it('keeps its rules and connectome under the new names', () => {
    const r = upgradeRecipe({
      tract: 'a.tck',
      rules: [{ kind: 'region', effect: 'exclude', endsOnly: true, volume: 'n.nii', labels: [3] }, { kind: 'sphere', effect: 'include', endsOnly: false, center: [0, 0, 0], radiusMm: 2, test: 'segment' }],
      minMm: 5,
      maxMm: null,
      connectome: { volume: 'n.nii', mode: 'end', radiusMm: 4, pair: null, weightField: 'w', metricField: 'm', edgeField: false, log: true, on: true, selected: { a: 1, b: 2 } },
      stats: [],
      names: [[3, 'x']],
    });
    expect(r.rules[0]).toMatchObject({ mode: 'ends', effect: 'exclude' });
    expect(r.rules[1]).toMatchObject({ mode: 'through', test: 'segment' });
    expect(r.rules[0]).not.toHaveProperty('endsOnly');
    expect(r.connectome).toMatchObject({ mode: 'end', weightField: 'w', value: { kind: 'streamline', name: 'm' }, show: 'count', on: true, shown: [[1, 2]] });
    expect(r.saved).toEqual([]);
    expect(r.exportOptions.matrices).toBe(true);
  });
});
