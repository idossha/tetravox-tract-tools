import { createElement, react, useState } from '@tetravox/module-sdk';
import { groupColor } from '../kernels/choose';
import { edgeKey, edgeMatches } from '../kernels/connectome';
import type { Edge, EdgeMetric, EdgePair, ShowAction } from '../kernels/connectome';
import { formatValue } from '../kernels/heatmap';
import { histogramOf } from '../kernels/select';
import type { NodeMode, TractModel, View } from '../model';
import { Button, Fold, fmt, Heading, mm, NumberInput, Select } from './controls';
import { Chooser } from './Chooser';
import { Saved } from './Saved';
import { Histogram } from './Histogram';
import { Matrix } from './Matrix';

type SortKey = 'name' | 'n' | 'length' | 'weight' | 'value';
const TABLE_ROWS = 60;

function EdgeCard(props: { model: TractModel; view: View; edge: Edge }): React.JSX.Element {
  const { model, view, edge } = props;
  const c = view.recipe.connectome;
  const value = model.valueLabel();
  const lengths = model.edgeLengths(edge);
  return (
    <div data-testid="tt-edge-card" className="mt-1 rounded border border-tvx-line p-2">
      <div data-testid="tt-edge-name" className="font-semibold">
        {model.name(edge.a)} ↔ {model.name(edge.b)}
      </div>
      <div data-testid="tt-edge-stats" className="tabular-nums text-tvx-dim">
        {fmt(edge.count)} streamlines · length {mm(edge.lengthMean)} mean, {mm(edge.lengthMedian)} median, {mm(edge.lengthMin)} to {mm(edge.lengthMax)} mm
        {c.weightField !== null && ` · weight ${formatValue(edge.weight)}`}
        {value !== null && ` · ${value} ${formatValue(edge.value)}`}
      </div>
      <Histogram id="tt-edge-hist" data={histogramOf(lengths, 24)} height={30} />
    </div>
  );
}

function Swatch(props: { group: number }): React.JSX.Element {
  const [r, g, b] = groupColor(props.group);
  return <span data-testid="tt-edge-swatch" data-group={props.group} className="ml-1 inline-block" style={{ verticalAlign: 'middle', width: 8, height: 8, borderRadius: 2, background: `rgb(${r},${g},${b})` }} />;
}

/** What the file holds and what is kept of it, before and after a network is built. */
function Result(props: { view: View }): React.JSX.Element | null {
  const { view } = props;
  if (view.tractId === null) return <p data-testid="tt-count" className="text-tvx-dim">Open a tractogram</p>;
  return (
    <div>
      <p className="tabular-nums">
        <span data-testid="tt-count" className="font-semibold">{fmt(view.count ?? view.total)} of {fmt(view.total)}</span>{' '}
        <span data-testid="tt-median" className="text-tvx-dim">{view.ready ? `streamlines · median length ${mm(view.medianMm)} mm` : 'streamlines · reading the file'}</span>
      </p>
      {view.held < view.total && (
        <p data-testid="tt-drawn" className="tabular-nums text-tvx-dim">
          {fmt(view.drawnKept ?? view.held)} of {fmt(view.total)} drawn · numbers use all {fmt(view.total)}
        </p>
      )}
    </div>
  );
}

/** What is chosen; `Saved tracts` and the views read the same list. */
function Chosen(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const { shown } = view.recipe.connectome;
  const all = view.connectome!.edges.size;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <span data-testid="tt-edges-shown" className="min-w-0 flex-1 tabular-nums">
        {shown === null ? `All ${fmt(all)} connections` : `${fmt(shown.length)} of ${fmt(all)} connections`}
      </span>
      {shown !== null && (
        <>
          <Button id="tt-edges-save" title="Keep this choice as one saved tract, to apply or export later" onClick={() => void model.run('add-connection')}>
            Save
          </Button>
          <Button id="tt-clear-edge" title="Back to every streamline" onClick={() => void model.run('clear-edge')}>
            Clear
          </Button>
        </>
      )}
    </div>
  );
}

/** Rules arrive only from a job or an older scene now: they still filter, so the panel says so. */
function RulesNote(props: { model: TractModel; view: View }): React.JSX.Element | null {
  const { model, view } = props;
  const r = view.recipe;
  const n = r.rules.length + (r.minMm !== null || r.maxMm !== null ? 1 : 0);
  if (n === 0) return null;
  return (
    <p data-testid="tt-rules-note" className="flex items-center gap-1 text-tvx-warn">
      <span className="min-w-0 flex-1">Also filtered by {n} {n === 1 ? 'rule' : 'rules'} from a job or a saved scene.</span>
      <Button id="tt-clear" title="Remove them, and the chosen connections" onClick={() => void model.run('clear')}>
        Remove
      </Button>
    </p>
  );
}

function EdgeTable(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: 'n', down: true });
  const [query, setQuery] = useState('');
  const c = view.recipe.connectome;
  const value = model.valueLabel();
  const keyOf = (e: Edge): number | string =>
    sort.key === 'n' ? e.count : sort.key === 'length' ? e.lengthMean : sort.key === 'weight' ? e.weight : sort.key === 'value' ? e.value : `${model.name(e.a)} ${model.name(e.b)}`;
  const shownKeys = c.shown === null ? null : new Set(c.shown.map(([a, b]) => edgeKey(a, b)));
  const isShown = (e: Edge): boolean => shownKeys === null || shownKeys.has(edgeKey(e.a, e.b));
  const all = [...view.connectome!.edges.values()];
  const found = all.filter((e) => edgeMatches(e, query, model.name));
  const rows = found
    .sort((p, q) => {
      // The choice first, so it is never below the rows listed.
      if (isShown(p) !== isShown(q)) return isShown(p) ? -1 : 1;
      const a = keyOf(p);
      const b = keyOf(q);
      const order = typeof a === 'string' ? a.localeCompare(b as string) : (Number.isNaN(a) ? -Infinity : a) - (Number.isNaN(b as number) ? -Infinity : (b as number));
      return sort.down ? -order : order;
    })
    .slice(0, TABLE_ROWS);
  const head = (key: SortKey, label: string, right = true, width?: string): React.JSX.Element => (
    <th className={right ? 'text-right' : 'text-left'} style={width === undefined ? undefined : { width }}>
      <button
        type="button"
        data-testid={`tt-sort-${key}`}
        className="cursor-pointer font-semibold text-tvx-dim hover:text-tvx-text"
        aria-sort={sort.key === key ? (sort.down ? 'descending' : 'ascending') : 'none'}
        onClick={() => setSort({ key, down: sort.key === key ? !sort.down : key !== 'name' })}
      >
        {label}
        {sort.key === key ? (sort.down ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
  const chosen = c.shown;
  const show = (action: ShowAction, edges: readonly Edge[]): void =>
    void model.run('show-edges', { action, pairs: edges.map((e): EdgePair => [e.a, e.b]) });
  const groupOf = new Map([...view.connectome!.edges.keys()].sort((p, q) => p - q).map((key, i) => [key, i + 1]));
  return (
    <>
      <div className="flex items-center gap-1">
        <input
          data-testid="tt-edge-search"
          type="search"
          className="tvx-input min-w-0 flex-1 px-1 py-0.5"
          placeholder="Search connections, e.g. thalamus cortex"
          aria-label="Search connections"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span data-testid="tt-edge-found" className="shrink-0 tabular-nums text-tvx-dim">
          {fmt(found.length)} of {fmt(all.length)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button id="tt-edges-show" title="Tick every connection the search found" onClick={() => show('show', found)}>
          Show all
        </Button>
        <Button id="tt-edges-hide" title="Untick every connection the search found" onClick={() => show('hide', found)}>
          Hide all
        </Button>
        <Button id="tt-edges-invert" title="Swap the ticks on every connection the search found" onClick={() => show('invert', found)}>
          Invert
        </Button>
        <label className="ml-auto flex items-center gap-1 text-tvx-dim" title="Colour each connection's streamlines in the views, matching its swatch here">
          <input data-testid="tt-edge-colour" type="checkbox" checked={c.edgeField} onChange={(event) => void model.run('set-connectome', { edgeField: event.target.checked })} />
          Colours
        </label>
      </div>
      {found.length > TABLE_ROWS && (
        <p data-testid="tt-edges-more" className="text-tvx-dim">
          Listing the first {TABLE_ROWS}. Search for the rest.
        </p>
      )}
      {found.length === 0 ? (
        <p className="text-tvx-dim">No connection matches.</p>
      ) : (
        <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
          <table data-testid="tt-edges" className="w-full tabular-nums" style={{ borderCollapse: 'separate', borderSpacing: '0 3px', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ width: c.edgeField ? 44 : 28 }} />
            {head('name', 'Connection', false, '42%')}
                {head('n', 'n')}
                {head('length', 'mm')}
                {c.weightField !== null && head('weight', 'weight')}
                {value !== null && head('value', value)}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const on = chosen !== null && isShown(e);
                return (
                  <tr
                    key={`${e.a}:${e.b}`}
                    data-testid={`tt-edge-${e.a}-${e.b}`}
                    className={`cursor-pointer ${on ? 'font-semibold text-tvx-accent' : 'hover:text-tvx-text'}`}
                    onClick={() => void model.run('pick-edge', { a: e.a, b: e.b })}
                  >
                    <td>
                    <button
                      type="button"
                      data-testid={`tt-edge-eye-${e.a}-${e.b}`}
                      aria-pressed={isShown(e)}
                      aria-label={`${isShown(e) ? 'Hide' : 'Show'} ${model.name(e.a)} to ${model.name(e.b)}`}
                      className="tvx-btn tvx-btn-sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        show('invert', [e]);
                      }}
                    >
                      {isShown(e) ? '◉' : '○'}
                    </button>
                    {c.edgeField && <Swatch group={groupOf.get(edgeKey(e.a, e.b))!} />}
                  </td>
                  <td style={{ overflowWrap: 'anywhere' }}>
                      {model.name(e.a)} ↔ {model.name(e.b)}
                    </td>
                    <td className="text-right">{fmt(e.count)}</td>
                    <td className="text-right">{mm(e.lengthMean)}</td>
                    {c.weightField !== null && <td className="text-right">{formatValue(e.weight)}</td>}
                    {value !== null && <td className="text-right">{formatValue(e.value)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function NetworkTab(props: { model: TractModel; view: View }): React.JSX.Element {
  const { model, view } = props;
  const c = view.recipe.connectome;
  const atlas = c.volume ?? view.labelVolumes[0]?.name ?? '';
  const patch = (p: Record<string, unknown>): void => void model.run('set-connectome', p);
  const valueOptions = [
    { value: '', label: 'No value' },
    ...view.scalarVolumes.map((name) => ({ value: `v:${name}`, label: name })),
    ...[...view.vertexFields, ...view.streamlineFields.filter((f) => f !== c.weightField && !/\[\d+\]$/.test(f))].map((name) => ({ value: `f:${name}`, label: name })),
  ];
  const valueNow = c.value === null ? '' : c.value.kind === 'volume' ? `v:${c.value.name}` : `f:${c.value.name}`;
  const value = model.valueLabel();
  const shows: { value: EdgeMetric; label: string; disabled?: boolean }[] = [
    { value: 'count', label: 'Streamline count' },
    { value: 'length', label: 'Mean length (mm)' },
    { value: 'weight', label: 'Total weight', disabled: c.weightField === null },
    { value: 'value', label: value === null ? 'Mean of a value' : `Mean ${value}`, disabled: value === null },
  ];
  return (
    <div data-testid="tt-network" className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <span className="shrink-0 text-tvx-dim" style={{ width: 44 }}>Atlas</span>
        <Select
          id="tt-volume"
          value={atlas}
          options={view.labelVolumes.length === 0 ? [{ value: '', label: 'Open an atlas' }] : view.labelVolumes.map((v) => ({ value: v.name, label: v.name }))}
          onChange={(volume) => patch({ volume })}
        />
        <Button id="tt-build" on disabled={c.mode !== 'pair' && view.labelVolumes.length === 0} onClick={() => void model.run('connectome', c.mode === 'pair' ? {} : { volume: atlas })}>
          Build
        </Button>
      </div>
      <Result view={view} />
      <RulesNote model={model} view={view} />
      {view.connectome !== null && (
        <>
          <p data-testid="tt-network-summary" className="tabular-nums text-tvx-dim">
            <span data-testid="tt-card-nodes">{fmt(view.regions.length)} regions</span> ·{' '}
            <span data-testid="tt-card-assigned">{view.summary === null ? '' : `${view.summary.assignedPct.toFixed(0)}%`} with both ends in a region</span>
          </p>
          <Chooser model={model} view={view} />
          <Chosen model={model} view={view} />
      <div className="flex items-center gap-1">
        <span className="shrink-0 text-tvx-dim" style={{ width: 44 }}>Show</span>
        <Select id="tt-show" value={c.show} options={shows} onChange={(show) => void model.run('set-show', { show })} />
      </div>
          <Matrix model={model} view={view} />
          {view.selectedEdge !== null && <EdgeCard model={model} view={view} edge={view.selectedEdge} />}
          {view.selectedRegion !== null && (
            <p data-testid="tt-region-stats" className="tabular-nums text-tvx-dim">
              {model.name(view.selectedRegion.id)} connects to {view.selectedRegion.degree} {view.selectedRegion.degree === 1 ? 'region' : 'regions'} · {fmt(view.selectedRegion.strength)} streamlines
              {c.weightField !== null && ` · weight ${formatValue(view.selectedRegion.weight)}`}
            </p>
          )}
          <Heading>Connections</Heading>
          <EdgeTable model={model} view={view} />
        </>
      )}
      <Saved model={model} view={view} />
      <Fold title="Measures" id="tt-measures" initiallyOpen={c.weightField !== null || c.value !== null}>
        <div className="flex items-center gap-1">
          <span className="shrink-0 text-tvx-dim" style={{ width: 44 }}>Weights</span>
          <Select
            id="tt-weight"
            value={c.weightField ?? ''}
            options={[{ value: '', label: 'None' }, ...view.streamlineFields.filter((f) => !/\[\d+\]$/.test(f)).map((f) => ({ value: f, label: f }))]}
            onChange={(field) => void model.run('set-weights', { field: field === '' ? null : field })}
          />
          <Button id="tt-load-weights" title="tcksift2 weights, or any .txt or .csv with one row per streamline" onClick={() => void model.run('attach', { use: 'weights' })}>
            Load…
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <span className="shrink-0 text-tvx-dim" style={{ width: 44 }}>Value</span>
          <Select
            id="tt-value"
            value={valueNow}
            options={valueOptions}
            title="A scalar image sampled along each streamline, or a value attached to the tractogram"
            onChange={(raw) => void model.run('set-value', raw === '' ? {} : raw.startsWith('v:') ? { volume: raw.slice(2) } : { field: raw.slice(2) })}
          />
          <Button id="tt-load-value" title="A .tsf, or a .txt or .csv with one row per streamline" onClick={() => void model.run('attach', { use: 'value' })}>
            Load…
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button id="tt-names" title="A FreeSurfer or MRtrix lookup table" onClick={() => void model.run('load-names')}>
            Load region names…
          </Button>
          {view.namesFrom !== null && <span data-testid="tt-names-from" className="text-tvx-dim">Names: {view.namesFrom}</span>}
        </div>
      </Fold>
      <Fold title="Advanced" id="tt-network-advanced">
        <label className="flex items-center gap-1 text-tvx-dim">
          Assign ends by
          <Select
            id="tt-mode"
            value={c.mode}
            options={[
              { value: 'radial' as NodeMode, label: 'nearest region within a radius' },
              { value: 'end' as NodeMode, label: 'the voxel under the end' },
              { value: 'pair' as NodeMode, label: 'an attached pair', disabled: view.pairs.length === 0 },
            ]}
            onChange={(mode) => patch({ mode, ...(mode === 'pair' ? { pair: c.pair ?? view.pairs[0] ?? null } : {}) })}
          />
        </label>
        {c.mode === 'radial' && (
          <label className="flex items-center gap-1 text-tvx-dim">
            Radius
            <NumberInput id="tt-radial" value={c.radiusMm} min={0.5} step={0.5} onChange={(raw) => Number(raw) > 0 && patch({ radiusMm: Number(raw) })} />
            mm
          </label>
        )}
        {c.mode === 'pair' && (
          <label className="flex items-center gap-1 text-tvx-dim">
            Pair
            <Select id="tt-pair" value={c.pair ?? ''} options={view.pairs.map((p) => ({ value: p, label: p }))} onChange={(pair) => patch({ pair })} />
          </label>
        )}
      </Fold>
    </div>
  );
}
