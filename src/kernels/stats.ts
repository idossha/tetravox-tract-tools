// Per-streamline statistics of a per-point field: `tcksample -stat_tck`.

import type { StreamlineSpan } from './select';

export type Stat = 'mean' | 'median' | 'min' | 'max';
export const STATS: readonly Stat[] = ['mean', 'median', 'min', 'max'];

/**
 * Non-finite samples are skipped, so a streamline leaving the source image still gets a statistic of
 * what it sampled; one with no finite sample is NaN. `mean` weights each point by half its two adjoining
 * segments, as MRtrix does, which down-weights the ends.
 */
export function statInto(
  out: Float32Array,
  stat: Stat,
  span: StreamlineSpan,
  points: Float32Array,
  values: Float32Array
): void {
  const { offsets, first, last, pointBase } = span;
  const scratch: number[] = [];
  for (let s = first; s < last; s += 1) {
    const a = offsets[s]! - pointBase;
    const b = offsets[s + 1]! - pointBase;
    if (stat === 'mean') {
      let integral = 0;
      let weight = 0;
      let prev = 0;
      for (let i = a; i < b; i += 1) {
        let next = 0;
        if (i + 1 < b) {
          const dx = points[i * 3 + 3]! - points[i * 3]!;
          const dy = points[i * 3 + 4]! - points[i * 3 + 1]!;
          const dz = points[i * 3 + 5]! - points[i * 3 + 2]!;
          next = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        const v = values[i]!;
        if (Number.isFinite(v)) {
          const w = 0.5 * (prev + next);
          integral += v * w;
          weight += w;
        }
        prev = next;
      }
      out[s] = weight > 0 ? integral / weight : NaN;
    } else if (stat === 'median') {
      scratch.length = 0;
      for (let i = a; i < b; i += 1) if (Number.isFinite(values[i]!)) scratch.push(values[i]!);
      scratch.sort((x, y) => x - y);
      const n = scratch.length;
      out[s] = n === 0 ? NaN : n % 2 === 1 ? scratch[(n - 1) / 2]! : 0.5 * (scratch[n / 2 - 1]! + scratch[n / 2]!);
    } else {
      let best = NaN;
      for (let i = a; i < b; i += 1) {
        const v = values[i]!;
        if (Number.isFinite(v) && (Number.isNaN(best) || (stat === 'min' ? v < best : v > best))) best = v;
      }
      out[s] = best;
    }
  }
}
