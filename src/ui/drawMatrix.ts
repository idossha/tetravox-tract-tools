// Paints the matrix on a canvas: the panel's and the exported figure's are this one drawing.

import type { Connectome, EdgeMetric, EdgePair } from '../kernels/connectome';
import { FIGURE_PX } from '../kernels/export';
import { colorAt, colorScale, colorTicks, formatValue, layoutMatrix, rasterize } from '../kernels/heatmap';
import type { Hit, MatrixLayout } from '../kernels/heatmap';

const CHOSEN_RED = '#ff3b30';
const HOVER_BAND = 'rgba(120, 160, 255, 0.28)';

export interface MatrixPaint {
  connectome: Connectome;
  regions: readonly number[];
  name: (id: number) => string;
  metric: EdgeMetric;
  unit: string;
  /** The chosen connections, outlined; null when nothing is chosen. */
  chosen: readonly EdgePair[] | null;
  textColor: string;
  emptyColor: string;
}

export function widestLabel(g: CanvasRenderingContext2D, regions: readonly number[], name: (id: number) => string): number {
  g.font = '10px sans-serif';
  let widest = 0;
  for (const id of regions) widest = Math.max(widest, g.measureText(name(id)).width);
  return widest;
}

export function paintMatrix(g: CanvasRenderingContext2D, l: MatrixLayout, p: MatrixPaint): void {
  const n = p.regions.length;
  const side = n * l.cell;
  g.textBaseline = 'middle';
  g.font = `${l.fontPx}px sans-serif`;
  g.fillStyle = p.emptyColor;
  g.fillRect(l.gutter, l.gutter, side, side);
  const doc = g.canvas.ownerDocument;
  const tile = doc.createElement('canvas');
  tile.width = n;
  tile.height = n;
  const rgba = new Uint8ClampedArray(rasterize(p.connectome, p.regions, p.metric));
  tile.getContext('2d')!.putImageData(new ImageData(rgba, n, n), 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(tile, l.gutter, l.gutter, side, side);

  g.fillStyle = p.textColor;
  p.regions.forEach((id, i) => {
    if (i % l.labelEvery !== 0) return;
    const at = l.gutter + (i + 0.5) * l.cell;
    g.textAlign = 'right';
    g.fillText(p.name(id), l.gutter - 4, at, l.gutter - 6);
    g.save();
    g.translate(at, l.gutter - 4);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'left';
    g.fillText(p.name(id), 0, 0, l.gutter - 6);
    g.restore();
  });

  const scale = colorScale(p.connectome, p.metric);
  const unit = scale.log ? `${p.unit} (log)` : p.unit;
  if (l.barBelow) {
    for (let x = 0; x < side; x += 1) {
      const [r, gg, b] = colorAt(x / side);
      g.fillStyle = `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`;
      g.fillRect(l.barX + x, l.barY, 1.5, l.barWidth);
    }
    g.fillStyle = p.textColor;
    g.textAlign = 'right';
    g.fillText(unit, l.gutter - 4, l.barY + l.barWidth / 2, l.gutter - 6);
    const ticks = colorTicks(scale);
    ticks.forEach((tick, i) => {
      // The two ends stay inside the canvas.
      g.textAlign = i === 0 && scale.toUnit(tick) < 0.1 ? 'left' : i === ticks.length - 1 && scale.toUnit(tick) > 0.9 ? 'right' : 'center';
      g.fillText(formatValue(tick), l.barX + side * scale.toUnit(tick), l.barY + l.barWidth + 8);
    });
  } else {
    for (let y = 0; y < side; y += 1) {
      const [r, gg, b] = colorAt(1 - y / side);
      g.fillStyle = `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`;
      g.fillRect(l.barX, l.gutter + y, l.barWidth, 1.5);
    }
    g.fillStyle = p.textColor;
    g.textAlign = 'left';
    for (const tick of colorTicks(scale)) {
      g.fillText(formatValue(tick), l.barX + l.barWidth + 3, l.gutter + side * (1 - scale.toUnit(tick)), 44);
    }
    g.textBaseline = 'alphabetic';
    g.fillText(unit, l.barX, l.gutter - 6, 82);
  }

  if (p.chosen !== null) {
    const index = new Map(p.regions.map((id, i) => [id, i]));
    g.strokeStyle = CHOSEN_RED;
    g.lineWidth = 1;
    // On device pixels: cells are fractional, and a blurred line on yellow reads orange.
    const ratio = g.getTransform().a;
    const snap = (v: number): number => (Math.round(v * ratio) + (ratio % 2 === 1 ? 0.5 : 0)) / ratio;
    const outline = (row: number, col: number): void => {
      const x = snap(l.gutter + col * l.cell);
      const y = snap(l.gutter + row * l.cell);
      g.strokeRect(x, y, snap(l.gutter + (col + 1) * l.cell) - x, snap(l.gutter + (row + 1) * l.cell) - y);
    };
    for (const [a, b] of p.chosen) {
      const i = index.get(a);
      const j = index.get(b);
      if (i === undefined || j === undefined) continue;
      outline(i, j);
      if (i !== j) outline(j, i);
    }
  }
}

/** The hovered row and column, labels included, on a canvas of their own so a hover repaints only this. */
export function paintHover(g: CanvasRenderingContext2D, l: MatrixLayout, hit: Hit, textColor: string): void {
  if (hit === null) return;
  const side = l.nodes * l.cell;
  const end = l.gutter + side;
  const col = hit.kind === 'row' ? hit.row : hit.col;
  const rowY = l.gutter + hit.row * l.cell;
  const colX = l.gutter + col * l.cell;
  g.fillStyle = HOVER_BAND;
  g.fillRect(0, rowY, end, l.cell);
  g.fillRect(colX, 0, l.cell, rowY);
  g.fillRect(colX, rowY + l.cell, l.cell, end - rowY - l.cell);
  if (hit.kind === 'cell') {
    g.strokeStyle = textColor;
    g.lineWidth = 1;
    g.strokeRect(colX, rowY, l.cell, l.cell);
  }
}

/** The figure, on a white ground whatever the theme: it goes in a paper. */
export async function renderMatrixPng(
  connectome: Connectome,
  regions: readonly number[],
  name: (id: number) => string,
  metric: EdgeMetric,
  unit: string
): Promise<Uint8Array> {
  if (typeof document === 'undefined') throw new Error('A figure needs a canvas.');
  const canvas = document.createElement('canvas');
  canvas.width = FIGURE_PX;
  canvas.height = FIGURE_PX;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, FIGURE_PX, FIGURE_PX);
  const l = layoutMatrix(FIGURE_PX, FIGURE_PX, regions.length, widestLabel(g, regions, name));
  paintMatrix(g, l, { connectome, regions, name, metric, unit, chosen: null, textColor: '#111111', emptyColor: '#eeeeee' });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b === null ? reject(new Error('The canvas gave no image.')) : resolve(b)), 'image/png')
  );
  return new Uint8Array(await blob.arrayBuffer());
}
