// The matrix as pixels, its label layout and the pointer as a cell. Pure, so the canvas holds no logic.

import { edgeKey, metricOf } from './connectome';
import type { Connectome, EdgeMetric } from './connectome';

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

export function cellOf(c: Connectome, a: number, b: number, metric: EdgeMetric): number {
  const e = c.edges.get(edgeKey(a, b));
  return e === undefined ? 0 : metricOf(e, metric);
}

export interface ColorScale {
  lo: number;
  hi: number;
  log: boolean;
  toUnit(value: number): number;
}

/** Counts and weights are heavy-tailed, so they get a log scale when every value allows one. */
export function colorScale(c: Connectome, metric: EdgeMetric): ColorScale {
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of c.edges.values()) {
    const v = metricOf(e, metric);
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (lo > hi) return { lo: 0, hi: 0, log: false, toUnit: () => 0 };
  const log = (metric === 'count' || metric === 'weight') && lo > 0;
  const toUnit = (v: number): number =>
    hi === lo ? 1 : log ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo);
  return { lo, hi, log, toUnit };
}

/** One RGBA texel per cell over `nodes`; an absent edge is transparent. */
export function rasterize(c: Connectome, nodes: readonly number[], metric: EdgeMetric): Uint8ClampedArray {
  const n = nodes.length;
  const rgba = new Uint8ClampedArray(n * n * 4);
  const scale = colorScale(c, metric);
  const index = new Map(nodes.map((id, i) => [id, i]));
  for (const e of c.edges.values()) {
    const v = metricOf(e, metric);
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || !Number.isFinite(v)) continue;
    const [r, g, b] = colorAt(scale.toUnit(v));
    for (const at of [(i * n + j) * 4, (j * n + i) * 4]) {
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/** Up to about six round positions along the colour bar. */
export function colorTicks(scale: ColorScale): number[] {
  const { lo, hi, log } = scale;
  if (!(hi > lo)) return lo === 0 && hi === 0 ? [] : [hi];
  if (log) {
    const out: number[] = [];
    for (let p = Math.ceil(Math.log10(lo)); p <= Math.floor(Math.log10(hi)); p += 1) out.push(10 ** p);
    if (out.length < 2) return [lo, hi];
    return out;
  }
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '–';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(3);
}

export interface MatrixLayout {
  /** CSS px of the label strips left of and above the cells. */
  gutter: number;
  /** CSS px per cell. */
  cell: number;
  nodes: number;
  /** Draw every this-many labels: 1 when each fits. */
  labelEvery: number;
  fontPx: number;
  /** Colour bar: to the right of the cells, or under them in the panel, where `barWidth` is its thickness. */
  barX: number;
  barY: number;
  barWidth: number;
  barBelow: boolean;
  /** CSS px the whole drawing needs. */
  height: number;
}

const FONT_PX = 10;
/** A label needs this much pitch to stay readable. */
const LABEL_PITCH_PX = 11;
const BAR_PX = 12;
/** Colour bar, its gap and the widest of its tick labels and unit. */
const BAR_ROOM_PX = 92;

/** The largest square of cells that fits with its labels and colour bar. `labelPx` is the widest label. */
export function layoutMatrix(widthPx: number, heightPx: number, nodes: number, labelPx: number): MatrixLayout {
  const longest = Math.ceil(labelPx) + 6;
  const gutter = Math.min(longest, Math.max(24, Math.floor(0.34 * Math.min(widthPx, heightPx))));
  const side = Math.max(0, Math.min(widthPx - gutter - BAR_ROOM_PX, heightPx - gutter));
  const cell = nodes > 0 ? side / nodes : 0;
  return {
    gutter,
    cell,
    nodes,
    labelEvery: cell >= LABEL_PITCH_PX || cell <= 0 ? 1 : Math.ceil(LABEL_PITCH_PX / cell),
    fontPx: FONT_PX,
    barX: gutter + side + 10,
    barY: gutter,
    barWidth: BAR_PX,
    barBelow: false,
    height: heightPx,
  };
}

const PANEL_FONTS_PX = [10, 9, 8];
/** Pitch per font pixel at which panel labels still read: a panel's are tighter than a figure's. */
const PANEL_PITCH = 0.95;
const PANEL_SIDE_MAX_PX = 640;
const PANEL_BAR_PX = 10;
/** The gap above the bar and the tick labels below it. */
const PANEL_BAR_ROOM_PX = 8 + PANEL_BAR_PX + 16;

/**
 * The matrix inside the right panel: the width decides and the height follows, with the colour bar
 * under the cells so it takes none of that width. `labelPx` is the widest label at 10 px; the font
 * steps down before any label is dropped.
 */
export function layoutPanelMatrix(widthPx: number, nodes: number, labelPx: number): MatrixLayout {
  let layout: MatrixLayout | null = null;
  for (const fontPx of PANEL_FONTS_PX) {
    const longest = Math.ceil((labelPx * fontPx) / 10) + 6;
    const gutter = Math.min(longest, Math.max(24, Math.floor(0.4 * widthPx)));
    const side = Math.max(0, Math.min(widthPx - gutter, PANEL_SIDE_MAX_PX));
    const cell = nodes > 0 ? side / nodes : 0;
    const pitch = fontPx * PANEL_PITCH;
    layout = {
      gutter,
      cell,
      nodes,
      labelEvery: cell >= pitch || cell <= 0 ? 1 : Math.ceil(pitch / cell),
      fontPx,
      barX: gutter,
      barY: gutter + side + 8,
      barWidth: PANEL_BAR_PX,
      barBelow: true,
      height: gutter + side + PANEL_BAR_ROOM_PX,
    };
    if (layout.labelEvery === 1) break;
  }
  return layout!;
}

export type Hit = { kind: 'row'; row: number } | { kind: 'cell'; row: number; col: number } | null;

export function hitTest(l: MatrixLayout, x: number, y: number): Hit {
  if (l.cell <= 0) return null;
  const col = Math.floor((x - l.gutter) / l.cell);
  const row = Math.floor((y - l.gutter) / l.cell);
  const onCol = col >= 0 && col < l.nodes;
  const onRow = row >= 0 && row < l.nodes;
  if (onRow && onCol) return { kind: 'cell', row, col };
  if (onRow && x >= 0 && x < l.gutter) return { kind: 'row', row };
  if (onCol && y >= 0 && y < l.gutter) return { kind: 'row', row: col };
  return null;
}
