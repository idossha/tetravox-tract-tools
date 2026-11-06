import { createElement, useEffect, useRef, useState } from '@tetravox/module-sdk';
import { cellOf, formatValue, hitTest, layoutPanelMatrix } from '../kernels/heatmap';
import type { Hit } from '../kernels/heatmap';
import type { TractModel, View } from '../model';
import { fmt } from './controls';
import { paintHover, paintMatrix, widestLabel } from './drawMatrix';

/** This element's width in its own window: a popped-out panel lives in another document. */
function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const win = node.ownerDocument.defaultView;
    const Observer = win?.ResizeObserver ?? ResizeObserver;
    const measure = (): void => setWidth(node.clientWidth);
    measure();
    const observer = new Observer(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Fills the panel's width, so dragging the panel wider makes it bigger. */
export function Matrix(props: { model: TractModel; view: View }): React.JSX.Element | null {
  const { model, view } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useWidth(rootRef);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<Hit>(null);
  const [cursor, setCursor] = useState<{ row: number; col: number } | null>(null);
  const [gutterPx, setGutterPx] = useState(0);
  const c = view.connectome;
  const regions = view.regions;
  const metric = view.recipe.connectome.show;
  const layout = layoutPanelMatrix(width, regions.length, gutterPx);
  const height = layout.height;
  const { shown } = view.recipe.connectome;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || c === null || regions.length === 0 || width <= 0) return;
    const g = canvas.getContext('2d');
    if (g === null) return;
    const widest = widestLabel(g, regions, model.name);
    if (Math.abs(widest - gutterPx) > 0.5) {
      setGutterPx(widest);
      return;
    }
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    g.scale(ratio, ratio);
    const style = canvas.ownerDocument.defaultView?.getComputedStyle(canvas);
    paintMatrix(g, layout, {
      connectome: c,
      regions,
      name: model.name,
      metric,
      unit: model.metricUnit(metric),
      chosen: shown,
      textColor: style?.color ?? '#999',
      emptyColor: 'rgba(128,128,128,0.14)',
    });
  }, [c, regions, metric, view.matrixRevision, width, height, shown, gutterPx, model]);

  const hoverRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = hoverRef.current;
    const g = canvas?.getContext('2d');
    if (canvas == null || g == null || width <= 0) return;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    g.scale(ratio, ratio);
    paintHover(g, layout, hover, canvas.ownerDocument.defaultView?.getComputedStyle(canvas).color ?? '#999');
  }, [hover, width, height, gutterPx, regions.length]);

  if (c === null) return null;
  const at = (event: React.MouseEvent<HTMLCanvasElement>): Hit => {
    const box = event.currentTarget.getBoundingClientRect();
    return hitTest(layout, event.clientX - box.left, event.clientY - box.top);
  };
  const describe = (hit: Hit): string => {
    if (hit === null) return 'Hover for numbers. Click a cell to choose it, or a name to set From.';
    const a = regions[hit.row]!;
    if (hit.kind === 'row') return model.name(a);
    const b = regions[hit.col]!;
    const n = cellOf(c, a, b, 'count');
    const shown = metric === 'count' ? '' : ` · ${formatValue(cellOf(c, a, b, metric))} ${model.metricUnit(metric)}`;
    return `${model.name(a)} ↔ ${model.name(b)}: ${fmt(n)} streamlines${shown}`;
  };
  const choose = (hit: Hit): void => {
    if (hit === null) return;
    if (hit.kind === 'row') void model.run('choose', { from: [regions[hit.row]!], to: [] });
    else void model.run('pick-edge', { a: regions[hit.row]!, b: regions[hit.col]! });
  };
  const onKey = (event: React.KeyboardEvent): void => {
    const n = regions.length;
    const move: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = move[event.key];
    if (step !== undefined) {
      event.preventDefault();
      // ←/→ also nudge the cursor, from a window listener.
      event.stopPropagation();
      const from = cursor ?? { row: 0, col: 0 };
      const next = { row: Math.min(n - 1, Math.max(0, from.row + step[0])), col: Math.min(n - 1, Math.max(0, from.col + step[1])) };
      setCursor(next);
      setHover({ kind: 'cell', ...next });
    } else if (event.key === 'Enter' && cursor !== null) {
      event.preventDefault();
      choose({ kind: 'cell', ...cursor });
    } else if (event.key === 'Escape') {
      setCursor(null);
      setHover(null);
      void model.run('clear-edge');
    }
  };
  return (
    <div ref={rootRef} data-testid="tt-matrix" className="mt-1">
      {/* Two lines held open, so hovering never moves the cells under the pointer. */}
      <p data-testid="tt-hover" className="text-tvx-dim" style={{ minHeight: '2.6em', overflowWrap: 'anywhere' }}>
        {describe(hover)}
      </p>
      {regions.length === 0 ? (
        <p className="text-tvx-dim">No streamline has two assigned ends.</p>
      ) : (
        <div style={{ position: 'relative', width, height }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          data-testid="tt-heatmap"
          data-nodes={regions.length}
          data-cell={layout.cell}
          data-gutter={layout.gutter}
          data-label-every={layout.labelEvery}
          data-font={layout.fontPx}
          aria-label="Connectivity matrix. Arrow keys move, Enter selects, Escape clears."
          className="text-tvx-dim"
          style={{ width, height, cursor: 'crosshair', display: 'block' }}
          onMouseMove={(event) => setHover(at(event))}
          onMouseLeave={() => setHover(null)}
          onKeyDown={onKey}
          onClick={(event) => choose(at(event))}
        />
        <canvas ref={hoverRef} data-testid="tt-heatmap-hover" className="text-tvx-dim" style={{ position: 'absolute', top: 0, left: 0, width, height, pointerEvents: 'none' }} />
        </div>
      )}
    </div>
  );
}
