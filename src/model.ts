// State and every command: the panel is chrome over this, and a job file reaches the same functions (§13.6).

import type { Dataset, ExtensionBlock, Layer, ModuleHost } from '@tetravox/module-sdk';
import { nextTask, planChunks, readRange } from './kernels/chunks';
import {
  assignEndVoxel,
  assignFromPair,
  assignRadial,
  buildConnectome,
  edgeCategories,
  edgeMask,
} from './kernels/connectome';
import type { Connectome } from './kernels/connectome';
import { matrixCsv, selectionTxt } from './kernels/export';
import { parseLookup } from './kernels/lut';
import {
  combine,
  lengthsInto,
  lengthToleranceMm,
  markRegion,
  markSphere,
  parseHeader,
  ruleKey,
} from './kernels/select';
import type { Effect, RegionRule, Rule, SphereRule } from './kernels/select';
import { STATS, statInto } from './kernels/stats';
import type { Stat } from './kernels/stats';

type Tract = Extract<Dataset, { kind: 'tractogram' }>;
type Volume = Extract<Dataset, { kind: 'volume' }>;
type TractsLayer = Extract<Layer, { kind: 'tracts' }>;
type PointsLayer = Extract<Layer, { kind: 'points' }>;

export const SELECTED_FIELD = 'tract-tools:selected';
export const EDGE_FIELD = 'tract-tools:edge';
const OWN_PREFIX = 'tract-tools:';
const DEBOUNCE_MS = 150;
const INCLUDE_RGBA: [number, number, number, number] = [0.25, 0.8, 0.45, 1];
const EXCLUDE_RGBA: [number, number, number, number] = [0.9, 0.3, 0.3, 1];
const BLOCK_NAMES_CAP = 64 * 1024;

export type NodeMode = 'end' | 'radial' | 'pair';

export interface ConnectomeRecipe {
  volume: string | null;
  mode: NodeMode;
  radiusMm: number;
  /** `name` of an attached `name[0]`, `name[1]` pair. */
  pair: string | null;
  weightField: string | null;
  metricField: string | null;
  edgeField: boolean;
  log: boolean;
  /** Computed at least once, so a restore recomputes it. */
  on: boolean;
  selected: { a: number; b: number | null } | null;
}

export interface Recipe {
  tract: string | null;
  rules: Rule[];
  minMm: number | null;
  maxMm: number | null;
  connectome: ConnectomeRecipe;
  stats: { field: string; stat: Stat }[];
  names: [number, string][];
}

const emptyRecipe = (): Recipe => ({
  tract: null,
  rules: [],
  minMm: null,
  maxMm: null,
  connectome: {
    volume: null,
    mode: 'radial',
    radiusMm: 4,
    pair: null,
    weightField: null,
    metricField: null,
    edgeField: false,
    log: true,
    on: false,
    selected: null,
  },
  stats: [],
  names: [],
});

export interface View {
  available: boolean;
  recipe: Recipe;
  tracts: { id: string; name: string }[];
  tractId: string | null;
  held: number;
  source: number;
  count: number | null;
  subsetNote: string | null;
  volumes: { id: string; name: string; labels: number[] }[];
  vertexFields: string[];
  streamlineFields: string[];
  pairs: string[];
  busy: string | null;
  message: string | null;
  connectome: Connectome | null;
  /** The matrix's own node order: every id with an edge. */
  nodes: number[];
  assigned: number;
  sphereRadiusMm: number;
  /** Bumped when the connectome object changes, so the canvas redraws once. */
  matrixRevision: number;
}

export interface TractModel {
  subscribe(listener: () => void): () => void;
  state(): View;
  run(id: string, args?: Record<string, unknown>): Promise<void>;
  operation(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  restore(block: ExtensionBlock): Promise<void>;
  nodeName(id: number): string;
  labelName(volume: string | null, id: number): string;
  settled(): Promise<void>;
  dispose(): void;
}

const noTracts =
  'Tract tools needs a newer Tetravox: this build has no scene.tracts (the published 0.8.0 lacks it).';

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function createModel(host: ModuleHost): TractModel {
  const tracts = host.scene.tracts;
  const available = tracts !== undefined;
  const listeners = new Set<() => void>();
  let recipe = emptyRecipe();
  let view: View = {
    available,
    recipe,
    tracts: [],
    tractId: null,
    held: 0,
    source: 0,
    count: null,
    subsetNote: null,
    volumes: [],
    vertexFields: [],
    streamlineFields: [],
    pairs: [],
    busy: null,
    message: available ? null : noTracts,
    connectome: null,
    nodes: [],
    assigned: 0,
    sphereRadiusMm: 5,
    matrixRevision: 0,
  };
  const names = new Map<number, string>();

  // Everything below is valid for one (dataset, generation).
  let cacheKey = '';
  let offsets: Uint32Array | null = null;
  let sourceIndex: Uint32Array | null = null;
  let lengths: Float32Array | null = null;
  let endpoints: Float32Array | null = null;
  let hits = new Map<string, Uint8Array>();
  let assign: { key: string; values: Int32Array } | null = null;
  let selected: Float32Array | null = null;
  let tolerance = 0;
  let statsWritten = new Set<string>();
  let builtKey = '';

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let run = 0;
  let disposed = false;
  let lastError: string | null = null;
  // A rule names a volume that is not open yet; the next dataset to land may be it.
  let waitingForData = false;

  const set = (patch: Partial<View>): void => {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };

  const allTracts = (): Tract[] =>
    host.scene.datasets().filter((d): d is Tract => d.kind === 'tractogram');
  const labelVolumes = (): Volume[] =>
    host.scene.datasets().filter((d): d is Volume => d.kind === 'volume' && d.isLabel);
  const currentTract = (): Tract | null => {
    const list = allTracts();
    return list.find((d) => d.name === recipe.tract) ?? (recipe.tract === null ? (list[0] ?? null) : null);
  };
  const volumeNamed = (name: string | null): Volume | null =>
    labelVolumes().find((d) => d.name === name) ?? null;

  const hasPair = (d: Tract, name: string): boolean =>
    d.streamlineFields.some((f) => f.name === `${name}[0]`) &&
    d.streamlineFields.some((f) => f.name === `${name}[1]`);

  /** Refresh what the panel lists from the scene. Cheap: no reads. */
  const refresh = (): void => {
    const tract = currentTract();
    if (tract !== null && recipe.tract === null) recipe = { ...recipe, tract: tract.name };
    const streamline = tract?.streamlineFields.map((f) => f.name) ?? [];
    const pairs = streamline.flatMap((name) => {
      const m = /^(.*)\[0\]$/.exec(name);
      return m !== null && tract !== null && hasPair(tract, m[1]!) ? [m[1]!] : [];
    });
    set({
      recipe,
      tracts: allTracts().map((d) => ({ id: d.id, name: d.name })),
      tractId: tract?.id ?? null,
      held: tract?.nStreamlines ?? 0,
      source: tract?.sourceStreamlines ?? 0,
      subsetNote:
        tract !== null && tract.nStreamlines < tract.sourceStreamlines
          ? `Showing ${tract.nStreamlines.toLocaleString('en-US')} of ${tract.sourceStreamlines.toLocaleString('en-US')} streamlines: results cover the displayed ones only.`
          : null,
      volumes: labelVolumes().map((d) => ({
        id: d.id,
        name: d.name,
        labels: [...(d.labelIds ?? [])].filter((id) => id !== 0),
      })),
      vertexFields: tract?.vertexFields.map((f) => f.name).filter((n) => !n.startsWith(OWN_PREFIX)) ?? [],
      streamlineFields: streamline.filter((n) => !n.startsWith(OWN_PREFIX)),
      pairs,
    });
  };

  const persist = (): void => {
    let namesList = [...names.entries()];
    if (JSON.stringify(namesList).length > BLOCK_NAMES_CAP) namesList = [];
    recipe = { ...recipe, names: namesList };
    host.scene.setBlock<Recipe>(recipe);
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const fail = (error: unknown): void => {
    lastError = error instanceof Error ? error.message : String(error);
    set({ busy: null, message: lastError });
  };

  /** Forget everything computed when the dataset, or its generation, is not what the cache is for. */
  const checkCache = (tract: Tract): boolean => {
    const key = `${tract.id}:${tract.generation}`;
    if (key === cacheKey) return false;
    cacheKey = key;
    offsets = null;
    sourceIndex = null;
    lengths = null;
    endpoints = null;
    hits = new Map();
    assign = null;
    selected = null;
    statsWritten = new Set();
    builtKey = '';
    tolerance = lengthToleranceMm(parseHeader(tract.headerJson));
    return true;
  };

  const ensureStructure = async (tract: Tract): Promise<Uint32Array> => {
    if (offsets === null) {
      const s = await tracts.structure(tract.id);
      offsets = s.offsets;
      sourceIndex = s.sourceIndex;
    }
    return offsets;
  };

  /** One pass over the points for anything geometric that is missing. */
  const ensureGeometry = async (tract: Tract, needEnds: boolean, stale: () => boolean): Promise<void> => {
    const off = await ensureStructure(tract);
    const n = off.length - 1;
    const spheres = recipe.rules.filter(
      (r): r is SphereRule => r.kind === 'sphere' && !hits.has(ruleKey(r))
    );
    const wantLengths = lengths === null;
    const wantEnds = needEnds && endpoints === null;
    if (spheres.length === 0 && !wantLengths && !wantEnds) return;
    const newHits = spheres.map(() => new Uint8Array(n));
    const newLengths = wantLengths ? new Float32Array(n) : null;
    const newEnds = wantEnds ? new Float32Array(n * 6) : null;
    for (const chunk of planChunks(off)) {
      if (stale()) return;
      const a = off[chunk.first]!;
      const count = off[chunk.last]! - a;
      const points = await readRange((f, c) => tracts.points(tract.id, f, c), a, count, 3);
      const span = { offsets: off, first: chunk.first, last: chunk.last, pointBase: a };
      spheres.forEach((rule, i) => markSphere(newHits[i]!, span, points, rule));
      if (newLengths !== null) lengthsInto(newLengths, span, points);
      if (newEnds !== null) {
        for (let s = chunk.first; s < chunk.last; s += 1) {
          const p = off[s]! - a;
          const q = off[s + 1]! - a;
          if (q === p) continue;
          newEnds.set(points.subarray(p * 3, p * 3 + 3), s * 6);
          newEnds.set(points.subarray((q - 1) * 3, q * 3), s * 6 + 3);
        }
      }
      await nextTask();
    }
    spheres.forEach((rule, i) => hits.set(ruleKey(rule), newHits[i]!));
    if (newLengths !== null) lengths = newLengths;
    if (newEnds !== null) endpoints = newEnds;
  };

  const labelFieldName = (volume: string): string => `${OWN_PREFIX}labels:${volume}`;

  /** Nearest labels per point live in the worker, sampled once per volume and generation. */
  const ensureLabels = async (tract: Tract, volume: Volume): Promise<string> => {
    const name = labelFieldName(volume.name);
    // `samples` outlives a removed field, so the field list decides too.
    const held =
      tract.vertexFields.some((f) => f.name === name) &&
      tract.samples.some((s) => s.name === name && s.sourceId === volume.id);
    if (!held) await tracts.sample({ tractogramId: tract.id, sourceId: volume.id, op: 'value', name });
    return name;
  };

  const ensureRegions = async (tract: Tract, stale: () => boolean): Promise<void> => {
    const off = await ensureStructure(tract);
    const n = off.length - 1;
    for (const rule of recipe.rules) {
      if (rule.kind !== 'region' || hits.has(ruleKey(rule))) continue;
      const volume = volumeNamed(rule.volume);
      if (volume === null) {
        waitingForData = true;
        throw new Error(`Open the label volume ${rule.volume}: a rule needs it.`);
      }
      const field = await ensureLabels(tract, volume);
      const labels = new Set(rule.labels);
      const mask = new Uint8Array(n);
      for (const chunk of planChunks(off)) {
        if (stale()) return;
        const a = off[chunk.first]!;
        const count = off[chunk.last]! - a;
        const values = await readRange((f, c) => tracts.field(tract.id, 'vertex', field, f, c), a, count, 1);
        markRegion(mask, { offsets: off, first: chunk.first, last: chunk.last, pointBase: a }, values, labels, rule.endsOnly);
        await nextTask();
      }
      hits.set(ruleKey(rule), mask);
    }
  };

  const tractLayers = (tract: Tract): TractsLayer[] =>
    host.scene.layers().filter((l): l is TractsLayer => l.kind === 'tracts' && l.datasetId === tract.id);

  const showSpheres = (tract: Tract | null): void => {
    const spheres = recipe.rules.filter((r): r is SphereRule => r.kind === 'sphere');
    const existing = host.scene
      .layers()
      .find((l): l is PointsLayer => l.kind === 'points' && l.module === host.id);
    if (spheres.length === 0 || tract === null) {
      if (existing !== undefined) host.scene.removeLayer(existing.id);
      return;
    }
    const points = spheres.map((r, i) => ({
      name: `${r.effect} ${i + 1}`,
      position: r.center,
      radiusMm: r.radiusMm,
      color: r.effect === 'include' ? INCLUDE_RGBA : EXCLUDE_RGBA,
    }));
    if (existing !== undefined) {
      host.scene.updateLayer<PointsLayer>(existing.id, { points });
    } else {
      host.scene.addLayer({
        datasetId: tract.id,
        kind: 'points',
        name: 'Tract tools spheres',
        points,
        shape: 'sphere',
        radiusMm: spheres[0]!.radiusMm,
        color: INCLUDE_RGBA,
        showLabels: false,
        opacity: 0.35,
        pickable: false,
      } as Parameters<ModuleHost['scene']['addLayer']>[0]);
    }
  };

  const selectionActive = (): boolean =>
    recipe.rules.length > 0 ||
    recipe.minMm !== null ||
    recipe.maxMm !== null ||
    recipe.connectome.selected !== null;

  const computeSelection = async (stale: () => boolean): Promise<void> => {
    const tract = currentTract();
    if (tract === null) {
      set({ count: null });
      return;
    }
    checkCache(tract);
    showSpheres(tract);
    if (!selectionActive()) {
      selected = null;
      for (const layer of tractLayers(tract)) {
        if (layer.keepField !== undefined) host.scene.updateLayer<TractsLayer>(layer.id, { keepField: undefined });
      }
      if (tract.streamlineFields.some((f) => f.name === SELECTED_FIELD)) {
        await tracts.removeField(tract.id, 'streamline', SELECTED_FIELD);
      }
      set({ count: null, busy: null });
      return;
    }
    set({ busy: 'Selecting…' });
    await ensureGeometry(tract, false, stale);
    await ensureRegions(tract, stale);
    if (stale()) return;
    const n = (await ensureStructure(tract)).length - 1;
    const keep = new Set(recipe.rules.map(ruleKey));
    for (const key of [...hits.keys()]) if (!keep.has(key)) hits.delete(key);
    const masks = (effect: Effect): Uint8Array[] =>
      recipe.rules.filter((r) => r.effect === effect).map((r) => hits.get(ruleKey(r))!);
    const edge = recipe.connectome.selected;
    const extra = edge !== null && assign !== null ? edgeMask(assign.values, edge.a, edge.b) : null;
    const result = combine({
      n,
      includes: masks('include'),
      excludes: masks('exclude'),
      lengths: lengths ?? undefined,
      minMm: recipe.minMm,
      maxMm: recipe.maxMm,
      toleranceMm: tolerance,
      extra,
    });
    await nextTask();
    if (stale()) return;
    selected = result.selected;
    // The host transfers what it is given to the worker, and export needs this array afterwards.
    await tracts.setStreamlineField(tract.id, { name: SELECTED_FIELD, values: result.selected.slice() });
    for (const layer of tractLayers(tract)) {
      if (layer.keepField !== SELECTED_FIELD) {
        host.scene.updateLayer<TractsLayer>(layer.id, { keepField: SELECTED_FIELD });
      }
    }
    set({ count: result.count, busy: null });
  };

  const readStreamlineField = async (tract: Tract, name: string): Promise<Float32Array> =>
    readRange((f, c) => tracts.field(tract.id, 'streamline', name, f, c), 0, tract.nStreamlines, 1);

  const assignmentKey = (c: ConnectomeRecipe): string =>
    c.mode === 'pair' ? `pair:${c.pair}` : `${c.mode}:${c.volume}:${c.mode === 'radial' ? c.radiusMm : ''}`;

  const computeConnectome = async (stale: () => boolean): Promise<void> => {
    const c = recipe.connectome;
    const tract = currentTract();
    if (tract === null || !c.on) return;
    checkCache(tract);
    set({ busy: 'Assigning endpoints…' });
    if (assign === null || assign.key !== assignmentKey(c)) {
      let values: Int32Array;
      if (c.mode === 'pair') {
        if (c.pair === null || !hasPair(tract, c.pair)) {
          throw new Error(`This tractogram has no attached pair ${c.pair ?? ''}.`);
        }
        values = assignFromPair(
          await readStreamlineField(tract, `${c.pair}[0]`),
          await readStreamlineField(tract, `${c.pair}[1]`)
        );
      } else {
        const volume = volumeNamed(c.volume);
        if (volume === null) {
          waitingForData = true;
          throw new Error(`Open the label volume ${c.volume ?? 'for the nodes'}: the connectome needs it.`);
        }
        await ensureGeometry(tract, true, stale);
        if (stale() || endpoints === null) return;
        const sample = (world: Float32Array): Promise<Float32Array> =>
          host.scene.sampleVolume(volume.id, world, { order: 0 });
        values =
          c.mode === 'end'
            ? await assignEndVoxel(endpoints, sample)
            : await assignRadial(
                endpoints,
                { dims: volume.dims, affine: volume.affine, inverseAffine: volume.inverseAffine },
                c.radiusMm,
                sample
              );
      }
      if (stale()) return;
      assign = { key: assignmentKey(c), values };
    }
    const built = `${assign.key}|${c.weightField}|${c.metricField}|${c.edgeField}`;
    if (built === builtKey) {
      set({ busy: null });
      return;
    }
    const weights = c.weightField === null ? null : await readStreamlineField(tract, c.weightField);
    const metric = c.metricField === null ? null : await readStreamlineField(tract, c.metricField);
    if (stale()) return;
    const connectome = buildConnectome(assign.values, { weights, metric });
    await nextTask();
    if (c.edgeField) {
      await tracts.setStreamlineField(tract.id, { name: EDGE_FIELD, values: edgeCategories(assign.values).ids });
    } else if (tract.streamlineFields.some((f) => f.name === EDGE_FIELD)) {
      await tracts.removeField(tract.id, 'streamline', EDGE_FIELD);
    }
    builtKey = built;
    let assigned = 0;
    for (const e of connectome.edges.values()) assigned += e.count;
    set({
      connectome,
      nodes: connectome.nodes,
      assigned,
      matrixRevision: view.matrixRevision + 1,
      busy: null,
    });
  };

  const computeStats = async (stale: () => boolean): Promise<void> => {
    const tract = currentTract();
    if (tract === null) return;
    checkCache(tract);
    const todo = recipe.stats.filter(({ field, stat }) => !statsWritten.has(`${field}:${stat}`));
    if (todo.length === 0) return;
    const off = await ensureStructure(tract);
    const n = off.length - 1;
    for (const field of new Set(todo.map((t) => t.field))) {
      if (!tract.vertexFields.some((f) => f.name === field)) {
        throw new Error(`Sample ${field} again: this tractogram does not hold it now.`);
      }
      const wanted = todo.filter((t) => t.field === field).map((t) => t.stat);
      set({ busy: `Statistics of ${field}…` });
      const out = wanted.map(() => new Float32Array(n));
      for (const chunk of planChunks(off)) {
        if (stale()) return;
        const a = off[chunk.first]!;
        const count = off[chunk.last]! - a;
        const points = await readRange((f, c) => tracts.points(tract.id, f, c), a, count, 3);
        const values = await readRange((f, c) => tracts.field(tract.id, 'vertex', field, f, c), a, count, 1);
        const span = { offsets: off, first: chunk.first, last: chunk.last, pointBase: a };
        wanted.forEach((stat, i) => statInto(out[i]!, stat, span, points, values));
        await nextTask();
      }
      for (let i = 0; i < wanted.length; i += 1) {
        await tracts.setStreamlineField(tract.id, { name: `${field}:${wanted[i]}`, values: out[i]! });
        statsWritten.add(`${field}:${wanted[i]}`);
      }
    }
    set({ busy: null });
  };

  /** Run everything the recipe asks for that is not computed yet. Stale runs stop at their next read. */
  const compute = (): Promise<void> => {
    run += 1;
    const mine = run;
    const stale = (): boolean => mine !== run || disposed;
    return enqueue(async () => {
      if (stale() || !available) return;
      try {
        lastError = null;
        waitingForData = false;
        set({ message: null });
        await computeConnectome(stale);
        await computeStats(stale);
        await computeSelection(stale);
        refresh();
        persist();
      } catch (error) {
        fail(error);
      }
    });
  };

  const schedule = (): void => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void compute();
    }, DEBOUNCE_MS);
  };

  const flush = (): Promise<void> => {
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    return compute();
  };

  const update = (patch: Partial<Recipe>, now = false): Promise<void> | void => {
    recipe = { ...recipe, ...patch };
    set({ recipe });
    if (now) return flush();
    schedule();
  };

  const updateConnectome = (patch: Partial<ConnectomeRecipe>): void => {
    update({ connectome: { ...recipe.connectome, ...patch } });
  };

  const addSphere = (args: Record<string, unknown>): void => {
    const center = (args['center'] as [number, number, number] | undefined) ?? host.scene.cursor();
    const rule: SphereRule = {
      kind: 'sphere',
      effect: args['effect'] === 'exclude' ? 'exclude' : 'include',
      endsOnly: args['endsOnly'] === true,
      center: [center[0], center[1], center[2]],
      radiusMm: Number(args['radiusMm'] ?? view.sphereRadiusMm),
      test: args['test'] === 'point' ? 'point' : 'segment',
    };
    update({ rules: [...recipe.rules, rule] });
  };

  const addRegion = (args: Record<string, unknown>): void => {
    const volume = String(args['volume'] ?? '');
    if (volumeNamed(volume) === null) throw new Error(`${volume} is not an open label volume.`);
    const labels = Array.isArray(args['labels'])
      ? (args['labels'] as number[])
      : String(args['labels'] ?? '')
          .split(/[\s,]+/)
          .filter((s) => s !== '')
          .map(Number);
    if (labels.length === 0 || labels.some((l) => !Number.isInteger(l) || l <= 0)) {
      throw new Error('A region rule needs at least one positive label id.');
    }
    const rule: RegionRule = {
      kind: 'region',
      effect: args['effect'] === 'exclude' ? 'exclude' : 'include',
      endsOnly: args['endsOnly'] === true,
      volume,
      labels,
    };
    update({ rules: [...recipe.rules, rule] });
  };

  const addRegionAtCursor = async (args: Record<string, unknown>): Promise<void> => {
    const volume = volumeNamed(String(args['volume'] ?? recipe.connectome.volume ?? view.volumes[0]?.name ?? ''));
    if (volume === null) throw new Error('Open a label volume first.');
    const c = host.scene.cursor();
    const value = (await host.scene.sampleVolume(volume.id, Float32Array.of(c[0], c[1], c[2]), { order: 0 }))[0]!;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`The crosshair is in no region of ${volume.name}.`);
    addRegion({ ...args, volume: volume.name, labels: [Math.round(value)] });
  };

  const clearAll = async (): Promise<void> => {
    update({ rules: [], minMm: null, maxMm: null, connectome: { ...recipe.connectome, selected: null } });
    await flush();
    const tract = currentTract();
    if (tract === null) return;
    // The sampled labels were only ever a cache for rules that are now gone.
    await enqueue(async () => {
      for (const f of tract.vertexFields) {
        if (f.name.startsWith(`${OWN_PREFIX}labels:`)) await tracts.removeField(tract.id, 'vertex', f.name);
      }
    });
    refresh();
  };

  const settle = async (): Promise<void> => {
    if (debounce !== null) await flush();
    await queue;
  };

  const exportMatrix = async (path: string | null): Promise<Record<string, unknown>> => {
    await settle();
    if (view.connectome === null) throw new Error('Compute a connectome first.');
    const c = recipe.connectome;
    const volume = volumeNamed(c.volume);
    const ids = volume?.labelIds;
    const size = Math.max(ids !== undefined && ids.length > 0 ? ids[ids.length - 1]! : 0, ...view.nodes);
    const written = matrixCsv(view.connectome, size, c.weightField === null ? 'count' : 'weight');
    return write('matrix', path, written, `${basename(recipe.tract ?? 'tracts')}.connectome.csv`);
  };

  const exportSelection = async (path: string | null): Promise<Record<string, unknown>> => {
    await settle();
    const tract = currentTract();
    if (tract === null || selected === null || sourceIndex === null) {
      throw new Error('Select something first: there is no selection to export.');
    }
    const written = selectionTxt(selected, sourceIndex, tract.sourceStreamlines);
    return write('selection', path, written, `${basename(recipe.tract ?? 'tracts')}.selection.txt`);
  };

  const write = async (
    writer: string,
    path: string | null,
    written: { ok: true; text: string } | { ok: false; reason: string },
    fallback: string
  ): Promise<Record<string, unknown>> => {
    if (!written.ok) throw new Error(written.reason);
    let target = path;
    if (target === null) {
      const chosen = await host.files.saveDialog(writer, fallback);
      if (chosen === null) return { written: null };
      target = chosen.path;
    }
    const result = await host.files.writeText(target, written.text);
    if (!result.ok) throw new Error(result.error);
    set({ message: `Wrote ${basename(target)}.` });
    return { written: target, bytes: written.text.length };
  };

  const loadNames = async (path: string | null): Promise<void> => {
    let target = path;
    if (target === null) {
      const chosen = await host.files.openDialog('names');
      target = chosen?.[0] ?? null;
    }
    if (target === null) return;
    const text = await host.files.readText(target);
    if (text === null) {
      throw new Error(`Could not read ${basename(target)}: Tetravox reads .txt, .csv, .tsv and .json text up to 1 MiB.`);
    }
    const parsed = parseLookup(text);
    if (parsed.size === 0) throw new Error(`${basename(target)} has no id and name rows.`);
    names.clear();
    for (const [id, name] of parsed) names.set(id, name);
    persist();
    set({ message: `${parsed.size} node names from ${basename(target)}.`, matrixRevision: view.matrixRevision + 1 });
  };

  const report = (): Record<string, unknown> => ({
    tract: recipe.tract,
    held: view.held,
    selected: view.count,
    edges: view.connectome?.edges.size ?? null,
    nodes: view.nodes.length,
    assigned: view.assigned,
    message: view.message,
  });

  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    'add-sphere': addSphere,
    'add-region': addRegion,
    'add-region-at-cursor': addRegionAtCursor,
    clear: clearAll,
    'select-tract': async (a) => {
      await clearAll();
      recipe = { ...emptyRecipe(), names: recipe.names, tract: String(a['name']) };
      cacheKey = '';
      refresh();
      await flush();
    },
    'set-rule': (a) => {
      const index = Number(a['index']);
      update({
        rules: recipe.rules.map((r, i) => (i === index ? ({ ...r, ...(a['patch'] as object) } as Rule) : r)),
      });
    },
    'remove-rule': (a) => update({ rules: recipe.rules.filter((_, i) => i !== Number(a['index'])) }),
    'set-length': (a) => update({ minMm: toLength(a['minMm']), maxMm: toLength(a['maxMm']) }),
    'set-sphere-radius': (a) => set({ sphereRadiusMm: Number(a['radiusMm']) }),
    connectome: (a) => {
      const volume = (a['volume'] as string | undefined) ?? recipe.connectome.volume ?? view.volumes[0]?.name ?? null;
      const mode = (a['mode'] as NodeMode | undefined) ?? recipe.connectome.mode;
      updateConnectome({
        on: true,
        volume,
        mode,
        radiusMm: Number(a['radiusMm'] ?? recipe.connectome.radiusMm),
        pair: (a['pair'] as string | undefined) ?? recipe.connectome.pair ?? view.pairs[0] ?? null,
        ...(a['weightField'] === undefined ? {} : { weightField: a['weightField'] as string }),
        ...(a['metricField'] === undefined ? {} : { metricField: a['metricField'] as string }),
        ...(a['edgeField'] === undefined ? {} : { edgeField: a['edgeField'] === true }),
      });
    },
    'set-connectome': (a) => updateConnectome(a as Partial<ConnectomeRecipe>),
    'select-edge': (a) => {
      const edge = { a: Number(a['a']), b: a['b'] == null ? null : Number(a['b']) };
      const current = recipe.connectome.selected;
      const same = current !== null && current.a === edge.a && current.b === edge.b;
      updateConnectome({ selected: same ? null : edge });
    },
    'clear-edge': () => updateConnectome({ selected: null }),
    stats: (a) => {
      const field = String(a['field']);
      const requested = a['stats'] as Stat[] | string | undefined;
      const stats = (typeof requested === 'string' ? requested.split(/[\s,]+/) : (requested ?? STATS)) as Stat[];
      const bad = stats.filter((s) => !STATS.includes(s));
      if (bad.length > 0) throw new Error(`Unknown statistic ${bad.join(', ')}.`);
      const next = stats.map((stat) => ({ field, stat }));
      update({
        stats: [
          ...recipe.stats.filter((s) => !next.some((t) => t.field === s.field && t.stat === s.stat)),
          ...next,
        ],
      });
    },
    'export-matrix': (a) => exportMatrix((a['out'] as string | undefined) ?? null),
    'export-selection': (a) => exportSelection((a['out'] as string | undefined) ?? null),
    'load-names': (a) => loadNames((a['path'] as string | undefined) ?? null),
  };

  const invoke = async (id: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (!available) throw new Error(noTracts);
    const command = commands[id];
    if (command === undefined) throw new Error(`Unknown command ${id}`);
    return command(args);
  };

  const onScene = (): void => {
    if (!available) return;
    refresh();
    const tract = currentTract();
    if (tract === null) return;
    const generationMoved = `${tract.id}:${tract.generation}` !== cacheKey && cacheKey !== '';
    const pending = cacheKey === '' && (selectionActive() || recipe.connectome.on || recipe.stats.length > 0);
    if (generationMoved || pending || waitingForData) schedule();
  };

  host.subscribe(host.scene.on('datasets', onScene));
  host.subscribe(host.scene.on('layers', () => available && refresh()));
  host.subscribe(
    host.scene.on('sceneCleared', () => {
      cacheKey = '';
      recipe = emptyRecipe();
      names.clear();
      set({ count: null, connectome: null, nodes: [], assigned: 0, message: null });
      refresh();
    })
  );

  if (available) refresh();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => view,
    async run(id, args) {
      try {
        await invoke(id, args);
      } catch (error) {
        fail(error);
        host.ui.toast('warn', error instanceof Error ? error.message : String(error));
      }
    },
    async operation(op, args) {
      const result = await invoke(op, args);
      await flush();
      await queue;
      if (lastError !== null) throw new Error(lastError);
      return { ...report(), ...(typeof result === 'object' && result !== null ? (result as object) : {}) };
    },
    async restore(block) {
      if (!available) return;
      recipe = { ...emptyRecipe(), ...(block.data as Partial<Recipe>) };
      names.clear();
      for (const [id, name] of recipe.names ?? []) names.set(id, name);
      cacheKey = '';
      assign = null;
      refresh();
      if (currentTract() !== null) await flush();
    },
    nodeName: (id) => names.get(id) ?? String(id),
    labelName(volume, id) {
      const own = names.get(id);
      if (own !== undefined) return own;
      const v = volumeNamed(volume);
      return v?.labelTable?.byId.get(id)?.name ?? String(id);
    },
    settled: settle,
    dispose() {
      disposed = true;
      if (debounce !== null) clearTimeout(debounce);
      listeners.clear();
    },
  };
}

const toLength = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

