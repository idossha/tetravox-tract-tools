// State and every command: the panel is chrome over this, and a job file reaches the same functions (§13.6).

import { MODULE_HOST_VERSION } from '@tetravox/module-sdk';
import type { Dataset, ExtensionBlock, Layer, ModuleHost, ModulePlacement, TractScanChunk } from '@tetravox/module-sdk';
import { runExport, uniqueName } from './exporter';
import type { ExportOutcome, ExportPlanItem } from './exporter';
import { nextTask, sampleAll } from './kernels/chunks';
import {
  assignEndVoxel,
  assignFromPair,
  assignRadial,
  buildConnectome,
  edgeCategories,
  edgeKey,
  edgeMask,
  edgesMask,
  nextShown,
  nodeStats,
  summarize,
} from './kernels/connectome';
import type { Connectome, Edge, EdgeMetric, EdgePair, NodeStat, ShowAction } from './kernels/connectome';
import { dateStamp, DEFAULT_CHOOSE, fromToPairs, pickPair } from './kernels/choose';
import type { ChooseRecipe } from './kernels/choose';
import { edgesCsv, matrixCsv, matrixSvg, nodesCsv, selectionTxt } from './kernels/export';
import { parseLookup } from './kernels/lut';
import { Fingerprint, methodsText } from './kernels/methods';
import type { MethodsInput } from './kernels/methods';
import {
  combine,
  histogramOf,
  lengthsInto,
  lengthToleranceMm,
  markSphere,
  medianOf,
  parseHeader,
  regionHits,
  RegionIndexBuilder,
  spanOf,
  sphereHits,
  sphereKey,
} from './kernels/select';
import type { Effect, Histogram, RegionIndex, RegionRule, Rule, RuleMode, SphereRule } from './kernels/select';
import { outsideIsZero, STATS, statInto } from './kernels/stats';
import type { Stat } from './kernels/stats';
import { manifest } from './manifest';
import { renderMatrixPng } from './ui/drawMatrix';

type Tract = Extract<Dataset, { kind: 'tractogram' }>;
type Volume = Extract<Dataset, { kind: 'volume' }>;
type TractsLayer = Extract<Layer, { kind: 'tracts' }>;
type PointsLayer = Extract<Layer, { kind: 'points' }>;

export const SELECTED_FIELD = 'tract-tools:selected';
export const EDGE_FIELD = 'tract-tools:edge';
const OWN_PREFIX = 'tract-tools:';
const DEBOUNCE_MS = 150;
const HIST_BINS = 48;
const INCLUDE_RGBA: [number, number, number, number] = [0.25, 0.8, 0.45, 1];
const EXCLUDE_RGBA: [number, number, number, number] = [0.9, 0.3, 0.3, 1];
const BLOCK_NAMES_CAP = 64 * 1024;

export type NodeMode = 'end' | 'radial' | 'pair';
export type ValueSource = { kind: 'volume' | 'vertex' | 'streamline'; name: string };

export interface ConnectionSpec {
  volume: string | null;
  mode: NodeMode;
  radiusMm: number;
  pair: string | null;
  a: number;
  b: number | null;
  /** Several connections at once; `a` and `b` then mean nothing. */
  pairs?: EdgePair[];
}

export interface SavedTract {
  name: string;
  rules: Rule[];
  minMm: number | null;
  maxMm: number | null;
  connection: ConnectionSpec | null;
  count: number;
}

export interface ConnectomeRecipe {
  volume: string | null;
  mode: NodeMode;
  radiusMm: number;
  /** `name` of an attached `name[0]`, `name[1]` pair. */
  pair: string | null;
  weightField: string | null;
  value: ValueSource | null;
  show: EdgeMetric;
  edgeField: boolean;
  /** Built at least once, so a restore rebuilds it. */
  on: boolean;
  /** From and To; while From holds a region, they rewrite `shown`. */
  choose: ChooseRecipe;
  /** The chosen connections; null is every streamline, unfiltered. */
  shown: EdgePair[] | null;
}

export interface ExportOptions {
  matrices: boolean;
  edges: boolean;
  nodes: boolean;
  figure: boolean;
  tracts: boolean;
  streamlines: boolean;
  record: boolean;
  symmetric: boolean;
}

export interface Recipe {
  tract: string | null;
  rules: Rule[];
  minMm: number | null;
  maxMm: number | null;
  sphereTest: 'point' | 'segment';
  connectome: ConnectomeRecipe;
  saved: SavedTract[];
  stats: { field: string; stat: Stat }[];
  names: [number, string][];
  namesFrom: string | null;
  exportOptions: ExportOptions;
}

const emptyRecipe = (): Recipe => ({
  tract: null,
  rules: [],
  minMm: null,
  maxMm: null,
  sphereTest: 'point',
  connectome: {
    volume: null,
    mode: 'radial',
    radiusMm: 4,
    pair: null,
    weightField: null,
    value: null,
    show: 'count',
    edgeField: false,
    on: false,
    choose: DEFAULT_CHOOSE,
    shown: null,
  },
  saved: [],
  stats: [],
  names: [],
  namesFrom: null,
  exportOptions: { matrices: true, edges: true, nodes: true, figure: false, tracts: true, streamlines: true, record: true, symmetric: false },
});

/** A block from 0.1.0 has `endsOnly` on its rules and `metricField`, `log` on its connectome. */
export function upgradeRecipe(data: unknown): Recipe {
  const raw = (data ?? {}) as Partial<Recipe> & { rules?: (Rule & { endsOnly?: boolean })[] };
  const base = emptyRecipe();
  const old = (raw.connectome ?? {}) as Partial<ConnectomeRecipe> & { metricField?: string | null };
  return {
    ...base,
    ...raw,
    rules: (raw.rules ?? []).map(upgradeRule),
    saved: (raw.saved ?? []).map((s) => ({ ...s, rules: s.rules.map(upgradeRule) })),
    connectome: upgradeConnectome(base.connectome, old),
    exportOptions: { ...base.exportOptions, ...raw.exportOptions },
  };
}

/** A scene saved before several connections could be chosen held one `selected`. */
function upgradeConnectome(base: ConnectomeRecipe, old: Partial<ConnectomeRecipe> & { metricField?: string | null; selected?: { a: number; b: number | null } | null }): ConnectomeRecipe {
  const { metricField, selected, ...rest } = old;
  const was = selected ?? null;
  return {
    ...base,
    ...rest,
    value: rest.value ?? (metricField != null ? { kind: 'streamline', name: metricField } : null),
    choose: { ...base.choose, ...rest.choose, ...(was !== null && was.b === null ? { from: [was.a] } : {}) },
    shown: rest.shown ?? (was !== null && was.b !== null ? [[was.a, was.b]] : null),
  };
}

function upgradeRule(rule: Rule & { endsOnly?: boolean }): Rule {
  const { endsOnly, ...rest } = rule;
  return { ...rest, mode: rest.mode ?? (endsOnly === true ? 'ends' : 'through') } as Rule;
}

export interface Progress {
  label: string;
  fraction: number;
}

export interface View {
  available: boolean;
  recipe: Recipe;
  tab: string;
  placement: ModulePlacement;
  tracts: { id: string; name: string }[];
  tractId: string | null;
  held: number;
  total: number;
  /** The whole-file scan has finished. */
  ready: boolean;
  /** Kept out of `total`; null with no filter. */
  count: number | null;
  /** Kept and held. */
  drawnKept: number | null;
  medianMm: number | null;
  histogram: Histogram | null;
  sphereRadiusMm: number;
  labelVolumes: { id: string; name: string; labels: number[] }[];
  scalarVolumes: string[];
  vertexFields: string[];
  streamlineFields: string[];
  pairs: string[];
  /** A multi-label ROI file waiting for its label to be chosen. */
  choosing: string | null;
  progress: Progress | null;
  message: string | null;
  connectome: Connectome | null;
  /** The matrix's axes: every region in the atlas, plus any id the pair names. */
  regions: number[];
  /** N of tck2connectome's matrix. */
  matrixSize: number;
  summary: { edges: number; density: number; assignedPct: number } | null;
  /** Bumped when the matrix's content or names change, so the canvas redraws once. */
  matrixRevision: number;
  selectedEdge: Edge | null;
  selectedRegion: NodeStat | null;
  /** Where the regions' names come from, in words; null for numbers. */
  namesFrom: string | null;
  exportResult: ExportOutcome | null;
  exporting: boolean;
}

export interface TractModel {
  subscribe(listener: () => void): () => void;
  state(): View;
  run(id: string, args?: Record<string, unknown>): Promise<void>;
  operation(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  restore(block: ExtensionBlock): Promise<void>;
  /** A region's name in that atlas, or in the network's when none is named. */
  name(id: number, volume?: string | null): string;
  /** A rule in words. */
  ruleName(rule: Rule): string;
  metricUnit(metric?: EdgeMetric): string;
  valueLabel(): string | null;
  edgeLengths(edge: Edge): Float32Array;
  settled(): Promise<void>;
  dispose(): void;
}

const noTracts = 'Tract tools needs a newer Tetravox: this build cannot read a whole tractogram (scene.tracts.scan).';

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const stemName = (path: string): string => basename(path).replace(/\.(nii\.gz|nii|mgz|mgh|tsf|txt|csv|tsv)$/i, '');

/** Everything computed from one open file, by its place in the file. The budget does not touch any of it. */
interface FileCache {
  datasetId: string;
  n: number;
  points: number;
  lengths: Float32Array;
  ends: Float32Array;
  fingerprint: string;
  tolerance: number;
  header: Map<string, string>;
  spheres: Map<string, Uint8Array>;
  regions: Map<string, RegionIndex>;
  /** Per-streamline arrays, by source key. */
  series: Map<string, Float32Array>;
  assign: Map<string, Int32Array>;
}

interface ListedTract {
  name: string;
  file: string;
  spec: Pick<SavedTract, 'rules' | 'minMm' | 'maxMm'>;
  connection: ConnectionSpec | null;
  count: number;
  keep: Uint8Array;
}

/** One reader of a scan: commits only after the scan resolved, so a changed file leaves nothing behind. */
interface Reader {
  fields?: string[];
  chunk(chunk: TractScanChunk): void | Promise<void>;
  commit(): void;
}

export function createModel(host: ModuleHost): TractModel {
  const tracts = host.scene.tracts;
  const available = tracts !== undefined && typeof tracts.scan === 'function';
  const listeners = new Set<() => void>();
  let recipe = emptyRecipe();
  let view: View = {
    available,
    recipe,
    tab: host.ui.panelTab?.() ?? 'network',
    placement: host.ui.placement?.() ?? 'docked',
    tracts: [],
    tractId: null,
    held: 0,
    total: 0,
    ready: false,
    count: null,
    drawnKept: null,
    medianMm: null,
    histogram: null,
    sphereRadiusMm: 5,
    labelVolumes: [],
    scalarVolumes: [],
    vertexFields: [],
    streamlineFields: [],
    pairs: [],
    choosing: null,
    progress: null,
    message: available ? null : noTracts,
    connectome: null,
    regions: [],
    matrixSize: 0,
    summary: null,
    matrixRevision: 0,
    selectedEdge: null,
    selectedRegion: null,
    namesFrom: null,
    exportResult: null,
    exporting: false,
  };
  const names = new Map<number, string>();

  let cache: FileCache | null = null;
  let builtKey = '';
  let keep: Uint8Array | null = null;
  let sourceIndex: Uint32Array | null = null;
  let sourceKey = '';
  /** Which `recipe.stats` are written to the held streamlines of which generation. */
  let statsWritten = new Set<string>();

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let run = 0;
  let disposed = false;
  let lastError: string | null = null;
  let scanAbort: AbortController | null = null;
  /** The user cancelled a scan: nothing starts another until they ask for something. */
  let cancelled = false;
  // A rule names a volume that is not open yet; the next dataset to land may be it.
  let waitingForData = false;

  const set = (patch: Partial<View>): void => {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };

  const allTracts = (): Tract[] => host.scene.datasets().filter((d): d is Tract => d.kind === 'tractogram');
  const allVolumes = (): Volume[] => host.scene.datasets().filter((d): d is Volume => d.kind === 'volume');
  const labelVolumes = (): Volume[] => allVolumes().filter((d) => d.isLabel);
  const currentTract = (): Tract | null => {
    const list = allTracts();
    return list.find((d) => d.name === recipe.tract) ?? (recipe.tract === null ? (list[0] ?? null) : null);
  };
  const volumeNamed = (name: string | null): Volume | null => allVolumes().find((d) => d.name === name) ?? null;
  const atlasIds = (v: Volume | null): number[] => [...(v?.labelIds ?? [])].filter((id) => id > 0);

  const hasPair = (d: Tract, name: string): boolean =>
    d.streamlineFields.some((f) => f.name === `${name}[0]`) && d.streamlineFields.some((f) => f.name === `${name}[1]`);

  const regionsOf = (connectome: Connectome | null): number[] => {
    const ids = recipe.connectome.mode === 'pair' ? [] : atlasIds(volumeNamed(recipe.connectome.volume));
    return [...new Set([...ids, ...(connectome?.nodes ?? [])])].sort((p, q) => p - q);
  };

  /** What the panel lists from the scene. Cheap: no reads. */
  const refresh = (): void => {
    const tract = currentTract();
    if (tract !== null && recipe.tract === null) recipe = { ...recipe, tract: tract.name };
    const streamline = tract?.streamlineFields ?? [];
    const pairs = streamline.flatMap((f) => {
      const m = /^(.*)\[0\]$/.exec(f.name);
      return m !== null && tract !== null && hasPair(tract, m[1]!) ? [m[1]!] : [];
    });
    const namesFrom = namesSource();
    set({
      recipe,
      tracts: allTracts().map((d) => ({ id: d.id, name: d.name })),
      tractId: tract?.id ?? null,
      held: tract?.nStreamlines ?? 0,
      total: tract?.sourceStreamlines ?? 0,
      labelVolumes: labelVolumes().map((d) => ({ id: d.id, name: d.name, labels: atlasIds(d) })),
      scalarVolumes: allVolumes().filter((d) => !d.isLabel).map((d) => d.name),
      vertexFields: tract?.vertexFields.filter((f) => !isOwnOrSampled(tract, f.name)).map((f) => f.name) ?? [],
      streamlineFields: streamline.filter((f) => !f.name.startsWith(OWN_PREFIX) && !f.builtin).map((f) => f.name),
      pairs,
      namesFrom,
      matrixRevision: namesFrom === view.namesFrom ? view.matrixRevision : view.matrixRevision + 1,
    });
  };

  const isOwnOrSampled = (tract: Tract, name: string): boolean =>
    name.startsWith(OWN_PREFIX) || tract.samples.some((s) => s.name === name);

  const persist = (): void => {
    let namesList = [...names.entries()];
    if (JSON.stringify(namesList).length > BLOCK_NAMES_CAP) namesList = [];
    recipe = { ...recipe, names: namesList };
    try {
      host.scene.setBlock<Recipe>(recipe);
    } catch (error) {
      set({ message: `This session's rules could not be stored in the scene: ${errorText(error)}` });
    }
  };

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const fail = (error: unknown): void => {
    lastError = errorText(error);
    set({ progress: null, message: lastError });
  };

  const seriesKey = (source: ValueSource): string => {
    if (source.kind !== 'volume') return `${source.kind}:${source.name}`;
    const v = volumeNamed(source.name);
    if (v === null) {
      waitingForData = true;
      throw new Error(`Open ${source.name}: the value needs it.`);
    }
    return `volume:${v.id}`;
  };

  const baseReader = (tract: Tract): Reader => {
    const n = tract.sourceStreamlines;
    const lengths = new Float32Array(n);
    const ends = new Float32Array(n * 6);
    const print = new Fingerprint();
    let points = 0;
    return {
      chunk(c) {
        const count = c.offsets.length - 1;
        lengthsInto(lengths.subarray(c.firstSource, c.firstSource + count), spanOf(c.offsets), c.positions);
        for (let i = 0; i < count; i += 1) {
          const a = c.offsets[i]!;
          const b = c.offsets[i + 1]!;
          if (a === b) continue;
          ends.set(c.positions.subarray(a * 3, a * 3 + 3), (c.firstSource + i) * 6);
          ends.set(c.positions.subarray((b - 1) * 3, b * 3), (c.firstSource + i) * 6 + 3);
        }
        print.add(new Uint32Array(c.positions.buffer, c.positions.byteOffset, c.positions.length));
        points += c.positions.length / 3;
      },
      commit() {
        const header = parseHeader(tract.headerJson);
        cache = {
          datasetId: tract.id,
          n,
          points,
          lengths,
          ends,
          fingerprint: print.hex(),
          tolerance: lengthToleranceMm(header),
          header,
          spheres: new Map(),
          regions: new Map(),
          series: new Map(),
          assign: new Map(),
        };
      },
    };
  };

  const sphereReader = (n: number, sphere: Pick<SphereRule, 'center' | 'radiusMm' | 'test'>): Reader => {
    const hits = new Uint8Array(n);
    return {
      chunk(c) {
        const count = c.offsets.length - 1;
        markSphere(hits.subarray(c.firstSource, c.firstSource + count), spanOf(c.offsets), c.positions, sphere);
      },
      commit: () => void cache!.spheres.set(sphereKey(sphere), hits),
    };
  };

  const regionReader = (n: number, volume: Volume): Reader => {
    const builder = new RegionIndexBuilder(n);
    const sample = (w: Float32Array): Promise<Float32Array> => host.scene.sampleVolume(volume.id, w, { order: 0 });
    return {
      async chunk(c) {
        builder.add(c.firstSource, c.offsets, await sampleAll(sample, c.positions));
      },
      commit: () => void cache!.regions.set(volume.id, builder.finish()),
    };
  };

  /** `tcksample -stat_tck mean`, or any other statistic of a per-point source. */
  const pointStatReader = (n: number, key: string, stat: Stat, read: (c: TractScanChunk) => Float32Array | Promise<Float32Array>, fields?: string[]): Reader => {
    const out = new Float32Array(n);
    return {
      ...(fields === undefined ? {} : { fields }),
      async chunk(c) {
        const count = c.offsets.length - 1;
        statInto(out.subarray(c.firstSource, c.firstSource + count), stat, spanOf(c.offsets), c.positions, await read(c));
      },
      commit: () => void cache!.series.set(key, out),
    };
  };

  const fieldReader = (n: number, key: string, field: string): Reader => {
    const out = new Float32Array(n);
    return {
      fields: [field],
      chunk(c) {
        out.set(c.streamlineFields[field]!, c.firstSource);
      },
      commit: () => void cache!.series.set(key, out),
    };
  };

  const valueReader = (n: number, tract: Tract, source: ValueSource): Reader => {
    const key = seriesKey(source);
    if (source.kind === 'streamline') {
      if (!tract.streamlineFields.some((f) => f.name === source.name)) throw new Error(`Attach ${source.name} again: this tractogram does not hold it now.`);
      return fieldReader(n, key, source.name);
    }
    if (source.kind === 'vertex') {
      return pointStatReader(n, key, 'mean', (c) => c.vertexFields[source.name]!, [source.name]);
    }
    const volume = volumeNamed(source.name)!;
    const sample = (w: Float32Array): Promise<Float32Array> => host.scene.sampleVolume(volume.id, w, { order: 1 });
    return pointStatReader(n, key, 'mean', async (c) => outsideIsZero(await sampleAll(sample, c.positions)));
  };

  /** Rules and connections the recipe holds, saved tracts included when asked. */
  const specsOf = (withSaved: boolean): Pick<SavedTract, 'rules'>[] => [
    { rules: recipe.rules },
    ...(withSaved ? recipe.saved : []),
  ];

  /** Everything still missing, read in one pass over the file. */
  const scan = async (tract: Tract, label: string, withSaved = false): Promise<void> => {
    if (cache !== null && cache.datasetId !== tract.id) {
      cache = null;
      builtKey = '';
    }
    const n = tract.sourceStreamlines;
    const readers: Reader[] = [];
    const base = cache === null ? baseReader(tract) : null;
    if (base !== null) readers.push(base);
    const seen = new Set<string>();
    for (const { rules } of specsOf(withSaved)) {
      for (const rule of rules) {
        if (rule.kind === 'sphere') {
          const key = `s:${sphereKey(rule)}`;
          if (!seen.has(key) && !cache?.spheres.has(sphereKey(rule))) readers.push(sphereReader(n, rule));
          seen.add(key);
        } else {
          const volume = volumeNamed(rule.volume);
          if (volume === null) {
            waitingForData = true;
            throw new Error(`Open ${rule.volume}: a rule needs it.`);
          }
          if (!seen.has(volume.id) && !cache?.regions.has(volume.id)) readers.push(regionReader(n, volume));
          seen.add(volume.id);
        }
      }
    }
    const c = recipe.connectome;
    if (c.on) {
      const weight = c.weightField;
      if (weight !== null && !cache?.series.has(`streamline:${weight}`)) {
        if (!tract.streamlineFields.some((f) => f.name === weight)) throw new Error(`Attach ${weight} again: this tractogram does not hold it now.`);
        readers.push(fieldReader(n, `streamline:${weight}`, weight));
      }
      if (c.value !== null && !cache?.series.has(seriesKey(c.value))) readers.push(valueReader(n, tract, c.value));
      if (c.mode === 'pair' && c.pair !== null) {
        if (!hasPair(tract, c.pair)) throw new Error(`This tractogram has no attached pair ${c.pair}.`);
        for (const i of [0, 1]) {
          const field = `${c.pair}[${i}]`;
          if (!cache?.series.has(`streamline:${field}`)) readers.push(fieldReader(n, `streamline:${field}`, field));
        }
      }
    }
    for (const { field, stat } of recipe.stats) {
      if (!cache?.series.has(`stat:${field}:${stat}`)) {
        readers.push(pointStatReader(n, `stat:${field}:${stat}`, stat, (ch) => ch.vertexFields[field]!, [field]));
      }
    }
    if (readers.length === 0) return;
    const fields = [...new Set(readers.flatMap((r) => r.fields ?? []))];
    scanAbort = new AbortController();
    set({ progress: { label, fraction: 0 } });
    try {
      await tracts.scan(
        tract.id,
        async (chunk) => {
          for (const reader of readers) await reader.chunk(chunk);
          set({ progress: { label, fraction: (chunk.firstSource + chunk.offsets.length - 1) / n } });
          // Give the panel a turn even when a chunk needed no sampling.
          await nextTask();
        },
        { signal: scanAbort.signal, fields }
      );
    } finally {
      scanAbort = null;
    }
    // `base` makes the cache the rest commit into.
    base?.commit();
    for (const reader of readers) if (reader !== base) reader.commit();
    set({ ready: true, histogram: histogramOf(cache!.lengths, HIST_BINS) });
  };

  const tractLayers = (tract: Tract): TractsLayer[] =>
    host.scene.layers().filter((l): l is TractsLayer => l.kind === 'tracts' && l.datasetId === tract.id);

  const showSpheres = (tract: Tract | null): void => {
    const spheres = recipe.rules.filter((r): r is SphereRule => r.kind === 'sphere');
    const existing = host.scene.layers().find((l): l is PointsLayer => l.kind === 'points' && l.module === host.id);
    if (spheres.length === 0 || tract === null) {
      if (existing !== undefined) host.scene.removeLayer(existing.id);
      return;
    }
    const points = spheres.map((r, i) => ({
      name: `${r.effect === 'include' ? 'Keep' : 'Remove'} ${i + 1}`,
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

  const filterActive = (): boolean =>
    recipe.rules.length > 0 || recipe.minMm !== null || recipe.maxMm !== null || currentConnection() !== null;

  const ruleMask = (rule: Rule): Uint8Array => {
    const c = cache!;
    if (rule.kind === 'sphere') return sphereHits(c.spheres.get(sphereKey(rule))!, rule.mode);
    return regionHits(c.regions.get(volumeNamed(rule.volume)!.id)!, rule.labels, rule.mode);
  };

  const assignmentKey = (c: Pick<ConnectomeRecipe, 'mode' | 'volume' | 'radiusMm' | 'pair'>): string =>
    c.mode === 'pair' ? `pair:${c.pair}` : `${c.mode}:${volumeNamed(c.volume)?.id ?? c.volume}:${c.mode === 'radial' ? c.radiusMm : ''}`;

  const assignment = async (c: Pick<ConnectomeRecipe, 'mode' | 'volume' | 'radiusMm' | 'pair'>): Promise<Int32Array> => {
    const file = cache!;
    const key = assignmentKey(c);
    const held = file.assign.get(key);
    if (held !== undefined) return held;
    let values: Int32Array;
    if (c.mode === 'pair') {
      values = assignFromPair(file.series.get(`streamline:${c.pair}[0]`)!, file.series.get(`streamline:${c.pair}[1]`)!);
    } else {
      const volume = volumeNamed(c.volume);
      if (volume === null) {
        waitingForData = true;
        throw new Error(`Open ${c.volume ?? 'an atlas'}: the network needs it.`);
      }
      set({ progress: { label: 'Assigning streamline ends to regions…', fraction: 0.5 } });
      const sample = (world: Float32Array): Promise<Float32Array> => host.scene.sampleVolume(volume.id, world, { order: 0 });
      values =
        c.mode === 'end'
          ? await assignEndVoxel(file.ends, sample)
          : await assignRadial(file.ends, { dims: volume.dims, affine: volume.affine, inverseAffine: volume.inverseAffine }, c.radiusMm, sample);
    }
    file.assign.set(key, values);
    return values;
  };

  const priorColor = new Map<string, Pick<TractsLayer, 'colorMode' | 'groupField'>>();

  /** What From and To say now. With no From, the clicks and ticks as they stand. */
  const derivedShown = (choose: ChooseRecipe): EdgePair[] | null =>
    view.connectome === null || choose.from.length === 0 ? recipe.connectome.shown : fromToPairs([...view.connectome.edges.values()], choose.from, choose.to, choose.minN);

  const buildNetwork = async (stale: () => boolean): Promise<void> => {
    const c = recipe.connectome;
    if (!c.on) return;
    const tract = currentTract();
    if (tract === null) return;
    const assign = await assignment(c);
    if (stale()) return;
    const file = cache!;
    const valueKey = c.value === null ? null : seriesKey(c.value);
    const built = `${assignmentKey(c)}|${c.weightField}|${valueKey}`;
    if (built !== builtKey) {
      const connectome = buildConnectome(assign, file.lengths, {
        weights: c.weightField === null ? null : file.series.get(`streamline:${c.weightField}`)!,
        values: valueKey === null ? null : file.series.get(valueKey)!,
      });
      await nextTask();
      builtKey = built;
      const regions = regionsOf(connectome);
      set({
        connectome,
        regions,
        matrixSize: Math.max(0, ...regions),
        summary: summarize(connectome, regions.length, file.n),
        matrixRevision: view.matrixRevision + 1,
      });
      // From and To follow the connections they read.
      recipe = { ...recipe, connectome: { ...recipe.connectome, shown: derivedShown(recipe.connectome.choose) } };
      set({ recipe });
    }
    if (c.edgeField) {
      const structure = await heldIndex(tract);
      const ids = edgeCategories(assign).ids;
      const held = new Float32Array(structure.length);
      for (let i = 0; i < held.length; i += 1) held[i] = ids[structure[i]!]!;
      await tracts.setStreamlineField(tract.id, { name: EDGE_FIELD, values: held });
      for (const layer of tractLayers(tract)) {
        if (layer.groupField === EDGE_FIELD && layer.colorMode === 'group') continue;
        priorColor.set(layer.id, { colorMode: layer.colorMode, groupField: layer.groupField });
        host.scene.updateLayer<TractsLayer>(layer.id, { colorMode: 'group', groupField: EDGE_FIELD });
      }
    } else if (tract.streamlineFields.some((f) => f.name === EDGE_FIELD)) {
      for (const layer of tractLayers(tract)) {
        if (layer.groupField !== EDGE_FIELD) continue;
        host.scene.updateLayer<TractsLayer>(layer.id, priorColor.get(layer.id) ?? { colorMode: 'direction', groupField: undefined });
        priorColor.delete(layer.id);
      }
      await tracts.removeField(tract.id, 'streamline', EDGE_FIELD);
    }
  };

  const heldIndex = async (tract: Tract): Promise<Uint32Array> => {
    const key = `${tract.id}:${tract.generation}`;
    if (sourceKey !== key || sourceIndex === null) {
      sourceIndex = (await tracts.structure(tract.id)).sourceIndex;
      sourceKey = key;
      statsWritten = new Set();
    }
    return sourceIndex;
  };

  const writeStats = async (tract: Tract): Promise<void> => {
    if (recipe.stats.length === 0) return;
    const index = await heldIndex(tract);
    for (const { field, stat } of recipe.stats) {
      const name = `${field}:${stat}`;
      if (statsWritten.has(name)) continue;
      const all = cache!.series.get(`stat:${name}`)!;
      const values = new Float32Array(index.length);
      for (let i = 0; i < values.length; i += 1) values[i] = all[index[i]!]!;
      await tracts.setStreamlineField(tract.id, { name, values });
      statsWritten.add(name);
    }
  };

  const describeSelection = (): void => {
    const c = view.connectome;
    const { shown, choose } = recipe.connectome;
    const edge = c !== null && shown !== null && shown.length === 1 ? (c.edges.get(edgeKey(shown[0]![0], shown[0]![1])) ?? null) : null;
    const one = choose.from.length === 1 && choose.to.length === 0 ? choose.from[0]! : null;
    set({
      selectedEdge: edge,
      selectedRegion: c !== null && one !== null ? (nodeStats(c).find((x) => x.id === one) ?? { id: one, degree: 0, strength: 0, weight: 0 }) : null,
    });
  };

  const maskFor = async (spec: Pick<SavedTract, 'rules' | 'minMm' | 'maxMm'> & { connection: ConnectionSpec | null }): Promise<{ keep: Uint8Array; count: number }> => {
    const file = cache!;
    const conn = spec.connection;
    const assign = conn === null ? null : await assignment(conn);
    const extra = conn === null ? null : conn.pairs !== undefined ? edgesMask(assign!, conn.pairs) : edgeMask(assign!, conn.a, conn.b);
    return combine({
      n: file.n,
      includes: spec.rules.filter((r) => r.effect === 'include').map(ruleMask),
      excludes: spec.rules.filter((r) => r.effect === 'exclude').map(ruleMask),
      lengths: spec.minMm === null && spec.maxMm === null ? undefined : file.lengths,
      minMm: spec.minMm,
      maxMm: spec.maxMm,
      toleranceMm: file.tolerance,
      extra,
    });
  };

  const currentConnection = (): ConnectionSpec | null => {
    const { shown, volume, mode, radiusMm, pair } = recipe.connectome;
    return shown === null ? null : { volume, mode, radiusMm, pair, a: 0, b: null, pairs: shown };
  };

  const applyFilter = async (stale: () => boolean): Promise<void> => {
    const tract = currentTract();
    if (tract === null) {
      set({ count: null, drawnKept: null, medianMm: null });
      return;
    }
    showSpheres(tract);
    const file = cache!;
    if (!filterActive()) {
      keep = null;
      for (const layer of tractLayers(tract)) {
        if (layer.keepField !== undefined) host.scene.updateLayer<TractsLayer>(layer.id, { keepField: undefined });
      }
      if (tract.streamlineFields.some((f) => f.name === SELECTED_FIELD)) {
        await tracts.removeField(tract.id, 'streamline', SELECTED_FIELD);
      }
      set({ count: null, drawnKept: null, medianMm: medianOf(file.lengths) });
      return;
    }
    const result = await maskFor({ rules: recipe.rules, minMm: recipe.minMm, maxMm: recipe.maxMm, connection: currentConnection() });
    if (stale()) return;
    keep = result.keep;
    const kept = new Float32Array(result.count);
    let at = 0;
    for (let s = 0; s < file.n; s += 1) if (result.keep[s] === 1) kept[at++] = file.lengths[s]!;
    const index = await heldIndex(tract);
    const values = new Float32Array(index.length);
    let drawn = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (result.keep[index[i]!] === 1) {
        values[i] = 1;
        drawn += 1;
      }
    }
    await tracts.setStreamlineField(tract.id, { name: SELECTED_FIELD, values });
    for (const layer of tractLayers(tract)) {
      if (layer.keepField !== SELECTED_FIELD) host.scene.updateLayer<TractsLayer>(layer.id, { keepField: SELECTED_FIELD });
    }
    set({ count: result.count, drawnKept: drawn, medianMm: medianOf(kept) });
  };

  /** Run everything the recipe asks for that is not computed yet. */
  const compute = (): Promise<void> => {
    run += 1;
    const mine = run;
    const stale = (): boolean => mine !== run || disposed;
    return enqueue(async () => {
      if (stale() || !available || cancelled) return;
      const tract = currentTract();
      if (tract === null) {
        set({ count: null });
        return;
      }
      const generation = tract.generation;
      try {
        lastError = null;
        waitingForData = false;
        set({ message: null });
        await scan(tract, cache === null ? 'Reading the whole tractogram…' : 'Reading streamlines…');
        if (stale()) return;
        await buildNetwork(stale);
        if (stale()) return;
        await writeStats(tract);
        await applyFilter(stale);
        describeSelection();
        set({ progress: null });
        refresh();
        persist();
      } catch (error) {
        if (scanAbortedByUser(error)) {
          cancelled = true;
          set({ progress: null, message: 'Cancelled. Nothing was changed; change a rule or press Build to start again.' });
        } else if (currentTract()?.generation !== generation) {
          // A budget change ends a scan; the file has not changed, so read it again.
          schedule();
        } else {
          fail(error);
        }
      }
    });
  };

  const scanAbortedByUser = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

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

  const update = (patch: Partial<Recipe>): void => {
    cancelled = false;
    recipe = { ...recipe, ...patch };
    set({ recipe });
    schedule();
  };

  const updateConnectome = (patch: Partial<ConnectomeRecipe>): void => {
    update({ connectome: { ...recipe.connectome, ...patch } });
  };

  const choose = (patch: Partial<ChooseRecipe>): void => {
    const next = { ...recipe.connectome.choose, ...patch };
    // Removing the last From region is the way back to everything.
    updateConnectome({ choose: next, shown: next.from.length === 0 ? null : derivedShown(next) });
  };

  const effectOf = (value: unknown): Effect => (value === 'exclude' || value === 'remove' ? 'exclude' : 'include');
  const modeOf = (args: Record<string, unknown>): RuleMode =>
    args['mode'] === 'ends' || args['mode'] === 'both' ? (args['mode'] as RuleMode) : args['endsOnly'] === true ? 'ends' : 'through';

  const addSphere = (args: Record<string, unknown>): void => {
    const center = (args['center'] as [number, number, number] | undefined) ?? host.scene.cursor();
    const radiusMm = Number(args['radiusMm'] ?? view.sphereRadiusMm);
    if (!(radiusMm > 0)) throw new Error('A sphere needs a radius above 0 mm.');
    const rule: SphereRule = {
      kind: 'sphere',
      effect: effectOf(args['effect']),
      mode: modeOf(args),
      center: [center[0], center[1], center[2]],
      radiusMm,
      test: args['test'] === 'segment' || args['test'] === 'point' ? args['test'] : recipe.sphereTest,
    };
    update({ rules: [...recipe.rules, rule] });
  };

  const parseLabels = (raw: unknown): number[] =>
    Array.isArray(raw)
      ? (raw as number[])
      : String(raw ?? '')
          .split(/[\s,]+/)
          .filter((s) => s !== '')
          .map(Number);

  const addRegion = (args: Record<string, unknown>): void => {
    const volume = String(args['volume'] ?? '');
    if (volumeNamed(volume) === null) throw new Error(`${volume} is not open.`);
    const labels = parseLabels(args['labels']);
    if (labels.some((l) => !Number.isInteger(l) || l <= 0)) throw new Error('A region is a positive label id.');
    if (labels.length === 0 && args['mask'] !== true) throw new Error('Choose a region first.');
    const rule: RegionRule = { kind: 'region', effect: effectOf(args['effect']), mode: modeOf(args), volume, labels };
    update({ rules: [...recipe.rules, rule] });
    if (volume === view.choosing) set({ choosing: null });
  };

  const addRegionAtCursor = async (args: Record<string, unknown>): Promise<void> => {
    const volume = volumeNamed(String(args['volume'] ?? recipe.connectome.volume ?? view.labelVolumes[0]?.name ?? ''));
    if (volume === null) throw new Error('Open an atlas first.');
    const c = host.scene.cursor();
    const value = (await host.scene.sampleVolume(volume.id, Float32Array.of(c[0], c[1], c[2]), { order: 0 }))[0]!;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`The crosshair is in no region of ${volume.name}.`);
    addRegion({ ...args, volume: volume.name, labels: [Math.round(value)] });
  };

  /** An ROI file: a binary mask or a continuous map is one rule; an atlas first asks which label. */
  const openRoi = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let path = (args['path'] as string | undefined) ?? null;
    if (path === null) {
      path = (await host.files.openDialog('roi'))?.[0] ?? null;
      if (path === null) return { opened: null };
    }
    const already = allVolumes().find((d) => d.path === path);
    const dataset = already ?? (await host.scene.openFile(path));
    if (dataset.kind !== 'volume') throw new Error(`${basename(path)} is not a NIfTI volume.`);
    refresh();
    const ids = atlasIds(dataset);
    if (dataset.isLabel && ids.length > 1 && args['labels'] === undefined) {
      set({ choosing: dataset.name, message: `${dataset.name} has ${ids.length} labels: choose one below.` });
      return { opened: dataset.name, labels: ids.length };
    }
    addRegion({ ...args, volume: dataset.name, labels: args['labels'] ?? [], mask: true });
    return { opened: dataset.name };
  };

  const clearAll = async (): Promise<void> => {
    update({ rules: [], minMm: null, maxMm: null, connectome: { ...recipe.connectome, shown: null, choose: clearedChoice() } });
    await flush();
  };

  const settle = async (): Promise<void> => {
    if (debounce !== null) await flush();
    await queue;
  };

  const needFile = (): FileCache => {
    if (cache === null) throw new Error('The tractogram has not been read yet.');
    return cache;
  };

  const metricValueLabel = (): string | null => {
    const v = recipe.connectome.value;
    return v === null ? null : stemName(v.name);
  };

  const fileText = (what: string, symmetric: boolean): string => {
    const c = view.connectome;
    const name = nameOf;
    if (what === 'selection') {
      if (keep === null) throw new Error('Filter something first: there is no selection to export.');
      return selectionTxt(keep);
    }
    if (what === 'methods') return methodsFor([], []);
    if (what === 'recipe') return recipeJson();
    if (c === null) throw new Error('Build a network first.');
    const value = metricValueLabel();
    if (what === 'count' || what === 'length') return matrixCsv(c, view.matrixSize, what, symmetric);
    if (what === 'weight') {
      if (recipe.connectome.weightField === null) throw new Error('Choose weights first.');
      return matrixCsv(c, view.matrixSize, 'weight', symmetric);
    }
    if (what === 'value') {
      if (value === null) throw new Error('Choose a value first.');
      return matrixCsv(c, view.matrixSize, 'value', symmetric);
    }
    if (what === 'edges') return edgesCsv(c, name, { weight: recipe.connectome.weightField !== null, value });
    if (what === 'nodes') return nodesCsv(c, view.regions, name, recipe.connectome.weightField !== null);
    if (what === 'svg') return matrixSvg(c, view.regions, name, recipe.connectome.show, metricUnit());
    throw new Error(`Unknown export ${what}.`);
  };

  /** Rows in file order for the streamlines in `tracts`, or for every streamline with none. */
  const streamlineRows = async (
    list: { name: string; keep: Uint8Array }[],
    write: (text: string) => Promise<void>
  ): Promise<void> => {
    const file = needFile();
    const c = recipe.connectome;
    const value = metricValueLabel();
    const weights = c.weightField === null ? null : (file.series.get(`streamline:${c.weightField}`) ?? null);
    const values = c.value === null ? null : (file.series.get(seriesKey(c.value)) ?? null);
    const assign = c.on ? (file.assign.get(assignmentKey(c)) ?? null) : null;
    const head = ['file_index', 'tracts', 'length_mm'];
    if (value !== null) head.push(value);
    if (weights !== null) head.push('weight');
    if (assign !== null) head.push('node_a', 'node_b');
    await write(`${head.join(',')}\n`);
    const quoted = list.map((t) => ({ keep: t.keep, name: t.name.replace(/[;,"\n]/g, ' ') }));
    for (let s = 0; s < file.n; s += 1) {
      const member = quoted.filter((t) => t.keep[s] === 1).map((t) => t.name);
      if (list.length > 0 && member.length === 0) continue;
      const row = [String(s), member.join(';'), String(file.lengths[s])];
      if (value !== null) row.push(values === null || !Number.isFinite(values[s]!) ? '' : String(values[s]));
      if (weights !== null) row.push(String(weights[s]));
      if (assign !== null) row.push(String(assign[s * 2]), String(assign[s * 2 + 1]));
      await write(`${row.join(',')}\n`);
      if (s % 20000 === 0) await nextTask();
    }
  };

  const recipeJson = (): string => `${JSON.stringify({ module: host.id, version: manifest.version, recipe }, null, 2)}\n`;

  const volumeFingerprint = (v: Volume): string => {
    const print = new Fingerprint();
    print.add(Uint32Array.from(v.labelIds ?? []));
    print.add(Uint32Array.from(v.dims));
    print.add(new Uint32Array(Float32Array.from(v.affine).buffer));
    return print.hex();
  };

  const ruleName = (rule: Rule): string => {
    if (rule.kind === 'sphere') {
      return `Sphere, ${rule.radiusMm} mm at ${rule.center.map((v) => v.toFixed(1)).join(', ')}`;
    }
    if (rule.labels.length === 0) return rule.volume;
    return rule.labels.map((id) => regionLabel(id, rule.volume)).join(', ');
  };

  const regionLabel = (id: number, volume: string): string => {
    const name = nameOf(id, volume);
    return name === String(id) ? name : `${name} (${id})`;
  };

  const MODE_WORDS: Record<RuleMode, string> = { through: 'Passes through', ends: 'Ends in', both: 'Starts and ends in' };

  const methodsFor = (list: ListedTract[], files: string[]): string => {
    const file = needFile();
    const tract = currentTract()!;
    const c = recipe.connectome;
    const atlas = c.on ? volumeNamed(c.volume) : null;
    const value = c.value;
    const input: MethodsInput = {
      moduleVersion: manifest.version,
      hostVersion: String(MODULE_HOST_VERSION),
      when: new Date().toISOString(),
      tractogram: { name: tract.name, path: tract.path ?? null, format: tract.format, streamlines: file.n, points: file.points, fingerprint: file.fingerprint },
      atlas: atlas === null ? null : { name: atlas.name, path: atlas.path ?? null, dims: atlas.dims, regions: atlasIds(atlas).length, fingerprint: volumeFingerprint(atlas) },
      network: c.on ? { mode: c.mode, radiusMm: c.radiusMm, pair: c.pair, symmetric: recipe.exportOptions.symmetric, matrixSize: view.matrixSize } : null,
      weights: c.on ? c.weightField : null,
      value:
        c.on && value !== null
          ? {
              label: stemName(value.name),
              how:
                value.kind === 'volume'
                  ? `trilinear samples of ${value.name} at every point, averaged along each streamline weighted by the length each point stands for (tcksample -stat_tck mean); a point outside the image counts as 0`
                  : value.kind === 'vertex'
                    ? `the attached per-point field ${value.name}, averaged along each streamline the same way`
                    : `the attached per-streamline field ${value.name}`,
            }
          : null,
      namesFrom: namesSource(),
      tracts: list.map((t) => ({
        name: t.name,
        file: t.file,
        count: t.count,
        rules: t.spec.rules,
        minMm: t.spec.minMm,
        maxMm: t.spec.maxMm,
        connection: t.connection === null ? null : t.connection.pairs !== undefined ? t.connection.pairs.map(([x, y]) => `${regionLabel(x, recipe.connectome.volume ?? '')} to ${regionLabel(y, recipe.connectome.volume ?? '')}`).join('; ') : t.connection.b === null ? `touching ${regionLabel(t.connection.a, recipe.connectome.volume ?? '')}` : `${regionLabel(t.connection.a, recipe.connectome.volume ?? '')} to ${regionLabel(t.connection.b, recipe.connectome.volume ?? '')}`,
        ruleText: t.spec.rules.map((r) => `${r.effect === 'include' ? 'Keep' : 'Remove'} streamlines that: ${MODE_WORDS[r.mode].toLowerCase()} ${ruleName(r)}${r.kind === 'sphere' ? (r.test === 'segment' ? ' (a segment crossing it counts)' : ' (a point inside it counts)') : ''}.`),
      })),
      toleranceMm: file.tolerance,
      files,
    };
    return methodsText(input);
  };

  /** The saved tracts and the current filter, with their masks, reading whatever they still need. */
  const tractList = async (tract: Tract): Promise<ListedTract[]> => {
    await enqueue(() => scan(tract, 'Reading what the saved tracts need…', true));
    const sources: (Pick<SavedTract, 'rules' | 'minMm' | 'maxMm' | 'name'> & { connection: ConnectionSpec | null })[] = [...recipe.saved];
    if (filterActive()) {
      sources.push({ name: 'current_filter', rules: recipe.rules, minMm: recipe.minMm, maxMm: recipe.maxMm, connection: currentConnection() });
    }
    const seen = new Set<string>();
    const out: ListedTract[] = [];
    for (const spec of sources) {
      const mask = await maskFor(spec);
      out.push({ name: spec.name, file: uniqueName(spec.name, 'tck', seen), spec, connection: spec.connection, count: mask.count, keep: mask.keep });
    }
    return out;
  };

  const pngBytes = async (): Promise<Uint8Array> => {
    if (view.connectome === null) throw new Error('Build a network first.');
    return renderMatrixPng(view.connectome, view.regions, nameOf, recipe.connectome.show, metricUnit());
  };

  /** A job has no folder sheet: it writes under --out through the text and figure channels. */
  const exportFile = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    await settle();
    const what = String(args['what']);
    const out = String(args['out']);
    if (what === 'tck') {
      throw new Error('A job cannot write .tck: the job channel takes text and figures. Use export-selection, then tckedit -tck_weights_in.');
    }
    if (what === 'png') {
      const written = await host.files.writeBinary(out, await pngBytes());
      if (!written.ok) throw new Error(written.error);
      return { written: out };
    }
    if (what === 'streamlines') {
      const list = await tractList(currentTract()!);
      const parts: string[] = [];
      await streamlineRows(list, async (text) => void parts.push(text));
      return writeText(out, parts.join(''));
    }
    return writeText(out, fileText(what, args['symmetric'] === true));
  };

  const writeText = async (path: string, text: string): Promise<Record<string, unknown>> => {
    const written = await host.files.writeText(path, text);
    if (!written.ok) throw new Error(written.error);
    set({ message: `Wrote ${basename(path)}.` });
    return { written: path, bytes: text.length };
  };

  const exportOne = async (what: string, writer: string, fallback: string, path: string | null): Promise<Record<string, unknown>> => {
    await settle();
    const text = fileText(what, recipe.exportOptions.symmetric);
    let target = path;
    if (target === null) {
      const chosen = await host.files.saveDialog(writer, fallback);
      if (chosen === null) return { written: null };
      target = chosen.path;
    }
    return writeText(target, text);
  };

  const exportFolder = async (): Promise<Record<string, unknown>> => {
    await settle();
    const tract = currentTract();
    if (tract === null || cache === null) throw new Error('Open a tractogram first.');
    const folder = await host.files.chooseFolder('folder', { suggestedName: `${stemName(tract.name)}_${dateStamp(new Date())}` });
    if (folder === null) return { folder: null };
    const o = recipe.exportOptions;
    const c = view.connectome;
    const plan: ExportPlanItem[] = [];
    const wantedList = o.tracts || o.streamlines ? await tractList(tract) : [];
    const seen = new Set(wantedList.map((t) => t.file.toLowerCase()));
    const add = (name: string, content: () => string | Uint8Array | Promise<string | Uint8Array>): void => {
      seen.add(name.toLowerCase());
      plan.push({ name, content });
    };
    if (c !== null) {
      const symmetric = o.symmetric;
      if (o.matrices) {
        add('connectome_count.csv', () => matrixCsv(c, view.matrixSize, 'count', symmetric));
        add('connectome_length.csv', () => matrixCsv(c, view.matrixSize, 'length', symmetric));
        if (recipe.connectome.weightField !== null) add('connectome_weight.csv', () => matrixCsv(c, view.matrixSize, 'weight', symmetric));
        const value = metricValueLabel();
        if (value !== null) {
          add(uniqueName(`connectome_${value}`, 'csv', seen), () => matrixCsv(c, view.matrixSize, 'value', symmetric));
        }
      }
      if (o.edges) add('edges.csv', () => fileText('edges', symmetric));
      if (o.nodes) add('nodes.csv', () => fileText('nodes', symmetric));
      if (o.figure) {
        add('connectome.png', pngBytes);
        add('connectome.svg', () => fileText('svg', symmetric));
      }
    }
    if (o.streamlines) {
      seen.add('streamlines.csv');
      plan.push({
        name: 'streamlines.csv',
        stream: (write) => streamlineRows(wantedList, write),
      });
    }
    if (o.record) {
      const listed = (): string[] => plan.map((p) => p.name);
      add('recipe.json', recipeJson);
      add('methods.txt', () => methodsFor(wantedList, listed()));
    }
    if (o.tracts) for (const t of wantedList) plan.push({ name: t.file, tract: { keep: t.keep, count: t.count } });
    if (plan.length === 0) throw new Error('There is nothing to export yet: build a network or filter something.');
    set({ exporting: true, exportResult: null, message: null });
    const abort = new AbortController();
    scanAbort = abort;
    const outcome = await runExport(folder, plan, {
      scan: (onChunk, signal) => tracts.scan(tract.id, onChunk, { signal }),
      progress: (label, fraction) => set({ progress: { label, fraction } }),
      confirmOverwrite: async (clash) =>
        (await host.ui.confirm(
          'Replace existing files?',
          `${clash.length} ${clash.length === 1 ? 'file' : 'files'} in ${basename(folder.path)} would be replaced: ${clash.slice(0, 8).join(', ')}${clash.length > 8 ? ', …' : ''}.`,
          ['Replace', 'Cancel']
        )) === 0,
      total: needFile().n,
      header: tract.format === 'tck' ? needFile().header : new Map(),
      history: `tetravox.tract-tools ${manifest.version} export of ${tract.name}`,
      signal: abort.signal,
    });
    scanAbort = null;
    set({
      exporting: false,
      exportResult: outcome,
      progress: null,
      message: outcome.failed !== null ? `Export stopped: ${outcome.failed}` : null,
    });
    if (outcome.failed !== null) throw new Error(`Export stopped: ${outcome.failed}. Finished: ${outcome.finished.join(', ') || 'nothing'}.`);
    return { folder: outcome.folder, finished: outcome.finished, cancelled: outcome.cancelled };
  };

  const loadNames = async (path: string | null): Promise<void> => {
    let target = path;
    if (target === null) target = (await host.files.openDialog('names'))?.[0] ?? null;
    if (target === null) return;
    const text = await host.files.readText(target);
    if (text === null) {
      throw new Error(`Could not read ${basename(target)}: Tetravox reads .txt, .csv, .tsv and .json text up to 1 MiB.`);
    }
    const parsed = parseLookup(text);
    if (parsed.size === 0) throw new Error(`${basename(target)} has no id and name rows.`);
    setNames(parsed, basename(target));
  };

  const setNames = (table: ReadonlyMap<number, string>, from: string): void => {
    names.clear();
    for (const [id, name] of table) names.set(id, name);
    recipe = { ...recipe, namesFrom: from };
    persist();
    refresh();
    set({ matrixRevision: view.matrixRevision + 1 });
  };

  const savedNamed = (name: string): SavedTract => {
    const found = recipe.saved.find((s) => s.name === name);
    if (found === undefined) throw new Error(`No saved tract is called ${name}.`);
    return found;
  };

  const saveTract = async (args: Record<string, unknown>): Promise<void> => {
    await settle();
    const name = String(args['name'] ?? '').trim();
    if (name === '') throw new Error('Give the tract a name.');
    if (recipe.saved.some((s) => s.name === name)) throw new Error(`There is already a saved tract called ${name}.`);
    if (!filterActive()) throw new Error('Nothing is filtered: add a rule or select a connection first.');
    const saved: SavedTract = {
      name,
      rules: recipe.rules,
      minMm: recipe.minMm,
      maxMm: recipe.maxMm,
      connection: currentConnection(),
      count: view.count ?? 0,
    };
    update({ saved: [...recipe.saved, saved] });
  };

  const clearedChoice = (): ChooseRecipe => ({ ...recipe.connectome.choose, from: [], to: [] });

  const uniqueSavedName = (base: string): string => {
    let name = base;
    for (let i = 2; recipe.saved.some((s) => s.name === name); i += 1) name = `${base} (${i})`;
    return name;
  };

  const addConnection = async (args: Record<string, unknown>): Promise<void> => {
    await settle();
    const { shown } = recipe.connectome;
    if (shown === null) throw new Error('Choose a connection first.');
    const edges = view.connectome?.edges;
    const name = String(args['name'] ?? uniqueSavedName(`network_${dateStamp(new Date())}`));
    if (recipe.saved.some((s) => s.name === name)) throw new Error(`There is already a saved tract called ${name}.`);
    const saved: SavedTract = {
      name,
      rules: [],
      minMm: null,
      maxMm: null,
      connection: currentConnection(),
      count: shown.reduce((sum, [a, b]) => sum + (edges?.get(edgeKey(a, b))?.count ?? 0), 0),
    };
    update({ saved: [...recipe.saved, saved] });
  };

  const applyTract = (args: Record<string, unknown>): void => {
    const saved = savedNamed(String(args['name']));
    const c = saved.connection;
    update({
      rules: saved.rules,
      minMm: saved.minMm,
      maxMm: saved.maxMm,
      connectome:
        c === null
          ? { ...recipe.connectome, shown: null, choose: clearedChoice() }
          : {
              ...recipe.connectome,
              on: true,
              volume: c.volume,
              mode: c.mode,
              radiusMm: c.radiusMm,
              pair: c.pair,
              // A tract saved before several could be chosen names one connection, or one region.
              shown: c.pairs ?? (c.b === null ? null : [[c.a, c.b]]),
              choose: c.pairs === undefined && c.b === null ? { ...clearedChoice(), from: [c.a] } : clearedChoice(),
            },
    });
  };

  const metricUnit = (metric: EdgeMetric = recipe.connectome.show): string =>
    metric === 'count' ? 'streamlines' : metric === 'length' ? 'mm' : metric === 'weight' ? 'total weight' : (metricValueLabel() ?? 'value');

  const nameOf = (id: number, volume: string | null = recipe.connectome.volume): string => {
    const own = names.get(id);
    if (own !== undefined) return own;
    const v = volumeNamed(volume) ?? labelVolumes()[0];
    return v?.labelTable?.byId.get(id)?.name ?? String(id);
  };

  /** A table the user loaded here wins; otherwise the host says where the volume's names came from. */
  const namesSource = (): string | null => {
    if (recipe.namesFrom !== null) return recipe.namesFrom;
    const v = volumeNamed(recipe.connectome.volume) ?? labelVolumes()[0];
    if (v?.labelTable === undefined) return null;
    if (v.labelTable === v.assumedLabelTable) return 'FreeSurfer, assumed from label ids';
    return v.labelTableFile ?? 'lookup table';
  };

  const report = (): Record<string, unknown> => ({
    tract: recipe.tract,
    held: view.held,
    total: view.total,
    selected: view.count,
    drawn: view.drawnKept,
    medianMm: view.medianMm,
    edges: view.summary?.edges ?? null,
    nodes: view.regions.length,
    assigned: view.connectome?.assigned ?? 0,
    message: view.message,
  });

  const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
    'add-sphere': addSphere,
    'add-region': addRegion,
    'add-region-at-cursor': addRegionAtCursor,
    'open-roi': openRoi,
    clear: clearAll,
    'select-tract': async (a) => {
      await clearAll();
      recipe = { ...emptyRecipe(), names: recipe.names, namesFrom: recipe.namesFrom, tract: String(a['name']) };
      cache = null;
      builtKey = '';
      set({ connectome: null, summary: null, regions: [], ready: false, histogram: null, count: null });
      refresh();
      await flush();
    },
    'set-rule': (a) => {
      const index = Number(a['index']);
      update({ rules: recipe.rules.map((r, i) => (i === index ? ({ ...r, ...(a['patch'] as object) } as Rule) : r)) });
    },
    'remove-rule': (a) => update({ rules: recipe.rules.filter((_, i) => i !== Number(a['index'])) }),
    'set-length': (a) => update({ minMm: toLength(a['minMm']), maxMm: toLength(a['maxMm']) }),
    'set-sphere-radius': (a) => set({ sphereRadiusMm: Number(a['radiusMm']) }),
    'set-sphere-test': (a) => {
      const test = a['test'] === 'segment' ? 'segment' : 'point';
      update({ sphereTest: test, rules: recipe.rules.map((r) => (r.kind === 'sphere' ? { ...r, test } : r)) });
    },
    connectome: (a) => {
      const volume = (a['volume'] as string | undefined) ?? recipe.connectome.volume ?? view.labelVolumes[0]?.name ?? null;
      const mode = (a['mode'] as NodeMode | undefined) ?? recipe.connectome.mode;
      if (mode !== 'pair' && volume === null) throw new Error('Open an atlas first.');
      if (mode !== 'pair' && volumeNamed(volume) === null) throw new Error(`${volume} is not open.`);
      const metricField = a['metricField'] as string | undefined;
      updateConnectome({
        on: true,
        volume,
        mode,
        radiusMm: Number(a['radiusMm'] ?? recipe.connectome.radiusMm),
        pair: (a['pair'] as string | undefined) ?? recipe.connectome.pair ?? view.pairs[0] ?? null,
        ...(a['weightField'] === undefined ? {} : { weightField: a['weightField'] as string }),
        ...(metricField === undefined ? {} : { value: { kind: 'streamline' as const, name: metricField } }),
        ...(a['edgeField'] === undefined ? {} : { edgeField: a['edgeField'] === true }),
      });
    },
    // Ticks name another atlas's regions once the atlas changes.
    'set-connectome': (a) =>
      updateConnectome({
        ...(a as Partial<ConnectomeRecipe>),
        ...(('volume' in a && a['volume'] !== recipe.connectome.volume) || ('pair' in a && a['pair'] !== recipe.connectome.pair) ? { shown: null, choose: clearedChoice() } : {}),
      }),
    'set-show': (a) => {
      updateConnectome({ show: a['show'] as EdgeMetric });
      set({ matrixRevision: view.matrixRevision + 1 });
    },
    'set-weights': (a) => updateConnectome({ weightField: a['field'] == null ? null : String(a['field']) }),
    'set-value': (a) => {
      const volume = a['volume'] as string | undefined;
      const field = a['field'] as string | undefined;
      const tract = currentTract();
      const value: ValueSource | null =
        volume !== undefined
          ? { kind: 'volume', name: volume }
          : field !== undefined
            ? { kind: tract?.vertexFields.some((f) => f.name === field) ? 'vertex' : 'streamline', name: field }
            : null;
      updateConnectome({ value, ...(value === null && recipe.connectome.show === 'value' ? { show: 'count' as const } : {}) });
    },
    attach: async (a) => {
      const tract = currentTract();
      if (tract === null) throw new Error('Open a tractogram first.');
      let path = (a['path'] as string | undefined) ?? null;
      if (path === null) {
        path = (await host.files.openDialog('tract-data'))?.[0] ?? null;
        if (path === null) return { attached: [] };
      }
      const added = await tracts.attachFile(tract.id, path);
      refresh();
      const fieldNames = added.map((f) => f.name);
      const first = fieldNames[0];
      // One new column is what the user was attaching it for.
      if (added.length === 1 && first !== undefined) {
        const perStreamline = currentTract()?.streamlineFields.some((f) => f.name === first) ?? false;
        if (a['use'] === 'weights' && perStreamline) updateConnectome({ weightField: first });
        else if (a['use'] === 'value') updateConnectome({ value: { kind: perStreamline ? 'streamline' : 'vertex', name: first } });
      }
      return { attached: fieldNames };
    },
    // From a job: that connection alone, or again to clear it; without `b`, everything a region has.
    'select-edge': (a) => {
      const x = Number(a['a']);
      if (a['b'] == null) {
        choose({ from: [x], to: [], minN: 1 });
        return;
      }
      const pair: EdgePair = [x, Number(a['b'])];
      const { shown } = recipe.connectome;
      const same = shown !== null && shown.length === 1 && edgeKey(shown[0]![0], shown[0]![1]) === edgeKey(pair[0], pair[1]);
      updateConnectome({ shown: same ? null : [pair], choose: clearedChoice() });
    },
    'clear-edge': () => updateConnectome({ shown: null, choose: clearedChoice() }),
    choose: (a) => choose(a as Partial<ChooseRecipe>),
    'pick-edge': (a) => updateConnectome({ shown: pickPair(recipe.connectome.shown, [Number(a['a']), Number(a['b'])]) }),
    'show-edges': (a) => {
      const all = view.connectome === null ? [] : [...view.connectome.edges.values()].map((e): EdgePair => [e.a, e.b]);
      const targets = (a['pairs'] as EdgePair[] | undefined) ?? all;
      updateConnectome({ shown: nextShown(recipe.connectome.shown, all, targets, a['action'] as ShowAction) });
    },
    stats: (a) => {
      const field = String(a['field']);
      const requested = a['stats'] as Stat[] | string | undefined;
      const stats = (typeof requested === 'string' ? requested.split(/[\s,]+/) : (requested ?? STATS)) as Stat[];
      const bad = stats.filter((s) => !STATS.includes(s));
      if (bad.length > 0) throw new Error(`Unknown statistic ${bad.join(', ')}.`);
      const next = stats.map((stat) => ({ field, stat }));
      update({ stats: [...recipe.stats.filter((s) => !next.some((t) => t.field === s.field && t.stat === s.stat)), ...next] });
    },
    'save-tract': saveTract,
    'add-connection': addConnection,
    'apply-tract': applyTract,
    'rename-tract': (a) => {
      const to = String(a['to'] ?? '').trim();
      savedNamed(String(a['name']));
      if (to === '') throw new Error('Give the tract a name.');
      if (recipe.saved.some((s) => s.name === to)) throw new Error(`There is already a saved tract called ${to}.`);
      update({ saved: recipe.saved.map((s) => (s.name === a['name'] ? { ...s, name: to } : s)) });
    },
    'delete-tract': (a) => {
      savedNamed(String(a['name']));
      update({ saved: recipe.saved.filter((s) => s.name !== a['name']) });
    },
    'set-export': (a) => update({ exportOptions: { ...recipe.exportOptions, ...(a as Partial<ExportOptions>) } }),
    'export-folder': exportFolder,
    'export-file': exportFile,
    'export-matrix': (a) => exportOne('count', 'matrix', `${stemName(recipe.tract ?? 'tracts')}.connectome.csv`, (a['out'] as string | undefined) ?? null),
    'export-selection': (a) => exportOne('selection', 'selection', `${stemName(recipe.tract ?? 'tracts')}.selection.txt`, (a['out'] as string | undefined) ?? null),
    'load-names': (a) => loadNames((a['path'] as string | undefined) ?? null),
    cancel: () => scanAbort?.abort(new DOMException('Cancelled', 'AbortError')),
    'set-tab': (a) => host.ui.setPanelTab(String(a['tab'])),
    'set-placement': (a) => host.ui.setPlacement(a['placement'] as ModulePlacement),
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
    const generationMoved = sourceKey !== '' && sourceKey !== `${tract.id}:${tract.generation}`;
    const unread = cache === null || cache.datasetId !== tract.id;
    if (!cancelled && (unread || waitingForData || (generationMoved && (filterActive() || recipe.stats.length > 0 || recipe.connectome.edgeField)))) schedule();
  };

  host.subscribe(host.scene.on('datasets', onScene));
  host.subscribe(host.scene.on('layers', () => available && refresh()));
  host.subscribe(
    host.scene.on('sceneCleared', () => {
      cache = null;
      builtKey = '';
      keep = null;
      sourceKey = '';
      recipe = emptyRecipe();
      names.clear();
      set({ count: null, connectome: null, regions: [], summary: null, ready: false, histogram: null, message: null, selectedEdge: null, selectedRegion: null, exportResult: null });
      refresh();
    })
  );
  if (host.ui.onPanelTab !== undefined) host.subscribe(host.ui.onPanelTab((tab) => set({ tab })));
  if (host.ui.onPlacement !== undefined) host.subscribe(host.ui.onPlacement((placement) => set({ placement })));

  if (available) {
    refresh();
    if (currentTract() !== null) schedule();
  }

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
        host.ui.toast('warn', errorText(error));
      }
    },
    async operation(op, args) {
      lastError = null;
      const result = await invoke(op, args);
      await flush();
      await queue;
      if (lastError !== null) throw new Error(lastError);
      return { ...report(), ...(typeof result === 'object' && result !== null ? (result as object) : {}) };
    },
    async restore(block) {
      if (!available) return;
      recipe = upgradeRecipe(block.data);
      names.clear();
      for (const [id, name] of recipe.names ?? []) names.set(id, name);
      cancelled = false;
      builtKey = '';
      refresh();
      if (currentTract() !== null) await flush();
    },
    name: nameOf,
    ruleName,
    metricUnit,
    valueLabel: metricValueLabel,
    edgeLengths(edge) {
      const c = view.connectome;
      const out = new Float32Array(edge.count);
      if (c === null || cache === null) return out;
      for (let i = 0; i < edge.count; i += 1) out[i] = cache.lengths[c.members[edge.from + i]!]!;
      return out;
    },
    settled: settle,
    dispose() {
      disposed = true;
      scanAbort?.abort(new DOMException('Closed', 'AbortError'));
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
