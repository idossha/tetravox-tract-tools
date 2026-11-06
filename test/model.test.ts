// The model over a fake host: what it asks the host for, and what it writes back. Geometry is authored:
// streamlines along x at z = 0 (lengths 2, 2, 1), so which sphere and region each one meets is by inspection.
// The first streamline passes label 5 at x=1; the second starts in label 7 at x=10; the third meets neither.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtensionBlock } from '@tetravox/module-sdk';
import { createModel, EDGE_FIELD, SELECTED_FIELD , upgradeRecipe } from '../src/model';
import { fakeHost } from './fakeHost';
import type { FakeTract, FakeVolume } from './fakeHost';
import { readTck } from './files';

const POINTS = Float32Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0, 10, 0, 0, 11, 0, 0, 12, 0, 0, 20, 0, 0, 21, 0, 0);
const OFFSETS = Uint32Array.of(0, 3, 6, 8);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function volumeOf(name: string, fill: (x: number) => number, isLabel = true): FakeVolume {
  const dims: [number, number, number] = [30, 1, 1];
  const data = Float32Array.from({ length: 30 }, (_, x) => fill(x));
  return {
    name,
    dims,
    affine: IDENTITY,
    inverseAffine: IDENTITY,
    data,
    isLabel,
    ...(isLabel ? { labelIds: Uint32Array.from(new Set([0, ...data])).sort() } : {}),
  };
}
const nodes = (): FakeVolume => volumeOf('nodes.nii.gz', (x) => (x === 1 ? 5 : x === 10 ? 7 : 0));
const TRACT: FakeTract = { offsets: OFFSETS, points: POINTS };

function setup(t: Partial<FakeTract> = {}, volumes: FakeVolume[] = [nodes()], opts: { tracts?: boolean; folder?: string } = {}) {
  const f = fakeHost({ ...TRACT, ...t }, volumes, opts);
  return { f, m: createModel(f.host) };
}
const kept = (f: ReturnType<typeof fakeHost>): number[] => [...(f.written.get(SELECTED_FIELD) ?? [])];
const VOL = { volume: 'nodes.nii.gz' };

describe('without a whole-file scan', () => {
  it('names what it needs', () => {
    const { m } = setup({}, [nodes()], { tracts: false });
    expect(m.state().available).toBe(false);
    expect(m.state().message).toMatch(/newer Tetravox/);
  });
});

describe('the first read', () => {
  it('reads the file once on its own and shows lengths, with no filter on', async () => {
    const { f, m } = setup();
    await m.settled();
    await m.operation('clear', {});
    expect(f.calls.scan).toBe(1);
    expect(m.state().ready).toBe(true);
    expect(m.state().count).toBeNull();
    expect(m.state().medianMm).toBe(2);
    expect(m.state().histogram?.counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(f.layers[0].keepField).toBeUndefined();
  });
  it('a file changed on disk rejects at the end, leaving nothing half-computed', async () => {
    const { f, m } = setup();
    const scan = f.host.scene.tracts.scan;
    f.host.scene.tracts.scan = async (id, onChunk, opts) => {
      await scan(id, onChunk, opts);
      throw new Error('file changed on disk');
    };
    await expect(m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 })).rejects.toThrow(/changed/);
    expect(m.state().ready).toBe(false);
    expect(m.state().count).toBeNull();
  });
  it('a budget change ends a scan: it reads again, for the same answer', async () => {
    const { f, m } = setup();
    const real = f.host.scene.tracts.scan;
    let first = true;
    f.host.scene.tracts.scan = async (id, onChunk, opts) => {
      if (first) {
        first = false;
        f.tract.generation += 1;
        throw new Error('the budget changed');
      }
      return real(id, onChunk, opts);
    };
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    await m.settled();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await m.settled();
    expect(kept(f)).toEqual([1, 0, 0]);
    expect(m.state().message).toBeNull();
  });
  it('Cancel stops the read and starts nothing until asked', async () => {
    const { f, m } = setup();
    const real = f.host.scene.tracts.scan;
    f.host.scene.tracts.scan = (id, onChunk, opts) =>
      real(
        id,
        async (chunk) => {
          await m.run('cancel');
          opts!.signal!.throwIfAborted();
          await onChunk(chunk);
        },
        opts
      );
    await m.operation('clear', {});
    expect(m.state().message).toMatch(/Cancelled/);
    expect(m.state().ready).toBe(false);
    f.host.scene.tracts.scan = real;
    f.emit('datasets');
    await m.settled();
    expect(m.state().ready).toBe(false);
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    expect(m.state().count).toBe(1);
  });
});

describe('the filter', () => {
  it('writes 1/0 and sets keepField; clearing removes both', async () => {
    const { f, m } = setup();
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    expect(kept(f)).toEqual([1, 0, 0]);
    expect(f.layers[0].keepField).toBe(SELECTED_FIELD);
    expect(m.state().count).toBe(1);
    expect(m.state().medianMm).toBe(2);
    await m.operation('clear', {});
    expect(f.layers[0].keepField).toBeUndefined();
    expect(f.written.has(SELECTED_FIELD)).toBe(false);
    expect(m.state().count).toBeNull();
  });
  it('a sphere uses tckedit\'s point test by default; a crossing segment counts only when asked', async () => {
    const { f, m } = setup();
    await m.operation('add-sphere', { center: [20.5, 0, 0], radiusMm: 0.2 });
    expect(kept(f)).toEqual([0, 0, 0]);
    await m.run('set-sphere-test', { test: 'segment' });
    await m.settled();
    expect(kept(f)).toEqual([0, 0, 1]);
    expect(m.state().recipe.rules[0]).toMatchObject({ test: 'segment' });
  });
  it('reads a volume once however the rules change: adding, flipping and removing touch no point', async () => {
    const { f, m } = setup();
    await m.operation('add-region', { ...VOL, labels: '5' });
    expect(kept(f)).toEqual([1, 0, 0]);
    const scans = f.calls.scan;
    const samples = f.calls.sample;
    await m.operation('add-region', { ...VOL, labels: '7', effect: 'exclude' });
    expect(kept(f)).toEqual([1, 0, 0]);
    await m.run('set-rule', { index: 0, patch: { effect: 'exclude' } });
    await m.settled();
    expect(kept(f)).toEqual([0, 0, 1]);
    await m.run('remove-rule', { index: 1 });
    await m.settled();
    expect(kept(f)).toEqual([0, 1, 1]);
    expect([f.calls.scan, f.calls.sample]).toEqual([scans, samples]);
  });
  it('Ends in and Starts and ends in test only the two ends', async () => {
    const { f, m } = setup();
    await m.operation('add-region', { ...VOL, labels: '5', mode: 'ends' });
    expect(kept(f)).toEqual([0, 0, 0]);
    await m.run('set-rule', { index: 0, patch: { labels: [7] } });
    await m.settled();
    expect(kept(f)).toEqual([0, 1, 0]);
    await m.run('set-rule', { index: 0, patch: { mode: 'both' } });
    await m.settled();
    expect(kept(f)).toEqual([0, 0, 0]);
  });
  it('honours the header tolerance on length: 2 mm passes a 1.8 mm limit only by the step tolerance', async () => {
    const { f, m } = setup();
    await m.operation('set-length', { maxMm: 1.8 });
    expect(kept(f)).toEqual([1, 1, 1]);
    await m.operation('set-length', { maxMm: 1.7 });
    expect(kept(f)).toEqual([0, 0, 1]);
  });
  it('takes the crosshair region, and refuses when there is none', async () => {
    const { f, m } = setup();
    await m.run('add-region-at-cursor', {});
    await m.settled();
    expect(m.state().recipe.rules[0]).toMatchObject({ kind: 'region', labels: [5] });
    f.setCursor([25, 0, 0]);
    await m.run('add-region-at-cursor', {});
    expect(m.state().message).toMatch(/no region/);
  });
  it('draws spheres as a points layer at world radius, and removes it with the rules', async () => {
    const { f, m } = setup();
    await m.operation('add-sphere', { center: [1, 2, 3], radiusMm: 4 });
    const points = f.layers.find((l) => l.kind === 'points');
    expect(points.points[0]).toMatchObject({ position: [1, 2, 3], radiusMm: 4 });
    await m.operation('clear', {});
    expect(f.layers.some((l) => l.kind === 'points')).toBe(false);
  });
});

describe('over a display budget', () => {
  const HELD = { held: Uint32Array.of(2, 0) };
  it('counts every streamline, draws the held ones through sourceIndex, and says so', async () => {
    const { f, m } = setup(HELD);
    await m.operation('add-region', { ...VOL, labels: '7' });
    expect(m.state().count).toBe(1);
    expect(m.state().total).toBe(3);
    expect(m.state().held).toBe(2);
    expect(m.state().drawnKept).toBe(0);
    expect(kept(f)).toEqual([0, 0]);
    await m.operation('add-region', { ...VOL, labels: '7', effect: 'exclude' });
    await m.operation('clear', {});
    await m.operation('add-region', { ...VOL, labels: '5' });
    expect(kept(f)).toEqual([0, 1]);
  });
  it('a generation change maps again, without reading the file again', async () => {
    const { f, m } = setup(HELD);
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    const scans = f.calls.scan;
    f.written.clear();
    f.tract.generation += 1;
    f.emit('datasets');
    await m.settled();
    expect(kept(f)).toEqual([0, 1]);
    expect(f.calls.scan).toBe(scans);
    expect(f.calls.structure).toBe(2);
  });
});

describe('an ROI file', () => {
  it('a binary mask is one rule named after the file, on every nonzero voxel', async () => {
    const { f, m } = setup();
    f.pending.set('/d/roi.nii.gz', volumeOf('roi.nii.gz', (x) => (x === 11 ? 1 : 0)));
    f.setDialog(['/d/roi.nii.gz']);
    await m.run('open-roi');
    await m.settled();
    expect(kept(f)).toEqual([0, 1, 0]);
    expect(m.state().recipe.rules[0]).toMatchObject({ volume: 'roi.nii.gz', labels: [] });
    expect(m.ruleName(m.state().recipe.rules[0]!)).toBe('roi.nii.gz');
    expect(f.calls.openFile).toBe(1);
  });
  it('a continuous map keeps every nonzero voxel, however small', async () => {
    const { f, m } = setup();
    f.pending.set('/d/p.nii.gz', volumeOf('p.nii.gz', (x) => (x === 20 ? 0.2 : 0), false));
    await m.operation('open-roi', { path: '/d/p.nii.gz' });
    expect(kept(f)).toEqual([0, 0, 1]);
  });
  it('a multi-label file asks which label, and a job can name it', async () => {
    const { f, m } = setup();
    f.pending.set('/d/many.nii.gz', volumeOf('many.nii.gz', (x) => (x === 1 ? 3 : x === 11 ? 4 : 0)));
    await m.operation('open-roi', { path: '/d/many.nii.gz' });
    expect(m.state().choosing).toBe('many.nii.gz');
    expect(m.state().recipe.rules).toEqual([]);
    await m.operation('add-region', { volume: 'many.nii.gz', labels: '4' });
    expect(m.state().choosing).toBeNull();
    expect(kept(f)).toEqual([0, 1, 0]);
    await m.operation('clear', {});
    await m.operation('open-roi', { path: '/d/many.nii.gz', labels: '3' });
    expect(kept(f)).toEqual([1, 0, 0]);
    expect(f.calls.openFile).toBe(1);
  });
  it('says so when the file cannot be opened', async () => {
    const { m } = setup();
    await expect(m.operation('open-roi', { path: '/d/nope.nii' })).rejects.toThrow(/cannot open/);
  });
});

describe('the network', () => {
  it('assigns ends, selects an edge, and ANDs it with the rules', async () => {
    const { f, m } = setup();
    // Radial 1.5: the first streamline has x=1 (5) within reach of both ends; the second has x=10 (7) at one end only.
    await m.operation('connectome', { ...VOL, mode: 'radial', radiusMm: 1.5 });
    const c = m.state().connectome!;
    expect(c.nodes).toEqual([5]);
    expect([...c.edges.values()][0]).toMatchObject({ a: 5, b: 5, count: 1 });
    expect(m.state().regions).toEqual([5, 7]);
    expect(m.state().matrixSize).toBe(7);
    expect(m.state().summary).toEqual({ edges: 0, density: 0, assignedPct: (100 * 1) / 3 });
    await m.operation('select-edge', { a: 5, b: 5 });
    expect(kept(f)).toEqual([1, 0, 0]);
    expect(m.state().selectedEdge).toMatchObject({ a: 5, b: 5, count: 1 });
    await m.operation('add-region', { ...VOL, labels: '7' });
    expect(kept(f)).toEqual([0, 0, 0]);
  });
  it('clicking the selected edge again clears it; a region lists its connections', async () => {
    const { f, m } = setup();
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    expect(m.state().recipe.connectome.shown).toBeNull();
    expect(f.layers[0].keepField).toBeUndefined();
    await m.operation('select-edge', { a: 5 });
    expect(m.state().selectedRegion).toMatchObject({ id: 5, degree: 0, strength: 0 });
    expect(m.state().recipe.connectome.shown).toEqual([[5, 5]]);
  });
  it('weights, a sampled volume and a per-point field all cover the file, and a build reuses them', async () => {
    const fa = volumeOf('fa.nii.gz', (x) => x, false);
    const { f, m } = setup(
      {
        streamlineFields: { w: Float32Array.of(2, 3, 4) },
        vertexFields: { tsf: Float32Array.of(1, 1, 1, 2, 2, 2, 3, 3) },
      },
      [nodes(), fa]
    );
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    await m.operation('set-weights', { field: 'w' });
    expect([...m.state().connectome!.edges.values()][0]).toMatchObject({ weight: 2 });
    await m.operation('set-value', { volume: 'fa.nii.gz' });
    // The first streamline is along x from 0 to 2: length-weighted, the mean of x is 1.
    expect([...m.state().connectome!.edges.values()][0]!.value).toBeCloseTo(1, 5);
    expect(m.valueLabel()).toBe('fa');
    await m.operation('set-value', { field: 'tsf' });
    expect([...m.state().connectome!.edges.values()][0]!.value).toBe(1);
    const scans = f.calls.scan;
    await m.operation('set-value', { volume: 'fa.nii.gz' });
    expect(f.calls.scan).toBe(scans);
  });
  it('a value from a volume with points outside it counts them as 0, as tcksample', async () => {
    const half = volumeOf('half.nii.gz', () => 1, false);
    half.dims = [11, 1, 1];
    const { m } = setup({ offsets: Uint32Array.of(0, 2), points: Float32Array.of(9, 0, 0, 11, 0, 0) }, [volumeOf('n.nii.gz', () => 9), half]);
    await m.operation('connectome', { volume: 'n.nii.gz', mode: 'end' });
    await m.operation('set-value', { volume: 'half.nii.gz' });
    expect([...m.state().connectome!.edges.values()][0]!.value).toBeCloseTo(0.5, 5);
  });
  it('a pair attached from a file builds with no atlas, and a loaded weights file becomes the weights', async () => {
    const { f, m } = setup({}, []);
    f.attachable.set('/d/as[0].txt', { name: 'as[0]', values: Float32Array.of(1, 2, 0), perPoint: false });
    f.attachable.set('/d/as[1].txt', { name: 'as[1]', values: Float32Array.of(2, 1, 3), perPoint: false });
    f.attachable.set('/d/w.txt', { name: 'w', values: Float32Array.of(1, 1, 1), perPoint: false });
    await m.operation('attach', { path: '/d/as[0].txt' });
    await m.operation('attach', { path: '/d/as[1].txt' });
    await m.operation('connectome', { mode: 'pair', pair: 'as' });
    expect(m.state().connectome!.edges.size).toBe(1);
    expect(m.state().regions).toEqual([1, 2]);
    await m.operation('attach', { path: '/d/w.txt', use: 'weights' });
    expect(m.state().recipe.connectome.weightField).toBe('w');
  });
  it('writes connection groups only when asked', async () => {
    const { f, m } = setup();
    await m.operation('connectome', { ...VOL, radiusMm: 1.5, edgeField: true });
    expect([...f.written.get(EDGE_FIELD)!]).toEqual([1, 0, 0]);
    await m.operation('connectome', { edgeField: false });
    expect(f.written.has(EDGE_FIELD)).toBe(false);
  });
});

describe('region names', () => {
  it('uses the names the host gives a volume, says where they came from, and shows numbers without', async () => {
    const table = { entries: [], byId: new Map([[10, { id: 10, name: 'Left-Thalamus' }]]) };
    const assumed: FakeVolume = { ...volumeOf('aseg.nii.gz', (x) => (x === 1 ? 10 : 0)), labelTable: table, assumedLabelTable: table };
    const { m } = setup({}, [assumed]);
    await m.operation('connectome', { volume: 'aseg.nii.gz', radiusMm: 1.5 });
    expect(m.name(10)).toBe('Left-Thalamus');
    expect(m.name(99)).toBe('99');
    expect(m.state().namesFrom).toBe('FreeSurfer, assumed from label ids');
    expect(m.state().recipe.namesFrom).toBeNull();
  });
  it('names a region from its own atlas when two are open', async () => {
    const table = { entries: [], byId: new Map([[1, { id: 1, name: 'One' }]]) };
    const { m } = setup({}, [volumeOf('plain.nii.gz', (x) => (x === 1 ? 1 : 0)), { ...volumeOf('named.nii.gz', (x) => (x === 1 ? 1 : 0)), labelTable: table }]);
    await m.settled();
    expect(m.name(1, 'plain.nii.gz')).toBe('1');
    expect(m.name(1, 'named.nii.gz')).toBe('One');
  });
  it('a lookup table names regions, and the scene remembers it', async () => {
    const { f, m } = setup();
    f.files.set('/d/lut.txt', '5 Five 1 2 3 4\n7 Seven 1 2 3 4\n');
    await m.operation('load-names', { path: '/d/lut.txt' });
    expect(m.name(5)).toBe('Five');
    expect(m.state().recipe.namesFrom).toBe('lut.txt');
    await m.operation('add-region', { ...VOL, labels: '5' });
    expect(m.ruleName(m.state().recipe.rules[0]!)).toBe('Five (5)');
    expect(JSON.stringify(f.block())).toContain('Five');
  });
});

describe('saved tracts', () => {
  it('save, apply, rename, delete; a duplicate name or an empty filter is refused', async () => {
    const { f, m } = setup();
    await expect(m.operation('save-tract', { name: 'none' })).rejects.toThrow(/Nothing is filtered/);
    await m.operation('add-region', { ...VOL, labels: '5' });
    await m.operation('save-tract', { name: 'five' });
    expect(m.state().recipe.saved[0]).toMatchObject({ name: 'five', count: 1 });
    await expect(m.operation('save-tract', { name: 'five' })).rejects.toThrow(/already/);
    await m.operation('clear', {});
    expect(m.state().count).toBeNull();
    await m.operation('apply-tract', { name: 'five' });
    expect(kept(f)).toEqual([1, 0, 0]);
    await m.operation('rename-tract', { name: 'five', to: 'cinco' });
    expect(m.state().recipe.saved[0]!.name).toBe('cinco');
    await m.operation('delete-tract', { name: 'cinco' });
    expect(m.state().recipe.saved).toEqual([]);
  });
  it('ticks filter, save as one tract and come back; ticking every connection is no filter', async () => {
    // This file has one connection, so the set worth saving is the empty one; `e2e` has real sets.
    const { f, m } = setup();
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    await m.run('show-edges', { action: 'hide' });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toEqual([]);
    expect(kept(f)).toEqual([0, 0, 0]);
    await m.operation('add-connection', {});
    const name = m.state().recipe.saved[0]!.name;
    expect(name).toMatch(/^network_\d{8}_\d{4}$/);
    expect(m.state().recipe.saved[0]).toMatchObject({ count: 0, connection: { pairs: [] } });
    await m.run('show-edges', { action: 'show', pairs: [[5, 5]] });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toBeNull();
    expect(kept(f)).toEqual([]);
    await m.operation('apply-tract', { name });
    expect(m.state().recipe.connectome.shown).toEqual([]);
    expect(kept(f)).toEqual([0, 0, 0]);
    await m.operation('clear', {});
    expect(m.state().recipe.connectome.shown).toBeNull();
  });
  it('a rule follows a rebuild, and a click starts then toggles a choice', async () => {
    const { m } = setup();
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    await m.run('choose', { from: [5], to: [], minN: 1 });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toEqual([[5, 5]]);
    await m.run('choose', { minN: 2 });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toEqual([]);
    await m.run('clear-edge', {});
    await m.settled();
    expect(m.state().recipe.connectome.shown).toBeNull();
    expect(m.state().recipe.connectome.choose.from).toEqual([]);
    await m.run('choose', { from: [5], minN: 1 });
    await m.run('choose', { from: [] });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toBeNull();
    await m.run('pick-edge', { a: 5, b: 5 });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toEqual([[5, 5]]);
    expect(m.state().selectedEdge).toMatchObject({ a: 5, b: 5, count: 1 });
    await m.run('pick-edge', { a: 5, b: 5 });
    await m.settled();
    expect(m.state().recipe.connectome.shown).toBeNull();
  });
  it('a scene saved with one selected connection or region comes back as a choice', () => {
    expect(upgradeRecipe({ connectome: { selected: { a: 5, b: 7 } } }).connectome.shown).toEqual([[5, 7]]);
    const region = upgradeRecipe({ connectome: { selected: { a: 5, b: null } } }).connectome;
    expect(region.choose).toMatchObject({ from: [5] });
    expect(region).not.toHaveProperty('selected');
  });
  it('a selected connection saves as itself and comes back', async () => {
    const { f, m } = setup();
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    await m.operation('add-connection', { name: 'loop' });
    await m.operation('clear-edge', {});
    expect(kept(f)).toEqual([]);
    await m.operation('apply-tract', { name: 'loop' });
    expect(kept(f)).toEqual([1, 0, 0]);
    expect(m.state().selectedEdge).toMatchObject({ a: 5, b: 5 });
  });
});

describe('export', () => {
  const folder = (): string => mkdtempSync(join(tmpdir(), 'tt-model-'));
  it('writes the whole plan, with .tck for each saved tract and the current filter, whatever is held', async () => {
    const dir = folder();
    const { f, m } = setup({ held: Uint32Array.of(2) }, [nodes()], { folder: dir });
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    await m.operation('add-region', { ...VOL, labels: '7' });
    await m.operation('save-tract', { name: 'seven strong' });
    await m.operation('clear', {});
    await m.operation('add-region', { ...VOL, labels: '5' });
    await m.settled();
    await m.run('export-folder');
    const result = m.state().exportResult!;
    expect(result.failed).toBeNull();
    expect(result.finished.sort()).toEqual(['connectome_count.csv', 'connectome_length.csv', 'current_filter.tck', 'edges.csv', 'methods.txt', 'nodes.csv', 'recipe.json', 'seven_strong.tck', 'streamlines.csv'].sort());
    expect(readdirSync(dir).some((n) => n.endsWith('.part'))).toBe(false);
    const t = readTck(join(dir, 'seven_strong.tck'));
    expect([...t.offsets]).toEqual([0, 3]);
    expect([...t.points]).toEqual([10, 0, 0, 11, 0, 0, 12, 0, 0]);
    expect(t.header.find(([k]) => k === 'count')![1]).toBe('1');
    expect(t.header.find(([k]) => k === 'step_size')![1]).toBe('0.5');
    const rows = readFileSync(join(dir, 'streamlines.csv'), 'utf8').trim().split('\n');
    expect(rows[0]).toBe('file_index,tracts,length_mm,node_a,node_b');
    expect(rows.slice(1)).toEqual(['0,current_filter,2,5,5', '1,seven strong,2,7,0']);
    expect(readFileSync(join(dir, 'connectome_count.csv'), 'utf8').trim().split('\n')).toHaveLength(7);
    expect(readFileSync(join(dir, 'methods.txt'), 'utf8')).toContain('all 3 streamlines');
    expect(JSON.parse(readFileSync(join(dir, 'recipe.json'), 'utf8')).recipe.saved[0].name).toBe('seven strong');
    expect(f.calls.chooseFolder).toBe(1);
  });
  it('with nothing filtered, streamlines.csv is every streamline', async () => {
    const dir = folder();
    const { m } = setup({}, [nodes()], { folder: dir });
    await m.settled();
    await m.run('export-folder');
    expect(readFileSync(join(dir, 'streamlines.csv'), 'utf8').trim().split('\n')).toHaveLength(4);
    expect(existsSync(join(dir, 'connectome_count.csv'))).toBe(false);
  });
  it('asks before replacing anything, and a refusal touches nothing', async () => {
    const dir = folder();
    const { f, m } = setup({}, [nodes()], { folder: dir });
    await m.settled();
    await m.run('export-folder');
    const before = readFileSync(join(dir, 'recipe.json'), 'utf8');
    await m.run('set-export', { record: true });
    f.setConfirm(1);
    await m.run('export-folder');
    expect(f.confirms).toHaveLength(1);
    expect(f.confirms[0]).toContain('methods.txt');
    expect(m.state().exportResult?.cancelled).toBe(true);
    expect(readFileSync(join(dir, 'recipe.json'), 'utf8')).toBe(before);
    f.setConfirm(0);
    await m.run('export-folder');
    expect(f.confirms).toHaveLength(2);
    expect(m.state().exportResult?.cancelled).toBe(false);
    expect(m.state().exportResult?.finished).toContain('methods.txt');
  });
  it('a failure stops, removes what was open, and says which files finished', async () => {
    const dir = folder();
    const { f, m } = setup({}, [nodes()], { folder: dir });
    await m.operation('add-region', { ...VOL, labels: '5' });
    f.setFailWrite((name) => name === 'current_filter.tck');
    await m.run('export-folder');
    const r = m.state().exportResult!;
    expect(r.failed).toMatch(/disk full/);
    expect(r.finished).toContain('methods.txt');
    expect(r.finished).not.toContain('current_filter.tck');
    expect(readdirSync(dir).filter((n) => n.includes('current_filter'))).toEqual([]);
    expect(m.state().message).toMatch(/Export stopped/);
  });
  it('a job writes each table under its own name, and is told why it cannot write .tck', async () => {
    const { f, m } = setup();
    await m.operation('connectome', { ...VOL, radiusMm: 1.5 });
    for (const what of ['count', 'length', 'edges', 'nodes', 'streamlines', 'methods', 'recipe', 'svg']) {
      await m.operation('export-file', { what, out: `/o/${what}` });
      expect(f.files.get(`/o/${what}`)?.length).toBeGreaterThan(0);
    }
    await expect(m.operation('export-file', { what: 'weight', out: '/o/w' })).rejects.toThrow(/weights/);
    await expect(m.operation('export-file', { what: 'tck', out: '/o/t.tck' })).rejects.toThrow(/cannot write \.tck/);
    await expect(m.operation('export-file', { what: 'nonsense', out: '/o/n' })).rejects.toThrow(/Unknown/);
  });
  it('the kept streamlines as one row of 0 and 1, in file order, over the whole file', async () => {
    const { f, m } = setup({ held: Uint32Array.of(2) });
    await m.operation('add-sphere', { center: [1, 0, 0], radiusMm: 0.5 });
    await m.operation('export-selection', { out: '/x/s.txt' });
    expect(f.files.get('/x/s.txt')).toBe('1 0 0\n');
  });
  it('sizes the matrix to the atlas\'s largest id, as tck2connectome does', async () => {
    const { f, m } = setup();
    await m.operation('connectome', { ...VOL, mode: 'radial', radiusMm: 1.5 });
    await m.operation('export-matrix', { out: '/x/m.csv' });
    expect(f.files.get('/x/m.csv')!.trim().split('\n')).toHaveLength(7);
  });
});

describe('statistics for a job', () => {
  it('writes <field>:<stat> to held streamlines from the whole file, and rejects an unknown one', async () => {
    const { f, m } = setup({ vertexFields: { fa: Float32Array.of(0, 5, 0, 7, 0, 0, 0, 0) }, held: Uint32Array.of(1, 0) });
    await m.operation('stats', { field: 'fa', stats: 'max' });
    expect([...f.written.get('fa:max')!]).toEqual([7, 5]);
    await expect(m.operation('stats', { field: 'fa', stats: 'mode' })).rejects.toThrow(/mode/);
  });
});

describe('persistence', () => {
  it('the block holds names, never ids, and restoring recomputes', async () => {
    const { f, m } = setup();
    await m.operation('add-region', { ...VOL, labels: '5' });
    await m.operation('connectome', { ...VOL, mode: 'radial', radiusMm: 1.5 });
    await m.operation('select-edge', { a: 5, b: 5 });
    await m.operation('save-tract', { name: 'kept' });
    const text = JSON.stringify(f.block());
    expect(text).toContain('nodes.nii.gz');
    expect(text).not.toContain('"V1"');
    expect(text).not.toContain('"T1"');
    const g = setup();
    await g.m.restore({ module: 'tetravox.tract-tools', version: 1, moduleVersion: '0.2.0', data: f.block() } as ExtensionBlock);
    await g.m.settled();
    expect(kept(g.f)).toEqual([1, 0, 0]);
    expect(g.m.state().connectome?.nodes).toEqual([5]);
    expect(g.m.state().recipe.saved[0]!.name).toBe('kept');
  });
  it('waits for a named volume to open, then recomputes', async () => {
    const { f, m } = setup();
    await m.operation('add-region', { ...VOL, labels: '5' });
    const g = setup({}, []);
    await g.m.restore({ module: 'tetravox.tract-tools', version: 1, moduleVersion: '0.2.0', data: f.block() } as ExtensionBlock);
    await g.m.settled();
    expect(g.m.state().message).toMatch(/nodes\.nii\.gz/);
    expect(g.f.written.has(SELECTED_FIELD)).toBe(false);
    g.f.datasets.push({ kind: 'volume', id: 'V9', ...nodes() });
    g.f.emit('datasets');
    await g.m.settled();
    expect(kept(g.f)).toEqual([1, 0, 0]);
    expect(g.m.state().message).toBeNull();
  });
  it('restores a block written by 0.1.0', async () => {
    const { f, m } = setup();
    await m.restore({
      module: 'tetravox.tract-tools',
      version: 1,
      moduleVersion: '0.1.0',
      data: { tract: 'a.tck', rules: [{ kind: 'region', effect: 'include', endsOnly: false, volume: 'nodes.nii.gz', labels: [5] }], minMm: null, maxMm: null, connectome: { volume: 'nodes.nii.gz', mode: 'radial', radiusMm: 1.5, pair: null, weightField: null, metricField: null, edgeField: false, log: true, on: true, selected: null }, stats: [], names: [] },
    } as ExtensionBlock);
    await m.settled();
    expect(kept(f)).toEqual([1, 0, 0]);
    expect(m.state().connectome?.nodes).toEqual([5]);
  });
});
