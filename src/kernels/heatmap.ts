// The matrix as pixels and the pointer as a cell. Pure, so the canvas holds no logic.

import { edgeKey } from './connectome';
import type { Connectome } from './connectome';

export type CellValue = 'count' | 'weight' | 'metric';

/** viridis at eight stops: perceptually even, and readable on both themes. */
const STOPS: readonly (readonly [number, number, number])[] = [
  [68, 1, 84], [70, 50, 127], [54, 92, 141], [39, 127, 142], [31, 161, 135], [74, 194, 109], [159, 218, 58], [253, 231, 37],
];

export function colorAt(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i]!;
  const b = STOPS[i + 1]!;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

export function cellOf(c: Connectome, a: number, b: number, value: CellValue): number {
  const e = c.edges.get(edgeKey(a, b));
  if (e === undefined) return 0;
  return value === 'count' ? e.count : value === 'weight' ? e.weight : e.metric;
}

/** One RGBA texel per cell over `nodes`; an absent edge is transparent. */
export function rasterize(c: Connectome, nodes: readonly number[], value: CellValue, log: boolean): Uint8ClampedArray {
  const n = nodes.length;
  const rgba = new Uint8ClampedArray(n * n * 4);
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of c.edges.values()) {
    const v = value === 'count' ? e.count : value === 'weight' ? e.weight : e.metric;
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  // A log scale needs a positive floor: a metric can reach 0 or below, a count cannot.
  const useLog = log && lo > 0;
  const scale = (v: number): number =>
    hi === lo ? 1 : useLog ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo);
  const index = new Map(nodes.map((id, i) => [id, i]));
  for (const e of c.edges.values()) {
    const v = value === 'count' ? e.count : value === 'weight' ? e.weight : e.metric;
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || !Number.isFinite(v)) continue;
    const [r, g, b] = colorAt(scale(v));
    for (const at of [(i * n + j) * 4, (j * n + i) * 4]) {
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

export interface MapLayout {
  /** CSS px of the clickable row strip left of the matrix. */
  gutter: number;
  /** CSS px per cell. */
  cell: number;
  nodes: number;
}

export const ROW_GUTTER_PX = 12;

export function layoutFor(widthPx: number, nodes: number): MapLayout {
  return { gutter: ROW_GUTTER_PX, cell: nodes > 0 ? Math.max(0, widthPx - ROW_GUTTER_PX) / nodes : 0, nodes };
}

export type Hit = { kind: 'row'; row: number } | { kind: 'cell'; row: number; col: number } | null;

export function hitTest(l: MapLayout, x: number, y: number): Hit {
  if (l.cell <= 0 || y < 0 || x < 0) return null;
  const row = Math.floor(y / l.cell);
  if (row >= l.nodes) return null;
  if (x < l.gutter) return { kind: 'row', row };
  const col = Math.floor((x - l.gutter) / l.cell);
  return col < l.nodes ? { kind: 'cell', row, col } : null;
}
