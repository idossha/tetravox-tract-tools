// `tck2connectome` assignment and matrix, and `connectome2tck`'s question: which streamlines are in this edge?

/** Nearest-neighbour values at world points. NaN outside the volume. At most `MAX_SAMPLE_POINTS` per call. */
export type Sampler = (worldPoints: Float32Array) => Promise<Float32Array>;

/** `scene.sampleVolume`'s bound. */
export const MAX_SAMPLE_POINTS = 2_000_000;

export interface VolumeGeometry {
  dims: readonly number[];
  /** Column-major, as the engine's mat4. */
  affine: ArrayLike<number>;
  inverseAffine: ArrayLike<number>;
}

const label = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** Endpoints as `[x0,y0,z0, x1,y1,z1, ...]`, two per streamline; the result is one node per endpoint, 0 = none. */
export async function assignEndVoxel(endpoints: Float32Array, sample: Sampler): Promise<Int32Array> {
  const n = endpoints.length / 3;
  const out = new Int32Array(n);
  for (let at = 0; at < n; at += MAX_SAMPLE_POINTS) {
    const count = Math.min(MAX_SAMPLE_POINTS, n - at);
    const values = await sample(endpoints.subarray(at * 3, (at + count) * 3));
    for (let i = 0; i < count; i += 1) out[at + i] = label(values[i]!);
  }
  return out;
}

interface Offset {
  i: number;
  j: number;
  k: number;
  norm: number;
}

/** Voxel offsets able to hold a centre closer than the radius, nearest first. */
export function radialOffsets(geom: VolumeGeometry, radiusMm: number): { offsets: Offset[]; halfDiagonal: number } {
  const a = geom.affine;
  const lin = (i: number, j: number, k: number): number =>
    Math.hypot(a[0]! * i + a[4]! * j + a[8]! * k, a[1]! * i + a[5]! * j + a[9]! * k, a[2]! * i + a[6]! * j + a[10]! * k);
  const si = lin(1, 0, 0);
  const sj = lin(0, 1, 0);
  const sk = lin(0, 0, 1);
  let halfDiagonal = 0;
  for (const [x, y, z] of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]] as const) {
    halfDiagonal = Math.max(halfDiagonal, 0.5 * lin(x, y, z));
  }
  const reach = radiusMm + halfDiagonal;
  const ni = Math.ceil(reach / si);
  const nj = Math.ceil(reach / sj);
  const nk = Math.ceil(reach / sk);
  const offsets: Offset[] = [];
  for (let i = -ni; i <= ni; i += 1) {
    for (let j = -nj; j <= nj; j += 1) {
      for (let k = -nk; k <= nk; k += 1) {
        const norm = lin(i, j, k);
        if (norm < reach) offsets.push({ i, j, k, norm });
      }
    }
  }
  offsets.sort((p, q) => p.norm - q.norm);
  return { offsets, halfDiagonal };
}

/**
 * tck2connectome's radial search: the labelled voxel whose centre is nearest the endpoint, strictly
 * within the radius. Offsets are walked in shells of increasing distance and each shell samples only the
 * endpoints still able to improve, which is what keeps the sampled point count near the unresolved set.
 */
export async function assignRadial(
  endpoints: Float32Array,
  geom: VolumeGeometry,
  radiusMm: number,
  sample: Sampler
): Promise<Int32Array> {
  const n = endpoints.length / 3;
  const out = new Int32Array(n);
  const best = new Float64Array(n).fill(radiusMm);
  const { offsets, halfDiagonal } = radialOffsets(geom, radiusMm);
  const m = geom.inverseAffine;
  const a = geom.affine;
  const vox = new Int32Array(n * 3);
  for (let p = 0; p < n; p += 1) {
    const x = endpoints[p * 3]!;
    const y = endpoints[p * 3 + 1]!;
    const z = endpoints[p * 3 + 2]!;
    vox[p * 3] = Math.round(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!);
    vox[p * 3 + 1] = Math.round(m[1]! * x + m[5]! * y + m[9]! * z + m[13]!);
    vox[p * 3 + 2] = Math.round(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
  }
  let active = Array.from({ length: n }, (_, p) => p);
  const [di, dj, dk] = geom.dims as [number, number, number];
  const shellWidth = Math.max(1e-3, Math.min(1, halfDiagonal));

  const flushCap = MAX_SAMPLE_POINTS;
  const world = new Float32Array(Math.min(flushCap, 4_194_304) * 3);
  const owner = new Int32Array(world.length / 3);
  const distance = new Float64Array(world.length / 3);
  let held = 0;
  const flush = async (): Promise<void> => {
    if (held === 0) return;
    const values = await sample(world.subarray(0, held * 3));
    for (let i = 0; i < held; i += 1) {
      const node = label(values[i]!);
      const p = owner[i]!;
      if (node !== 0 && distance[i]! < best[p]!) {
        best[p] = distance[i]!;
        out[p] = node;
      }
    }
    held = 0;
  };

  let at = 0;
  while (at < offsets.length && active.length > 0) {
    const shell = Math.floor(offsets[at]!.norm / shellWidth);
    let end = at;
    while (end < offsets.length && Math.floor(offsets[end]!.norm / shellWidth) === shell) end += 1;
    for (const p of active) {
      const x = endpoints[p * 3]!;
      const y = endpoints[p * 3 + 1]!;
      const z = endpoints[p * 3 + 2]!;
      for (let o = at; o < end; o += 1) {
        const off = offsets[o]!;
        const i = vox[p * 3]! + off.i;
        const j = vox[p * 3 + 1]! + off.j;
        const k = vox[p * 3 + 2]! + off.k;
        if (i < 0 || j < 0 || k < 0 || i >= di || j >= dj || k >= dk) continue;
        const wx = a[0]! * i + a[4]! * j + a[8]! * k + a[12]!;
        const wy = a[1]! * i + a[5]! * j + a[9]! * k + a[13]!;
        const wz = a[2]! * i + a[6]! * j + a[10]! * k + a[14]!;
        const d = Math.hypot(wx - x, wy - y, wz - z);
        if (d >= best[p]!) continue;
        world[held * 3] = wx;
        world[held * 3 + 1] = wy;
        world[held * 3 + 2] = wz;
        owner[held] = p;
        distance[held] = d;
        held += 1;
        if (held === owner.length) await flush();
      }
    }
    await flush();
    at = end;
    if (at < offsets.length) {
      // Any later centre is at least `norm - halfDiagonal` from an endpoint inside its voxel.
      const floor = offsets[at]!.norm - halfDiagonal;
      active = active.filter((p) => floor < best[p]!);
    }
  }
  return out;
}

/** A precomputed `-out_assignments` pair: `name[0]`, `name[1]`, one value each per streamline. */
export function assignFromPair(first: Float32Array, second: Float32Array): Int32Array {
  const out = new Int32Array(first.length * 2);
  for (let s = 0; s < first.length; s += 1) {
    out[s * 2] = label(first[s]!);
    out[s * 2 + 1] = label(second[s]!);
  }
  return out;
}

export interface Edge {
  a: number;
  b: number;
  count: number;
  /** Sum of weights; equals `count` with no weight field. */
  weight: number;
  /** Weighted mean of the metric field, or NaN with none. */
  metric: number;
}

export interface Connectome {
  /** Ids with at least one assigned endpoint on a counted streamline, ascending. */
  nodes: number[];
  /** Keyed by {@link edgeKey}. */
  edges: Map<number, Edge>;
}

export const edgeKey = (a: number, b: number): number => (a <= b ? a * 2 ** 26 + b : b * 2 ** 26 + a);

/** A streamline with an unassigned end joins nothing. Self-connections stay, as tck2connectome's diagonal. */
export function buildConnectome(
  assign: Int32Array,
  opts: { weights?: Float32Array | null | undefined; metric?: Float32Array | null | undefined } = {}
): Connectome {
  const edges = new Map<number, Edge & { sum: number; metricWeight: number }>();
  const nodes = new Set<number>();
  const n = assign.length / 2;
  for (let s = 0; s < n; s += 1) {
    const u = assign[s * 2]!;
    const v = assign[s * 2 + 1]!;
    if (u === 0 || v === 0) continue;
    const w = opts.weights == null ? 1 : opts.weights[s]!;
    if (!Number.isFinite(w)) continue;
    const key = edgeKey(u, v);
    let e = edges.get(key);
    if (e === undefined) {
      e = { a: Math.min(u, v), b: Math.max(u, v), count: 0, weight: 0, metric: NaN, sum: 0, metricWeight: 0 };
      edges.set(key, e);
      nodes.add(u);
      nodes.add(v);
    }
    e.count += 1;
    e.weight += w;
    const value = opts.metric == null ? NaN : opts.metric[s]!;
    if (Number.isFinite(value)) {
      e.sum += value * w;
      e.metricWeight += w;
    }
  }
  for (const e of edges.values()) if (e.metricWeight > 0) e.metric = e.sum / e.metricWeight;
  return { nodes: [...nodes].sort((p, q) => p - q), edges };
}

/** 1 where the streamline is in the edge (`b` given) or touches the node (`b` null). */
export function edgeMask(assign: Int32Array, a: number, b: number | null): Uint8Array {
  const n = assign.length / 2;
  const mask = new Uint8Array(n);
  for (let s = 0; s < n; s += 1) {
    const u = assign[s * 2]!;
    const v = assign[s * 2 + 1]!;
    if (u === 0 || v === 0) continue;
    if (b === null ? u === a || v === a : (u === a && v === b) || (u === b && v === a)) mask[s] = 1;
  }
  return mask;
}

/** `edge` for the existing group controls: one id per distinct edge, in key order, 0 = unassigned. */
export function edgeCategories(assign: Int32Array): { ids: Float32Array; names: Map<number, [number, number]> } {
  const n = assign.length / 2;
  const keys = new Map<number, [number, number]>();
  for (let s = 0; s < n; s += 1) {
    const u = assign[s * 2]!;
    const v = assign[s * 2 + 1]!;
    if (u !== 0 && v !== 0) keys.set(edgeKey(u, v), [Math.min(u, v), Math.max(u, v)]);
  }
  const order = [...keys.keys()].sort((p, q) => p - q);
  const idOf = new Map(order.map((k, i) => [k, i + 1]));
  const ids = new Float32Array(n);
  for (let s = 0; s < n; s += 1) {
    const u = assign[s * 2]!;
    const v = assign[s * 2 + 1]!;
    if (u !== 0 && v !== 0) ids[s] = idOf.get(edgeKey(u, v))!;
  }
  return { ids, names: new Map(order.map((k, i) => [i + 1, keys.get(k)!])) };
}
