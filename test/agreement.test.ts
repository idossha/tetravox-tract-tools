// All 2000 streamlines against every MRtrix 3.0.8 reference, printing agreement. Numbers come from
// scripts/reference/export_refs.py (nibabel/numpy reading what MRtrix wrote).
//   pnpm run agreement
// Skipped without TRACT_TOOLS_REFS. test/reference.test.ts holds the committed subset for CI.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignEndVoxel, assignFromPair, assignRadial, buildConnectome } from '../src/kernels/connectome';
import { matrixCsv, selectionTxt } from '../src/kernels/export';
import { combine, lengthsInto, lengthToleranceMm, markRegion, markSphere } from '../src/kernels/select';
import { STATS, statInto } from '../src/kernels/stats';
import { volumeSampler } from './sampler';

const root = process.env['TRACT_TOOLS_REFS'];
if (root === undefined) console.log('skipping agreement: TRACT_TOOLS_REFS is unset');

const file = (name: string): Buffer => readFileSync(join(root!, name));
const view = <T>(C: new (b: ArrayBuffer, o: number, n: number) => T, name: string, bytes: number): T => {
  const b = file(name);
  return new C(b.buffer as ArrayBuffer, b.byteOffset, b.length / bytes);
};

describe.skipIf(root === undefined)('agreement with MRtrix 3.0.8 on all streamlines', () => {
  it('prints every number', async () => {
    const meta = JSON.parse(file('meta.json').toString()) as {
      dims: number[];
      affine: number[];
      inverseAffine: number[];
      matrixSize: number;
      roiIds: number[];
      selections: Record<string, number[]>;
    };
    const offsets = view(Uint32Array, 'offsets.bin', 4);
    const points = view(Float32Array, 'points.bin', 4);
    const n = offsets.length - 1;
    expect(n).toBe(2000);
    const span = { offsets, first: 0, last: n, pointBase: 0 };
    const mark = (name: string, ends = false): Uint8Array => {
      const hits = new Uint8Array(n);
      const roi = view(Uint8Array, `roi${name}.bin`, 1);
      markRegion(hits, span, Float32Array.from(roi), new Set([1]), ends);
      return hits;
    };
    const sphere = (center: [number, number, number], radiusMm: number, test: 'point' | 'segment'): Uint8Array => {
      const hits = new Uint8Array(n);
      markSphere(hits, span, points, { kind: 'sphere', effect: 'include', endsOnly: false, center, radiusMm, test });
      return hits;
    };
    const lengths = new Float32Array(n);
    lengthsInto(lengths, span, points);
    const tol = lengthToleranceMm(new Map([['step_size', '0.5'], ['downsample_factor', '3']]));

    const report: string[] = [];
    const compare = (name: string, got: Float32Array): number => {
      const expected = new Set(meta.selections[name]);
      const ours = new Set<number>();
      got.forEach((v, i) => v === 1 && ours.add(i));
      const onlyRef = [...expected].filter((i) => !ours.has(i));
      const onlyOurs = [...ours].filter((i) => !expected.has(i));
      report.push(
        `selection ${name}: ref ${expected.size}, ours ${ours.size}, symmetric difference ${onlyRef.length + onlyOurs.length}` +
          (onlyRef.length + onlyOurs.length > 0 ? ` (only-ref ${onlyRef.slice(0, 8)}; only-ours ${onlyOurs.slice(0, 8)})` : '')
      );
      return onlyRef.length + onlyOurs.length;
    };
    const A = mark('A');
    const B = mark('B');
    const sA = sphere([0, 0, 10], 12, 'point');
    const sB = sphere([20, 0, 10], 8, 'point');
    let total = 0;
    total += compare('inc_A', combine({ n, includes: [A], excludes: [] }).selected);
    total += compare('inc_AB', combine({ n, includes: [A, B], excludes: [] }).selected);
    total += compare('exc_B', combine({ n, includes: [A], excludes: [B] }).selected);
    total += compare('ends_A', combine({ n, includes: [mark('A', true)], excludes: [] }).selected);
    total += compare('sph', combine({ n, includes: [sA], excludes: [] }).selected);
    total += compare('sph_exc', combine({ n, includes: [sA], excludes: [sB] }).selected);
    const len = combine({ n, includes: [], excludes: [], lengths, minMm: 60, maxMm: 120, toleranceMm: tol });
    total += compare('len', len.selected);
    const strict = combine({ n, includes: [], excludes: [], lengths, minMm: 60, maxMm: 120 });
    report.push(`  len with no tolerance (arc length alone): ${strict.count} kept vs ${meta.selections['len']!.length}`);
    expect(total).toBe(0);

    // Segment mode is a superset of point mode for spheres.
    for (const [name, c, r] of [['sph', [0, 0, 10], 12], ['exc', [20, 0, 10], 8], ['small', [0, 0, 10], 0.2]] as const) {
      const p = sphere([...c] as [number, number, number], r, 'point');
      const s = sphere([...c] as [number, number, number], r, 'segment');
      const missing = p.reduce((sum, v, i) => sum + (v === 1 && s[i] !== 1 ? 1 : 0), 0);
      const pc = p.reduce((sum, v) => sum + v, 0);
      const sc = s.reduce((sum, v) => sum + v, 0);
      report.push(`sphere ${name} r=${r}: point ${pc}, segment ${sc}, point-not-in-segment ${missing}`);
      expect(missing).toBe(0);
    }

    // Endpoints.
    const endpoints = new Float32Array(n * 6);
    for (let s = 0; s < n; s += 1) {
      endpoints.set(points.subarray(offsets[s]! * 3, offsets[s]! * 3 + 3), s * 6);
      endpoints.set(points.subarray((offsets[s + 1]! - 1) * 3, offsets[s + 1]! * 3), s * 6 + 3);
    }
    const nodes = view(Int32Array, 'nodes.bin', 4);
    const counted = { points: 0 };
    const sample = volumeSampler(nodes, meta, counted);
    const geom = { dims: meta.dims, affine: meta.affine, inverseAffine: meta.inverseAffine };
    const runs: [string, () => Promise<Int32Array>][] = [
      ['end', () => assignEndVoxel(endpoints, sample)],
      ['radial', () => assignRadial(endpoints, geom, 4, sample)],
      ['rad8', () => assignRadial(endpoints, geom, 8, sample)],
    ];
    for (const [name, run] of runs) {
      counted.points = 0;
      const got = await run();
      const ref = view(Int32Array, `as_${name}.bin`, 4);
      let equal = 0;
      let streamlinesEqual = 0;
      const diff: number[] = [];
      for (let i = 0; i < n; i += 1) {
        // MRtrix writes a pair per streamline, smaller id first, so compare as unordered pairs.
        const [a, b] = [got[i * 2]!, got[i * 2 + 1]!].sort((p, q) => p - q) as [number, number];
        const [c, d] = [ref[i * 2]!, ref[i * 2 + 1]!].sort((p, q) => p - q) as [number, number];
        equal += (a === c ? 1 : 0) + (b === d ? 1 : 0);
        if (a === c && b === d) streamlinesEqual += 1;
        else diff.push(i);
      }
      const matrix = buildConnectome(got);
      const refMatrix = view(Float64Array, `con_${name}.bin`, 8);
      const size = meta.matrixSize;
      let sumDiff = 0;
      for (let i = 0; i < size; i += 1) {
        for (let j = i; j < size; j += 1) {
          const a = i + 1;
          const b = j + 1;
          const e = matrix.edges.get(a * 2 ** 26 + b);
          // tck2connectome writes the upper triangle unless -symmetric.
          sumDiff += Math.abs((e?.count ?? 0) - refMatrix[i * size + j]!);
        }
      }
      report.push(
        `assignment ${name}: ${((100 * equal) / (2 * n)).toFixed(3)}% endpoints equal, ${streamlinesEqual}/${n} streamlines equal` +
          (diff.length > 0 ? ` (differ ${diff.slice(0, 8)})` : '') +
          `; matrix sum|diff| ${sumDiff}; sampled ${counted.points} points`
      );
      if (name === 'radial') {
        const csv = matrixCsv(matrix, size, 'count');
        expect(csv.ok).toBe(true);
        if (csv.ok) writeFileSync(join(root!, 'ours_con_radial.csv'), csv.text);
      }
      expect(sumDiff).toBe(0);
    }

    // The precomputed pair route.
    const ref = view(Int32Array, 'as_radial.bin', 4);
    const f0 = new Float32Array(n);
    const f1 = new Float32Array(n);
    for (let s = 0; s < n; s += 1) {
      f0[s] = ref[s * 2]!;
      f1[s] = ref[s * 2 + 1]!;
    }
    const fromPair = buildConnectome(assignFromPair(f0, f1));
    report.push(`attached pair: ${fromPair.edges.size} edges`);

    // Usage smoke, not an assertion: that weight file belongs to the 200k tractogram.
    if (existsSync(join(root!, 'weights_first2000.bin'))) {
      const weights = view(Float32Array, 'weights_first2000.bin', 4);
      const weighted = buildConnectome(ref, { weights });
      const expected = view(Float64Array, 'con_w.bin', 8);
      const size = meta.matrixSize;
      let diff = 0;
      for (let i = 0; i < size; i += 1) {
        for (let j = i; j < size; j += 1) {
          diff += Math.abs((weighted.edges.get((i + 1) * 2 ** 26 + j + 1)?.weight ?? 0) - expected[i * size + j]!);
        }
      }
      report.push(`weighted smoke (not asserted): sum|diff| against con_w.csv ${diff.toExponential(2)}`);
    }

    // Statistics, from the tsf MRtrix wrote.
    const fa = view(Float32Array, 'fa_tsf.bin', 4);
    expect(fa.length).toBe(points.length / 3);
    for (const stat of STATS) {
      const got = new Float32Array(n);
      statInto(got, stat, span, points, fa);
      const expected = view(Float64Array, `fa_${stat}.bin`, 8);
      let worst = 0;
      let at = -1;
      for (let s = 0; s < n; s += 1) {
        const d = Math.abs(got[s]! - expected[s]!);
        if (d > worst) {
          worst = d;
          at = s;
        }
      }
      report.push(`FA ${stat}: max |diff| ${worst.toExponential(2)} at streamline ${at}`);
      expect(worst).toBeLessThan(1e-5);
    }

    // The selection text goes back through the real tckedit in agreement.sh.
    const incAB = combine({ n, includes: [A, B], excludes: [] }).selected;
    const written = selectionTxt(incAB, Uint32Array.from({ length: n }, (_, i) => i), n);
    expect(written.ok).toBe(true);
    if (written.ok) writeFileSync(join(root!, 'ours_inc_AB.txt'), written.text);

    console.log(report.join('\n'));
  });
});
