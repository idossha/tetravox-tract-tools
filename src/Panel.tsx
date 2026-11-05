// Chrome only: every control is one model call, and the heat map's arithmetic is in kernels/heatmap.ts.
// The host's stylesheet holds only the utility classes the app itself uses, so anything else is an inline
// style; e2e checks this file's classes against the built CSS.

import { createElement, react, useEffect, useRef, useState, useSyncExternalStore } from '@tetravox/module-sdk';
import { cellOf, hitTest, layoutFor, rasterize } from './kernels/heatmap';
import type { Hit } from './kernels/heatmap';
import type { Rule } from './kernels/select';
import { STATS } from './kernels/stats';
import type { NodeMode, TractModel, View } from './model';

const WIDE_PX = 560;
const REGION_ROWS = 40;
/** Height the connectome's controls take beside the map in a window. */
const WIDE_CHROME_PX = 170;

const blur = (event: React.MouseEvent<HTMLElement>): void => event.currentTarget.blur();
const fmt = (n: number): string => n.toLocaleString('en-US');

function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    setWidth(node.clientWidth);
    const win = node.ownerDocument.defaultView;
    const Observer = win?.ResizeObserver ?? ResizeObserver;
    const observer = new Observer((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function Button(props: {
  id: string;
  onClick: () => void;
  title?: string;
  on?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={props.id}
      className={`tvx-btn tvx-btn-sm${props.on === true ? ' tvx-btn-on' : ''}`}
      title={props.title}
      disabled={props.disabled}
      onClick={(event) => {
        blur(event);
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

function Section(props: { title: string; id: string; open?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <details data-testid={props.id} open={props.open !== false} className="border-t border-tvx-line pt-1">
      <summary className="cursor-pointer select-none font-semibold text-tvx-dim">{props.title}</summary>
      <div className="mt-1 flex flex-col gap-1">{props.children}</div>
    </details>
  );
}

function ruleText(model: TractModel, rule: Rule): string {
  if (rule.kind === 'sphere') {
    const c = rule.center.map((v) => v.toFixed(1)).join(', ');
    return `sphere r ${rule.radiusMm} at ${c}`;
  }
  return `${rule.labels.map((id) => model.labelName(rule.volume, id)).join(', ')}`;
}

function RuleRow(props: { model: TractModel; rule: Rule; index: number }): React.JSX.Element {
  const { model, rule, index } = props;
  const patch = (p: object): void => void model.run('set-rule', { index, patch: p });
  return (
    <li data-testid={`tt-rule-${index}`} className="flex flex-wrap items-center gap-1">
      <Button
        id={`tt-rule-effect-${index}`}
        on={rule.effect === 'exclude'}
        title="include: must be met. exclude: rejects."
        onClick={() => patch({ effect: rule.effect === 'include' ? 'exclude' : 'include' })}
      >
        {rule.effect === 'include' ? 'in' : 'ex'}
      </Button>
      <span className="min-w-0 flex-1 truncate" title={ruleText(model, rule)}>
        {ruleText(model, rule)}
      </span>
      {rule.kind === 'sphere' && (
        <>
          <input
            data-testid={`tt-rule-radius-${index}`}
            type="number"
            min={0.1}
            step={0.5}
            className="tvx-input w-12 px-1 py-0 tabular-nums"
            title="radius, mm"
            value={rule.radiusMm}
            onChange={(event) => {
              const r = Number(event.target.value);
              if (r > 0) patch({ radiusMm: r });
            }}
          />
          <Button
            id={`tt-rule-test-${index}`}
            on={rule.test === 'point'}
            title="segment: a segment crossing the sphere counts. point: a point must be inside, as tckedit."
            onClick={() => patch({ test: rule.test === 'point' ? 'segment' : 'point' })}
          >
            {rule.test === 'point' ? 'pt' : 'seg'}
          </Button>
        </>
      )}
      <Button
        id={`tt-rule-ends-${index}`}
        on={rule.endsOnly}
        title="only a streamline's two end points count"
        onClick={() => patch({ endsOnly: !rule.endsOnly })}
      >
        ends
      </Button>
      <Button id={`tt-rule-remove-${index}`} title="remove" onClick={() => void model.run('remove-rule', { index })}>
        ✕
      </Button>
    </li>
  );
}

function RegionPicker(props: { model: TractModel; view: View }): React.JSX.Element | null {
  const { model, view } = props;
  const [volume, setVolume] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<number[]>([]);
  const current = view.volumes.find((v) => v.name === volume) ?? view.volumes[0];
  if (current === undefined) {
    return <p className="text-tvx-dim">Open a label volume to add region rules.</p>;
  }
  const q = query.trim().toLowerCase();
  const rows =
    q === ''
      ? []
      : current.labels
          .map((id) => ({ id, name: model.labelName(current.name, id) }))
          .filter((r) => String(r.id) === q || r.name.toLowerCase().includes(q))
          .slice(0, REGION_ROWS);
  return (
    <div className="flex flex-col gap-1">
      {view.volumes.length > 1 && (
        <select
          data-testid="tt-region-volume"
          className="tvx-input min-w-0 px-1 py-0.5"
          value={current.name}
          onChange={(event) => setVolume(event.target.value)}
        >
          {view.volumes.map((v) => (
            <option key={v.id} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-1">
        <input
          data-testid="tt-region-search"
          className="tvx-input min-w-0 flex-1 px-1 py-0.5"
          placeholder="region id or name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          id="tt-region-add"
          disabled={draft.length === 0}
          title="add one rule holding the ticked regions"
          onClick={() => {
            void model.run('add-region', { volume: current.name, labels: draft });
            setDraft([]);
            setQuery('');
          }}
        >
          Add ({draft.length})
        </Button>
        <Button
          id="tt-region-cursor"
          title="add the region under the crosshair"
          onClick={() => void model.run('add-region-at-cursor', { volume: current.name })}
        >
          At ＋
        </Button>
      </div>
      {rows.length > 0 && (
        <ul data-testid="tt-region-results" className="max-h-24 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id}>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid={`tt-region-${r.id}`}
                  checked={draft.includes(r.id)}
                  onChange={() =>
                    setDraft(draft.includes(r.id) ? draft.filter((d) => d !== r.id) : [...draft, r.id])
                  }
                />
                <span className="truncate">{r.id === Number(r.name) ? r.id : `${r.id} ${r.name}`}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {q !== '' && rows.length === 0 && <p className="text-tvx-dim">No region matches.</p>}
    </div>
  );
}

function Heatmap(props: { model: TractModel; view: View; width: number }): React.JSX.Element | null {
  const { model, view, width } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<Hit>(null);
  const connectome = view.connectome;
  const nodes = view.nodes;
  const metric = view.recipe.connectome.metricField !== null;
  const weighted = view.recipe.connectome.weightField !== null;
  const value = metric ? 'metric' : weighted ? 'weight' : 'count';
  const layout = layoutFor(width, nodes.length);
  const heightPx = Math.round(layout.cell * nodes.length);
  const selected = view.recipe.connectome.selected;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || connectome === null || nodes.length === 0 || width <= 0) return;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(heightPx * ratio);
    const g = canvas.getContext('2d');
    if (g === null) return;
    g.scale(ratio, ratio);
    const n = nodes.length;
    const tile = canvas.ownerDocument.createElement('canvas');
    tile.width = n;
    tile.height = n;
    const rgba = new Uint8ClampedArray(rasterize(connectome, nodes, value, view.recipe.connectome.log));
    tile.getContext('2d')!.putImageData(new ImageData(rgba, n, n), 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = 'rgba(128,128,128,0.14)';
    g.fillRect(layout.gutter, 0, width - layout.gutter, heightPx);
    g.fillStyle = 'rgba(128,128,128,0.32)';
    g.fillRect(0, 0, layout.gutter - 2, heightPx);
    g.drawImage(tile, layout.gutter, 0, width - layout.gutter, heightPx);
    if (selected !== null) {
      g.strokeStyle = '#ff5a36';
      g.lineWidth = 1;
      const i = nodes.indexOf(selected.a);
      const j = selected.b === null ? -1 : nodes.indexOf(selected.b);
      const px = Math.max(layout.cell, 3);
      if (selected.b === null && i >= 0) {
        g.strokeRect(0.5, i * layout.cell + 0.5, width - 1, px);
        g.strokeRect(layout.gutter + i * layout.cell + 0.5, 0.5, px, heightPx - 1);
      } else if (i >= 0 && j >= 0) {
        g.strokeRect(layout.gutter + j * layout.cell - 1, i * layout.cell - 1, px + 2, px + 2);
        g.strokeRect(layout.gutter + i * layout.cell - 1, j * layout.cell - 1, px + 2, px + 2);
      }
    }
  }, [connectome, nodes, value, view.recipe.connectome.log, view.matrixRevision, width, heightPx, selected]);

  if (connectome === null) return null;
  if (nodes.length === 0) return <p className="text-tvx-dim">No streamline has two assigned ends.</p>;

  const at = (event: React.MouseEvent<HTMLCanvasElement>): Hit => {
    const box = event.currentTarget.getBoundingClientRect();
    return hitTest(layout, event.clientX - box.left, event.clientY - box.top);
  };
  const describe = (hit: Hit): string => {
    if (hit === null) return 'Hover a cell. Click a cell for an edge, the left strip for a node.';
    const a = nodes[hit.row]!;
    if (hit.kind === 'row') {
      let sum = 0;
      for (const e of connectome.edges.values()) if (e.a === a || e.b === a) sum += e.count;
      return `${model.nodeName(a)}: ${fmt(sum)} streamlines`;
    }
    const b = nodes[hit.col]!;
    const edge = cellOf(connectome, a, b, 'count');
    const extra =
      value === 'count' ? '' : ` · ${value} ${cellOf(connectome, a, b, value).toPrecision(4)}`;
    return `${model.nodeName(a)} ↔ ${model.nodeName(b)}: ${fmt(edge)}${extra}`;
  };

  return (
    <div className="flex flex-col gap-1">
      <p data-testid="tt-hover" className="truncate text-tvx-dim" title={describe(hover)}>
        {describe(hover)}
      </p>
      <canvas
        ref={canvasRef}
        data-testid="tt-heatmap"
        data-nodes={nodes.length}
        data-cell={layout.cell}
        data-gutter={layout.gutter}
        style={{ width, height: heightPx, cursor: 'crosshair', display: 'block' }}
        onMouseMove={(event) => setHover(at(event))}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          const hit = at(event);
          if (hit === null) return;
          if (hit.kind === 'row') void model.run('select-edge', { a: nodes[hit.row]! });
          else void model.run('select-edge', { a: nodes[hit.row]!, b: nodes[hit.col]! });
        }}
      />
    </div>
  );
}

function FieldSelect(props: {
  id: string;
  value: string | null;
  options: string[];
  none: string;
  onChange: (value: string | null) => void;
}): React.JSX.Element {
  return (
    <select
      data-testid={props.id}
      className="tvx-input min-w-0 flex-1 px-1 py-0.5"
      value={props.value ?? ''}
      onChange={(event) => props.onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">{props.none}</option>
      {props.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function SelectSection(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const r = view.recipe;
  const lengthInput = (id: string, placeholder: string, value: number | null, key: 'minMm' | 'maxMm'): React.JSX.Element => (
    <input
      data-testid={id}
      type="number"
      min={0}
      className="tvx-input w-16 px-1 py-0.5 tabular-nums"
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(event) =>
        void model.run('set-length', { minMm: r.minMm, maxMm: r.maxMm, [key]: event.target.value })
      }
    />
  );
  return (
    <Section title="Select" id="tt-select">
      <div className="flex items-center gap-1">
        <Button id="tt-add-sphere" title="a sphere rule at the crosshair" onClick={() => void model.run('add-sphere')}>
          + Sphere at ＋
        </Button>
        <label className="flex items-center gap-1 text-tvx-dim">
          r
          <input
            data-testid="tt-sphere-radius"
            type="number"
            min={0.1}
            step={0.5}
            className="tvx-input w-12 px-1 py-0 tabular-nums"
            value={view.sphereRadiusMm}
            onChange={(event) => void model.run('set-sphere-radius', { radiusMm: Number(event.target.value) })}
          />
          mm
        </label>
        <span className="ml-auto" />
        <Button id="tt-clear" title="remove every rule, the length limits and the selected edge" onClick={() => void model.run('clear')}>
          Clear
        </Button>
      </div>
      <RegionPicker model={model} view={view} />
      {r.rules.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {r.rules.map((rule, index) => (
            <RuleRow key={index} model={model} rule={rule} index={index} />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1 text-tvx-dim">
        length mm
        {lengthInput('tt-min', 'min', r.minMm, 'minMm')}–{lengthInput('tt-max', 'max', r.maxMm, 'maxMm')}
      </div>
    </Section>
  );
}

function ConnectomeSection(props: { model: TractModel; view: View; width: number }): React.JSX.Element {
  const { model, view, width } = props;
  const c = view.recipe.connectome;
  const patch = (p: Record<string, unknown>): void => void model.run('set-connectome', p);
  const volume = c.volume ?? view.volumes[0]?.name ?? null;
  return (
    <Section title="Connectome" id="tt-connectome">
      <div className="flex items-center gap-1">
        <select
          data-testid="tt-mode"
          className="tvx-input shrink-0 px-1 py-0.5"
          value={c.mode}
          onChange={(event) => patch({ mode: event.target.value as NodeMode })}
        >
          <option value="radial">radial</option>
          <option value="end">end voxel</option>
          <option value="pair" disabled={view.pairs.length === 0}>
            attached
          </option>
        </select>
        {c.mode === 'radial' && (
          <label className="flex shrink-0 items-center gap-0.5 text-tvx-dim">
            <input
              data-testid="tt-radial"
              type="number"
              min={0.5}
              step={0.5}
              className="tvx-input w-12 px-1 py-0 tabular-nums"
              value={c.radiusMm}
              onChange={(event) => patch({ radiusMm: Number(event.target.value) })}
            />
            mm
          </label>
        )}
        {c.mode === 'pair' ? (
          <FieldSelect id="tt-pair" value={c.pair} options={view.pairs} none="pair…" onChange={(pair) => patch({ pair })} />
        ) : (
          <select
            data-testid="tt-volume"
            className="tvx-input min-w-0 flex-1 px-1 py-0.5"
            value={volume ?? ''}
            onChange={(event) => patch({ volume: event.target.value })}
          >
            {view.volumes.length === 0 && <option value="">no label volume</option>}
            {view.volumes.map((v) => (
              <option key={v.id} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        )}
        <Button
          id="tt-compute"
          disabled={c.mode === 'pair' ? c.pair === null && view.pairs.length === 0 : volume === null}
          onClick={() => void model.run('connectome', { volume: volume ?? undefined })}
        >
          Compute
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <FieldSelect
          id="tt-weight"
          value={c.weightField}
          options={view.streamlineFields}
          none="unweighted"
          onChange={(weightField) => patch({ weightField })}
        />
        <FieldSelect
          id="tt-metric"
          value={c.metricField}
          options={view.streamlineFields}
          none="count"
          onChange={(metricField) => patch({ metricField })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button id="tt-log" on={c.log} title="log colour scale" onClick={() => patch({ log: !c.log })}>
          log
        </Button>
        <Button
          id="tt-edge-field"
          on={c.edgeField}
          title="write an edge field the layer's group controls can colour by"
          onClick={() => patch({ edgeField: !c.edgeField })}
        >
          edge groups
        </Button>
        <Button id="tt-names" title="FreeSurfer or MRtrix lookup table" onClick={() => void model.run('load-names')}>
          Names…
        </Button>
        {/* Always present: a button appearing here would move the map out from under the pointer. */}
        <Button id="tt-clear-edge" disabled={c.selected === null} onClick={() => void model.run('clear-edge')}>
          Clear edge
        </Button>
      </div>
      {view.connectome !== null && (
        <p data-testid="tt-matrix-summary" className="truncate tabular-nums text-tvx-dim">
          {view.nodes.length} nodes · {fmt(view.connectome.edges.size)} edges
          {c.selected !== null &&
            ` · ${model.nodeName(c.selected.a)}${c.selected.b === null ? '' : ` ↔ ${model.nodeName(c.selected.b)}`}`}
        </p>
      )}
      <Heatmap model={model} view={view} width={width} />
    </Section>
  );
}

function StatsSection(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const [field, setField] = useState<string | null>(null);
  const [stats, setStats] = useState<string[]>(['mean']);
  const chosen = field ?? view.vertexFields[0] ?? null;
  return (
    <Section title="Statistics" id="tt-stats" open={false}>
      {view.vertexFields.length === 0 ? (
        <p className="text-tvx-dim">Attach or sample a per-point field first.</p>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <FieldSelect id="tt-stat-field" value={chosen} options={view.vertexFields} none="field…" onChange={setField} />
            <Button
              id="tt-stat-run"
              disabled={chosen === null || stats.length === 0}
              onClick={() => void model.run('stats', { field: chosen, stats })}
            >
              Compute
            </Button>
          </div>
          <div className="flex items-center gap-1">
            {STATS.map((s) => (
              <Button
                key={s}
                id={`tt-stat-${s}`}
                on={stats.includes(s)}
                onClick={() => setStats(stats.includes(s) ? stats.filter((x) => x !== s) : [...stats, s])}
              >
                {s}
              </Button>
            ))}
          </div>
          {view.recipe.stats.length > 0 && (
            <p data-testid="tt-stat-done" className="truncate text-tvx-dim" title={view.recipe.stats.map((s) => `${s.field}:${s.stat}`).join(', ')}>
              Fields: {view.recipe.stats.map((s) => `${s.field}:${s.stat}`).join(', ')}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

export function TractPanel(props: { model: TractModel }): React.JSX.Element {
  const { model } = props;
  const view = useSyncExternalStore(model.subscribe, model.state, model.state);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useWidth(rootRef);
  if (!view.available) {
    return (
      <p data-testid="tt-unavailable" className="text-[11px] text-tvx-warn">
        {view.message}
      </p>
    );
  }
  const wide = width >= WIDE_PX;
  const windowHeight = rootRef.current?.ownerDocument.defaultView?.innerHeight ?? 0;
  const mapWidth = wide ? Math.floor(Math.min(width - 320 - 8, windowHeight - WIDE_CHROME_PX)) : Math.floor(width);
  const connectome = <ConnectomeSection model={model} view={view} width={mapWidth} />;
  const left = (
    <>
      {/* Kept in view: the map is taller than the slot, and a refusal off screen is no refusal. */}
      <div className="flex flex-col gap-0.5 bg-tvx-panel py-0.5" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
      <div className="flex items-baseline gap-1">
        {view.tracts.length > 1 ? (
          <select
            data-testid="tt-tract"
            className="tvx-input min-w-0 flex-1 px-1 py-0.5"
            value={view.recipe.tract ?? ''}
            onChange={(event) => void model.run('select-tract', { name: event.target.value })}
          >
            {view.tracts.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <span data-testid="tt-tract-name" className="min-w-0 flex-1 truncate text-tvx-dim" title={view.recipe.tract ?? ''}>
            {view.recipe.tract ?? 'Open a tractogram.'}
          </span>
        )}
        <span data-testid="tt-count" className="shrink-0 font-semibold tabular-nums">
          {view.tractId === null ? '' : `${fmt(view.count ?? view.held)} of ${fmt(view.held)}`}
        </span>
      </div>
      {view.subsetNote !== null && (
        <p data-testid="tt-subset" className="text-tvx-warn">
          {view.subsetNote}
        </p>
      )}
      {view.busy !== null && (
          <p data-testid="tt-busy" className="text-tvx-dim">
            {view.busy}
          </p>
        )}
      {view.message !== null && (
        <p data-testid="tt-message" className="text-tvx-warn">
          {view.message}
        </p>
      )}
      </div>
      <SelectSection model={model} view={view} />
      {!wide && connectome}
      <StatsSection model={model} view={view} />
      <Section title="Export" id="tt-export" open={false}>
        <div className="flex items-center gap-1">
          <Button id="tt-export-matrix" disabled={view.connectome === null} onClick={() => void model.run('export-matrix')}>
            Matrix .csv
          </Button>
          <Button id="tt-export-selection" disabled={view.count === null} onClick={() => void model.run('export-selection')}>
            Selection .txt
          </Button>
        </div>
      </Section>
    </>
  );
  return (
    <div ref={rootRef} data-testid="tract-tools" className={`text-[11px] ${wide ? 'flex gap-2' : 'flex flex-col gap-1.5'}`}>
      {wide ? (
        <>
          <div className="flex shrink-0 flex-col gap-1.5" style={{ width: 320 }}>
            {left}
          </div>
          <div className="min-w-0 flex-1">{connectome}</div>
        </>
      ) : (
        left
      )}
    </div>
  );
}
