// What an export writes, as text or bytes. Nothing here touches the host.

import { edgeKey, metricOf, nodeStats } from './connectome';
import type { Connectome, Edge, EdgeMetric } from './connectome';
import { colorAt, colorScale, colorTicks, formatValue, layoutMatrix } from './heatmap';

/** tck2connectome's matrix: N rows of N, N the largest node id, its upper triangle unless `symmetric`. */
export function matrixCsv(c: Connectome, size: number, metric: EdgeMetric, symmetric = false): string {
  const rows = new Array<string>(size);
  for (let i = 1; i <= size; i += 1) {
    const row = new Array<string>(size);
    for (let j = 1; j <= size; j += 1) {
      const e = j < i && !symmetric ? undefined : c.edges.get(edgeKey(i, j));
      const v = e === undefined ? 0 : metricOf(e, metric);
      row[j - 1] = Number.isFinite(v) ? String(v) : '0';
    }
    rows[i - 1] = row.join(',');
  }
  return `${rows.join('\n')}\n`;
}

const field = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
const num = (v: number): string => (Number.isFinite(v) ? String(v) : '');

type Name = (id: number) => string;

/** Strongest first: by count, then by the two ids. */
export function edgesByCount(c: Connectome): Edge[] {
  return [...c.edges.values()].sort((p, q) => q.count - p.count || p.a - q.a || p.b - q.b);
}

export function edgesCsv(c: Connectome, name: Name, opts: { weight: boolean; value: string | null }): string {
  const head = ['region_a', 'region_b', 'id_a', 'id_b', 'n', 'length_mean_mm', 'length_median_mm', 'length_min_mm', 'length_max_mm'];
  if (opts.weight) head.push('weight');
  if (opts.value !== null) head.push(opts.value);
  const rows = [head.join(',')];
  for (const e of edgesByCount(c)) {
    const row = [field(name(e.a)), field(name(e.b)), e.a, e.b, e.count, e.lengthMean, e.lengthMedian, e.lengthMin, e.lengthMax].map(String);
    if (opts.weight) row.push(num(e.weight));
    if (opts.value !== null) row.push(num(e.value));
    rows.push(row.join(','));
  }
  return `${rows.join('\n')}\n`;
}

export function nodesCsv(c: Connectome, regions: readonly number[], name: Name, weight: boolean): string {
  const stats = new Map(nodeStats(c).map((s) => [s.id, s]));
  const rows = [`id,name,degree,strength${weight ? ',strength_weight' : ''}`];
  for (const id of regions) {
    const s = stats.get(id);
    const row = [String(id), field(name(id)), String(s?.degree ?? 0), String(s?.strength ?? 0)];
    if (weight) row.push(String(s?.weight ?? 0));
    rows.push(row.join(','));
  }
  return `${rows.join('\n')}\n`;
}

/** One row of 0/1 in file order, for `tckedit in.tck out.tck -tck_weights_in this.txt -minweight 0.5`. */
export function selectionTxt(keep: Uint8Array): string {
  return `${Array.from(keep).join(' ')}\n`;
}

export const slug = (name: string): string =>
  name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'tract';

/** A valid MRtrix header: the source's own lines, with what this file says about itself. */
export function tckHeader(source: ReadonlyMap<string, string>, count: number, history: string): Uint8Array {
  const lines = ['mrtrix tracks', `count: ${count}`, 'datatype: Float32LE'];
  for (const [key, value] of source) {
    if (['count', 'datatype', 'file', 'END', 'total_count'].includes(key)) continue;
    for (const line of value.split('\n')) lines.push(`${key}: ${line}`);
  }
  lines.push(`command_history: ${history}`);
  const body = `${lines.join('\n')}\n`;
  // The offset's own digits change the length, so settle it, then pad to a 4-byte float boundary.
  let offset = body.length + 'file: . \nEND\n'.length + 8;
  offset += (4 - (offset % 4)) % 4;
  const text = `${body}file: . ${offset}\nEND\n`;
  const out = new Uint8Array(offset);
  out.set(new TextEncoder().encode(text));
  return out;
}

/** The kept streamlines of one chunk as TCK data: xyz floats with a NaN triple closing each streamline. */
export function tckChunk(offsets: Uint32Array, positions: Float32Array, keep: Uint8Array, firstSource: number): Uint8Array {
  let floats = 0;
  const count = offsets.length - 1;
  for (let c = 0; c < count; c += 1) {
    if (keep[firstSource + c] === 1) floats += (offsets[c + 1]! - offsets[c]! + 1) * 3;
  }
  const out = new Float32Array(floats);
  let at = 0;
  for (let c = 0; c < count; c += 1) {
    if (keep[firstSource + c] !== 1) continue;
    out.set(positions.subarray(offsets[c]! * 3, offsets[c + 1]! * 3), at);
    at += (offsets[c + 1]! - offsets[c]!) * 3;
    out[at] = NaN;
    out[at + 1] = NaN;
    out[at + 2] = NaN;
    at += 3;
  }
  return new Uint8Array(out.buffer);
}

/** The file's last triple. */
export const tckEnd = (): Uint8Array => new Uint8Array(Float32Array.of(Infinity, Infinity, Infinity).buffer);

export const FIGURE_PX = 1200;

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The figure as SVG, on the same layout as the PNG. A label's width is estimated at 6 px a character. */
export function matrixSvg(c: Connectome, regions: readonly number[], name: Name, metric: EdgeMetric, unit: string): string {
  const longest = Math.max(1, ...regions.map((id) => name(id).length));
  const l = layoutMatrix(FIGURE_PX, FIGURE_PX, regions.length, longest * 6);
  const scale = colorScale(c, metric);
  const index = new Map(regions.map((id, i) => [id, i]));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FIGURE_PX}" height="${FIGURE_PX}" viewBox="0 0 ${FIGURE_PX} ${FIGURE_PX}" font-family="sans-serif" font-size="${l.fontPx}">`,
    `<rect width="${FIGURE_PX}" height="${FIGURE_PX}" fill="#ffffff"/>`,
    `<rect x="${l.gutter}" y="${l.gutter}" width="${l.cell * regions.length}" height="${l.cell * regions.length}" fill="#eeeeee"/>`,
  ];
  for (const e of c.edges.values()) {
    const v = metricOf(e, metric);
    const i = index.get(e.a);
    const j = index.get(e.b);
    if (i === undefined || j === undefined || !Number.isFinite(v)) continue;
    const [r, g, b] = colorAt(scale.toUnit(v)).map(Math.round) as [number, number, number];
    for (const [row, col] of i === j ? [[i, j]] : [[i, j], [j, i]]) {
      parts.push(`<rect x="${l.gutter + col! * l.cell}" y="${l.gutter + row! * l.cell}" width="${l.cell}" height="${l.cell}" fill="rgb(${r},${g},${b})"/>`);
    }
  }
  regions.forEach((id, i) => {
    if (i % l.labelEvery !== 0) return;
    const at = l.gutter + (i + 0.5) * l.cell + l.fontPx * 0.35;
    const label = escapeXml(name(id));
    parts.push(`<text x="${l.gutter - 4}" y="${at}" text-anchor="end">${label}</text>`);
    parts.push(`<text transform="translate(${at},${l.gutter - 4}) rotate(-90)">${label}</text>`);
  });
  const side = l.cell * regions.length;
  for (let k = 0; k < 64; k += 1) {
    const [r, g, b] = colorAt(1 - (k + 0.5) / 64).map(Math.round) as [number, number, number];
    parts.push(`<rect x="${l.barX}" y="${l.gutter + (k * side) / 64}" width="${l.barWidth}" height="${side / 64 + 0.5}" fill="rgb(${r},${g},${b})"/>`);
  }
  for (const tick of colorTicks(scale)) {
    const y = l.gutter + side * (1 - scale.toUnit(tick));
    parts.push(`<text x="${l.barX + l.barWidth + 3}" y="${y + 3}">${formatValue(tick)}</text>`);
  }
  parts.push(`<text x="${l.barX}" y="${l.gutter - 6}">${escapeXml(unit)}</text>`, '</svg>');
  return `${parts.join('\n')}\n`;
}
