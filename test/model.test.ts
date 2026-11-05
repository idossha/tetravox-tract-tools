// The model over a fake host: what it asks the host for, and what it writes back. Geometry is authored:
// streamlines along x at z = 0 (lengths 2, 2, 1), so which sphere and region each one meets is by inspection.
import { describe, expect, it } from 'vitest';
import type { ExtensionBlock, ModuleHost } from '@tetravox/module-sdk';
import { createModel, SELECTED_FIELD } from '../src/model';

const POINTS = Float32Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0, 10, 0, 0, 11, 0, 0, 12, 0, 0, 20, 0, 0, 21, 0, 0);
const OFFSETS = Uint32Array.of(0, 3, 6, 8);
// Point labels: first streamline passes 5 (at its middle), second ends in 7, third has neither.
const LABELS = Float32Array.of(0, 5, 0, 7, 0, 0, 0, 0);

function fakeHost(opts: { nStreamlines?: number; tracts?: boolean } = {}) {
  const calls = { sample: 0, points: 0, field: 0 };
  const tract: any = {
    kind: 'tractogram',
    id: 'T1',
    name: 'a.tck',
    nStreamlines: 3,
    sourceStreamlines: opts.nStreamlines ?? 3,
    generation: 0,
    fieldRevision: 0,
    vertexFields: [],
    streamlineFields: [{ name: 'length_mm', builtin: true }],
    samples: [],
    headerJson: JSON.stringify([['step_size', '0.5'], ['downsample_factor', '1']]),
  };
  const volume: any = {
    kind: 'volume',
    id: 'V1',
    name: 'nodes.nii.gz',
    isLabel: true,
    labelIds: Uint32Array.of(0, 5, 7),
    dims: [30, 3, 3],
    affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    inverseAffine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  const datasets: any[] = [tract, volume];
  const layer: any = { id: 'L1', kind: 'tracts', datasetId: 'T1' };
  const layers: any[] = [layer];
  const on = new Map<string, Set<(p: unknown) => void>>();
  const written = new Map<string, Float32Array>();
  const files = new Map<string, string>();
  let block: unknown = null;
  let cursor: [number, number, number] = [1, 0, 0];
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
      sampleVolume: async (_id: string, w: Float32Array) => {
        const out = new Float32Array(w.length / 3);
        for (let i = 0; i < out.length; i += 1) out[i] = Math.round(w[i * 3]!) === 1 ? 5 : Math.round(w[i * 3]!) === 10 ? 7 : 0;
        return out;
      },
      tracts:
        opts.tracts === false
          ? undefined
          : {
              structure: async () => ({ offsets: OFFSETS, sourceIndex: Uint32Array.of(0, 1, 2) }),
              points: async (_d: string, first: number, count: number) => {
                calls.points += 1;
                return POINTS.slice(first * 3, (first + count) * 3);
              },
              field: async (_d: string, _k: string, _n: string, first: number, count: number) => {
                calls.field += 1;
                return LABELS.slice(first, first + count);
              },
              setStreamlineField: async (_d: string, f: { name: string; values: Float32Array }) => {
                // The real host transfers this buffer to the worker.
                const moved = structuredClone(f.values, { transfer: [f.values.buffer] });
                written.set(f.name, moved);
                if (!tract.streamlineFields.some((x: any) => x.name === f.name)) tract.streamlineFields.push({ name: f.name });
                return { name: f.name };
              },
              removeField: async (_d: string, kind: string, name: string) => {
                written.delete(name);
                const list = kind === 'vertex' ? 'vertexFields' : 'streamlineFields';
                tract[list] = tract[list].filter((f: any) => f.name !== name);
              },
              sample: async (spec: any) => {
                calls.sample += 1;
                tract.vertexFields.push({ name: spec.name, sampled: true });
                tract.samples.push(spec);
                return { name: spec.name };
              },
            },
    },
    files: {
      readText: async (p: string) => files.get(p) ?? null,
      saveDialog: async () => null,
      openDialog: async () => null,
      writeText: async (p: string, t: string) => {
        files.set(p, t);
        return { ok: true, backupPath: null };
      },
    },
    ui: { toast: () => undefined, setDirty: () => undefined },
    subscribe: () => undefined,
  } as unknown as ModuleHost;
  const emit = (e: string): void => {
    for (const cb of on.get(e) ?? []) cb(undefined);
  };
  return {
    host,
    calls,
    tract,
    volume,
    layer,
    layers,
    datasets,
    written,
    files,
    emit,
    block: () => block,
    setCursor: (c: [number, number, number]) => {
      cursor = c;
    },
  };
}

const selected = (f: ReturnType<typeof fakeHost>): number[] => [...(f.written.get(SELECTED_FIELD) ?? [])];

describe('without scene.tracts', () => {
  it('names what it needs', () => {
    const m = createModel(fakeHost({ tracts: false }).host);
    expect(m.state().available).toBe(false);
    expect(m.state().message).toMatch(/newer Tetravox.*0\.8\.0/);
  });
});

describe('selection', () => {
  it('writes 1/0 and sets keepField; clearing removes both', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    expect(selected(f)).toEqual([1, 0, 0]);
    expect(f.layer.keepField).toBe(SELECTED_FIELD);
    expect(m.state().count).toBe(1);
    await m.operation('clear', {});
    expect(f.layer.keepField).toBeUndefined();
    expect(f.written.has(SELECTED_FIELD)).toBe(false);
    expect(m.state().count).toBeNull();
  });
  it('a segment crossing a sphere counts, and a point test does not see it', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-sphere', { center: [20.5, 0, 0], radiusMm: 0.2 });
    expect(selected(f)).toEqual([0, 0, 1]);
    await m.operation('clear', {});
    await m.operation('add-sphere', { center: [20.5, 0, 0], radiusMm: 0.2, test: 'point' });
    expect(selected(f)).toEqual([0, 0, 0]);
  });
  it('samples labels once per volume however the rules change', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '5' });
    expect(selected(f)).toEqual([1, 0, 0]);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '7', effect: 'exclude' });
    expect(selected(f)).toEqual([1, 0, 0]);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '5', endsOnly: true });
    expect(selected(f)).toEqual([0, 0, 0]);
    expect(f.calls.sample).toBe(1);
  });
  it('flipping a rule between include and exclude reads nothing again', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '7' });
    const reads = f.calls.field;
    await m.run('set-rule', { index: 0, patch: { effect: 'exclude' } });
    await m.settled();
    expect(selected(f)).toEqual([1, 0, 1]);
    expect(f.calls.field).toBe(reads);
  });
  it('honours the header tolerance on length: 2 mm passes a 1.8 mm limit only by the step tolerance', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('set-length', { maxMm: 1.8 });
    expect(selected(f)).toEqual([1, 1, 1]);
    await m.operation('set-length', { maxMm: 1.7 });
    expect(selected(f)).toEqual([0, 0, 1]);
  });
  it('takes the crosshair region, and refuses when there is none', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.run('add-region-at-cursor', {});
    await m.settled();
    expect(m.state().recipe.rules[0]).toMatchObject({ kind: 'region', labels: [5] });
    f.setCursor([25, 0, 0]);
    await m.run('add-region-at-cursor', {});
    expect(m.state().message).toMatch(/no region/);
  });
  it('draws spheres as a points layer at world radius, and removes it with the rules', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-sphere', { center: [1, 2, 3], radiusMm: 4 });
    const points = f.layers.find((l) => l.kind === 'points');
    expect(points.points[0]).toMatchObject({ position: [1, 2, 3], radiusMm: 4 });
    await m.operation('clear', {});
    expect(f.layers.some((l) => l.kind === 'points')).toBe(false);
  });
});

describe('connectome', () => {
  it('assigns ends, selects an edge, and ANDs it with the rules', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    // End voxels: x=0→0, x=2→0; x=10→7, x=12→0; x=20→0, x=21→0. Radial 1.5: first has x=1 (5) at both ends.
    await m.operation('connectome', { volume: 'nodes.nii.gz', mode: 'radial', radiusMm: 1.5 });
    const c = m.state().connectome!;
    expect(c.nodes).toEqual([5]);
    expect([...c.edges.values()][0]).toMatchObject({ a: 5, b: 5, count: 1 });
    await m.operation('select-edge', { a: 5, b: 5 });
    expect(selected(f)).toEqual([1, 0, 0]);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '7' });
    expect(selected(f)).toEqual([0, 0, 0]);
  });
  it('clicking the selected edge again clears it', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('connectome', { volume: 'nodes.nii.gz', mode: 'radial', radiusMm: 1.5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    expect(m.state().recipe.connectome.selected).toBeNull();
    expect(f.layer.keepField).toBeUndefined();
  });
});

describe('statistics', () => {
  it('writes <field>:<stat>, and rejects an unknown statistic', async () => {
    const f = fakeHost();
    f.tract.vertexFields.push({ name: 'fa' });
    const m = createModel(f.host);
    await m.operation('stats', { field: 'fa', stats: 'max' });
    expect([...f.written.get('fa:max')!]).toEqual([5, 7, 0]);
    await expect(m.operation('stats', { field: 'fa', stats: 'mode' })).rejects.toThrow(/mode/);
  });
});

describe('export', () => {
  it('survives the host transferring the selection, and writes one row', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    await m.operation('export-selection', { out: '/x/s.txt' });
    expect(f.files.get('/x/s.txt')).toBe('1 0 0\n');
  });
  it('refuses a selection over a budget subset and names why', async () => {
    const f = fakeHost({ nStreamlines: 10 });
    const m = createModel(f.host);
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    expect(m.state().subsetNote).toMatch(/3 of 10/);
    await expect(m.operation('export-selection', { out: '/x/s.txt' })).rejects.toThrow(/3 of 10/);
    expect(f.files.has('/x/s.txt')).toBe(false);
  });
  it('sizes the matrix to the volume\'s largest id, as tck2connectome does', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('connectome', { volume: 'nodes.nii.gz', mode: 'radial', radiusMm: 1.5 });
    await m.operation('export-matrix', { out: '/x/m.csv' });
    expect(f.files.get('/x/m.csv')!.trim().split('\n')).toHaveLength(7);
  });
});

describe('persistence', () => {
  it('the block holds names, never ids, and restoring recomputes', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '5' });
    await m.operation('connectome', { volume: 'nodes.nii.gz', mode: 'radial', radiusMm: 1.5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    const text = JSON.stringify(f.block());
    expect(text).toContain('nodes.nii.gz');
    expect(text).not.toContain('"V1"');
    expect(text).not.toContain('"T1"');
    const g = fakeHost();
    const n = createModel(g.host);
    await n.restore({ module: 'tetravox.tract-tools', version: 1, moduleVersion: '0.1.0', data: f.block() } as ExtensionBlock);
    await n.settled();
    expect(selected(g)).toEqual([1, 0, 0]);
    expect(n.state().connectome?.nodes).toEqual([5]);
  });
  it('waits for a named volume to open, then recomputes', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-region', { volume: 'nodes.nii.gz', labels: '5' });
    const g = fakeHost();
    g.datasets.splice(1, 1);
    const n = createModel(g.host);
    await n.restore({ module: 'tetravox.tract-tools', version: 1, moduleVersion: '0.1.0', data: f.block() } as ExtensionBlock);
    await n.settled();
    expect(n.state().message).toMatch(/nodes\.nii\.gz/);
    expect(g.written.has(SELECTED_FIELD)).toBe(false);
    g.datasets.push(g.volume);
    g.emit('datasets');
    await n.settled();
    expect(selected(g)).toEqual([1, 0, 0]);
    expect(n.state().message).toBeNull();
  });
  it('recomputes when the generation moves, because a budget change drops written fields', async () => {
    const f = fakeHost();
    const m = createModel(f.host);
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    f.written.clear();
    f.tract.generation += 1;
    f.emit('datasets');
    await m.settled();
    expect(selected(f)).toEqual([1, 0, 0]);
  });
});
