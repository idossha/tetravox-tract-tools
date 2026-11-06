// The host a model test runs against: the real contract's shapes over arrays, with a folder on disk.

import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleHost } from '@tetravox/module-sdk';
import { volumeSampler } from './sampler';

export interface FakeVolume {
  name: string;
  dims: [number, number, number];
  affine: number[];
  inverseAffine: number[];
  data: ArrayLike<number>;
  isLabel: boolean;
  labelIds?: Uint32Array;
  labelTable?: unknown;
  assumedLabelTable?: unknown;
  labelTableFile?: string;
  path?: string;
}

export interface FakeTract {
  name?: string;
  offsets: Uint32Array;
  points: Float32Array;
  /** Which file streamlines are held; default all. */
  held?: Uint32Array;
  headerJson?: string;
  vertexFields?: Record<string, Float32Array>;
  streamlineFields?: Record<string, Float32Array>;
  format?: 'tck' | 'trk' | 'trx';
}

const SCAN_CHUNK = 1_000_000;

export function fakeHost(t: FakeTract, volumes: FakeVolume[], opts: { tracts?: boolean; folder?: string } = {}) {
  const n = t.offsets.length - 1;
  const calls = { sample: 0, scan: 0, structure: 0, chooseFolder: 0, openFile: 0 };
  const held = t.held ?? Uint32Array.from({ length: n }, (_, i) => i);
  const fields: Record<string, Float32Array> = { ...(t.streamlineFields ?? {}) };
  const vertex: Record<string, Float32Array> = { ...(t.vertexFields ?? {}) };
  const tract: any = {
    kind: 'tractogram',
    id: 'T1',
    name: t.name ?? 'a.tck',
    path: `/data/${t.name ?? 'a.tck'}`,
    format: t.format ?? 'tck',
    nStreamlines: held.length,
    sourceStreamlines: n,
    generation: 0,
    fieldRevision: 0,
    vertexFields: Object.keys(vertex).map((name) => ({ name })),
    streamlineFields: [{ name: 'length_mm', builtin: true }, ...Object.keys(fields).map((name) => ({ name }))],
    samples: [],
    headerJson: t.headerJson ?? JSON.stringify([['step_size', '0.5'], ['downsample_factor', '1']]),
  };
  const asDataset = (v: FakeVolume, i: number): any => ({
    kind: 'volume',
    id: `V${i + 1}`,
    labelIds: v.labelIds,
    ...v,
  });
  const datasets: any[] = [tract, ...volumes.map(asDataset)];
  const pending = new Map<string, FakeVolume>();
  const layers: any[] = [{ id: 'L1', kind: 'tracts', datasetId: 'T1' }];
  const on = new Map<string, Set<(p: unknown) => void>>();
  const written = new Map<string, Float32Array>();
  const files = new Map<string, string>();
  const binary = new Map<string, Uint8Array>();
  let block: unknown = null;
  let cursor: [number, number, number] = [1, 0, 0];
  let dialog: string[] | null = null;
  let confirmAnswer: 0 | 1 = 0;
  let failWrite: ((name: string) => boolean) | null = null;
  const confirms: string[] = [];
  const emit = (e: string): void => {
    for (const cb of on.get(e) ?? []) cb(undefined);
  };
  const samplers = new Map<string, ReturnType<typeof volumeSampler>>();
  const host = {
    id: 'tetravox.tract-tools',
    scene: {
      layers: () => layers,
      datasets: () => datasets,
      addLayer: (spec: any) => {
        const l = { id: `L${layers.length + 1}`, module: 'tetravox.tract-tools', ...spec };
        layers.push(l);
        return l;
      },
      updateLayer: (id: string, patch: object) => Object.assign(layers.find((l) => l.id === id), patch),
      removeLayer: (id: string) => layers.splice(layers.findIndex((l) => l.id === id), 1),
      cursor: () => cursor,
      block: () => block,
      setBlock: (d: unknown) => {
        block = d;
      },
      on: (e: string, cb: (p: unknown) => void) => {
        if (!on.has(e)) on.set(e, new Set());
        on.get(e)!.add(cb);
        return () => on.get(e)!.delete(cb);
      },
      sampleVolume: async (id: string, w: Float32Array, o?: { order?: 0 | 1 }) => {
        calls.sample += 1;
        const v = datasets.find((d) => d.id === id);
        if (w.length / 3 > 2_000_000) throw new Error('more than 2,000,000 points');
        let s = samplers.get(`${id}:${o?.order ?? 1}`);
        if (s === undefined) {
          s = volumeSampler(v.data, v, o?.order ?? 1);
          samplers.set(`${id}:${o?.order ?? 1}`, s);
        }
        return s(w);
      },
      openFile: async (path: string) => {
        calls.openFile += 1;
        const v = pending.get(path);
        if (v === undefined) throw new Error(`cannot open ${path}`);
        const d = asDataset({ ...v, path }, datasets.length);
        datasets.push(d);
        return d;
      },
      tracts:
        opts.tracts === false
          ? undefined
          : {
              structure: async () => {
                calls.structure += 1;
                return { offsets: t.offsets, sourceIndex: held };
              },
              scan: async (_d: string, onChunk: (c: any) => Promise<void> | void, o?: { signal?: AbortSignal; fields?: string[] }) => {
                calls.scan += 1;
                let first = 0;
                while (first < n) {
                  o?.signal?.throwIfAborted();
                  let last = first + 1;
                  while (last < n && t.offsets[last + 1]! - t.offsets[first]! <= SCAN_CHUNK) last += 1;
                  const a = t.offsets[first]!;
                  const b = t.offsets[last]!;
                  const pick = <T extends Float32Array>(all: T, x: number, y: number): T => all.slice(x, y) as T;
                  const chunk = {
                    firstSource: first,
                    offsets: t.offsets.slice(first, last + 1).map((v) => v - a),
                    positions: t.points.slice(a * 3, b * 3),
                    streamlineFields: Object.fromEntries((o?.fields ?? []).filter((f) => f in fields).map((f) => [f, pick(fields[f]!, first, last)])),
                    vertexFields: Object.fromEntries((o?.fields ?? []).filter((f) => f in vertex).map((f) => [f, pick(vertex[f]!, a, b)])),
                  };
                  for (const f of o?.fields ?? []) if (!(f in fields) && !(f in vertex)) throw new Error(`no field ${f}`);
                  await onChunk(chunk);
                  first = last;
                }
                return { streamlines: n, points: t.points.length / 3 };
              },
              setStreamlineField: async (_d: string, f: { name: string; values: Float32Array }) => {
                // The real host transfers this buffer to the worker.
                written.set(f.name, structuredClone(f.values, { transfer: [f.values.buffer] }));
                if (!tract.streamlineFields.some((x: any) => x.name === f.name)) tract.streamlineFields.push({ name: f.name });
                return { name: f.name };
              },
              removeField: async (_d: string, kind: string, name: string) => {
                written.delete(name);
                const list = kind === 'vertex' ? 'vertexFields' : 'streamlineFields';
                tract[list] = tract[list].filter((f: any) => f.name !== name);
              },
              attachFile: async (_d: string, path: string) => {
                const body = attachable.get(path);
                if (body === undefined) throw new Error(`does not fit: ${path}`);
                if (body.perPoint) {
                  vertex[body.name] = body.values;
                  tract.vertexFields.push({ name: body.name });
                } else {
                  fields[body.name] = body.values;
                  tract.streamlineFields.push({ name: body.name });
                }
                return [{ name: body.name }];
              },
            },
    },
    files: {
      readText: async (p: string) => files.get(p) ?? null,
      saveDialog: async () => null,
      openDialog: async () => dialog,
      writeText: async (p: string, text: string) => {
        files.set(p, text);
        return { ok: true, backupPath: null };
      },
      writeBinary: async (p: string, bytes: Uint8Array) => {
        binary.set(p, bytes);
        return { ok: true, backupPath: null };
      },
      chooseFolder: async () => {
        calls.chooseFolder += 1;
        if (opts.folder === undefined) return null;
        const root = opts.folder;
        mkdirSync(root, { recursive: true });
        return {
          path: root,
          async create(name: string, o?: { overwrite?: boolean }) {
            const path = join(root, name);
            if (existsSync(path) && o?.overwrite !== true) throw new Error(`${name} exists; pass overwrite to replace it`);
            const part = `${path}.part`;
            const fd = openSync(part, 'w');
            let bytes = 0;
            return {
              async write(b: Uint8Array) {
                if (failWrite?.(name) === true) throw new Error(`disk full writing ${name}`);
                bytes += b.length;
                writeSync(fd, b);
              },
              async close() {
                closeSync(fd);
                renameSync(part, path);
                return { path, bytes };
              },
              async abort() {
                closeSync(fd);
                rmSync(part, { force: true });
              },
            };
          },
        };
      },
    },
    ui: {
      toast: () => undefined,
      setDirty: () => undefined,
      panelTab: () => 'network',
      placement: () => 'docked',
      onPanelTab: () => () => undefined,
      onPlacement: () => () => undefined,
      setPanelTab: () => undefined,
      setPlacement: () => undefined,
      confirm: async (_t: string, body: string) => {
        confirms.push(body);
        return confirmAnswer;
      },
    },
    subscribe: () => undefined,
  } as unknown as ModuleHost;
  const attachable = new Map<string, { name: string; values: Float32Array; perPoint: boolean }>();
  return {
    host,
    calls,
    tract,
    layers,
    datasets,
    written,
    files,
    binary,
    pending,
    attachable,
    confirms,
    emit,
    block: () => block,
    setCursor: (c: [number, number, number]) => {
      cursor = c;
    },
    setDialog: (paths: string[] | null) => {
      dialog = paths;
    },
    setConfirm: (answer: 0 | 1) => {
      confirmAnswer = answer;
    },
    setFailWrite: (f: ((name: string) => boolean) | null) => {
      failWrite = f;
    },
  };
}
