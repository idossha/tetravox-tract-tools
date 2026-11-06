// Which streamlines a set of rules keeps: a live `tckedit`, indexed by the streamline's place in the file.

export type Effect = 'include' | 'exclude';
/** Passes through; an end is in (`tckedit -ends_only`); both ends are in. */
export type RuleMode = 'through' | 'ends' | 'both';
export const RULE_MODES: readonly RuleMode[] = ['through', 'ends', 'both'];

export interface SphereRule {
  kind: 'sphere';
  effect: Effect;
  mode: RuleMode;
  center: [number, number, number];
  radiusMm: number;
  /** `point` is tckedit's test; `segment` also counts a segment crossing the sphere between two points. */
  test: 'segment' | 'point';
}

export interface RegionRule {
  kind: 'region';
  effect: Effect;
  mode: RuleMode;
  /** The volume by file name: dataset ids do not survive a scene reload. */
  volume: string;
  /** Empty means every nonzero voxel: a mask. */
  labels: number[];
}

export type Rule = SphereRule | RegionRule;

export interface StreamlineSpan {
  offsets: Uint32Array;
  first: number;
  /** Exclusive. */
  last: number;
  /** Index of the point `values[0]` / `points[0..2]` is. */
  pointBase: number;
}

/** A chunk of a scan as a span: its offsets start at 0. */
export const spanOf = (offsets: Uint32Array): StreamlineSpan => ({
  offsets,
  first: 0,
  last: offsets.length - 1,
  pointBase: 0,
});

/** A sphere's hits are bits, so changing a rule's mode needs no new scan. */
export const HIT_ANY = 1;
export const HIT_FIRST = 2;
export const HIT_LAST = 4;

const meets = (bits: number, mode: RuleMode): boolean =>
  mode === 'through'
    ? (bits & HIT_ANY) !== 0
    : mode === 'ends'
      ? (bits & (HIT_FIRST | HIT_LAST)) !== 0
      : (bits & (HIT_FIRST | HIT_LAST)) === (HIT_FIRST | HIT_LAST);

export const sphereKey = (r: Pick<SphereRule, 'center' | 'radiusMm' | 'test'>): string =>
  `${r.center.join(',')}:${r.radiusMm}:${r.test}`;

export function markSphere(
  hits: Uint8Array,
  span: StreamlineSpan,
  points: Float32Array,
  rule: Pick<SphereRule, 'center' | 'radiusMm' | 'test'>
): void {
  const { offsets, first, last, pointBase } = span;
  const [cx, cy, cz] = rule.center;
  const r2 = rule.radiusMm * rule.radiusMm;
  const inside = (i: number): boolean => {
    const dx = points[i * 3]! - cx;
    const dy = points[i * 3 + 1]! - cy;
    const dz = points[i * 3 + 2]! - cz;
    return dx * dx + dy * dy + dz * dz <= r2;
  };
  for (let s = first; s < last; s += 1) {
    const a = offsets[s]! - pointBase;
    const b = offsets[s + 1]! - pointBase;
    if (b === a) continue;
    let bits = (inside(a) ? HIT_FIRST | HIT_ANY : 0) | (inside(b - 1) ? HIT_LAST | HIT_ANY : 0);
    for (let i = a + 1; i + 1 < b && (bits & HIT_ANY) === 0; i += 1) if (inside(i)) bits |= HIT_ANY;
    if (rule.test === 'segment') {
      for (let i = a; i + 1 < b && (bits & HIT_ANY) === 0; i += 1) {
        const ax = points[i * 3]!;
        const ay = points[i * 3 + 1]!;
        const az = points[i * 3 + 2]!;
        const ux = points[i * 3 + 3]! - ax;
        const uy = points[i * 3 + 4]! - ay;
        const uz = points[i * 3 + 5]! - az;
        const len2 = ux * ux + uy * uy + uz * uz;
        const raw = len2 > 0 ? ((cx - ax) * ux + (cy - ay) * uy + (cz - az) * uz) / len2 : 0;
        const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        const dx = ax + t * ux - cx;
        const dy = ay + t * uy - cy;
        const dz = az + t * uz - cz;
        if (dx * dx + dy * dy + dz * dz <= r2) bits |= HIT_ANY;
      }
    }
    hits[s] = bits;
  }
}

export function sphereHits(bits: Uint8Array, mode: RuleMode): Uint8Array {
  const out = new Uint8Array(bits.length);
  for (let s = 0; s < bits.length; s += 1) if (meets(bits[s]!, mode)) out[s] = 1;
  return out;
}

/** What a voxel value means as a label: a nonzero value never rounds to "outside". */
export function labelOf(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const rounded = Math.round(value);
  return rounded === 0 ? 1 : rounded;
}

/** Per streamline, the labels it visits, plus those of its two ends: any region rule is answered from this. */
export interface RegionIndex {
  ptr: Uint32Array;
  labels: Int32Array;
  first: Int32Array;
  last: Int32Array;
}

export class RegionIndexBuilder {
  private readonly ptr: Uint32Array;
  private labels = new Int32Array(1 << 16);
  private used = 0;
  private readonly first: Int32Array;
  private readonly last: Int32Array;

  constructor(n: number) {
    this.ptr = new Uint32Array(n + 1);
    this.first = new Int32Array(n);
    this.last = new Int32Array(n);
  }

  /** `values` holds one sampled value per point of this chunk, whose offsets start at 0. */
  add(firstSource: number, offsets: Uint32Array, values: Float32Array): void {
    for (let c = 0; c + 1 < offsets.length; c += 1) {
      const a = offsets[c]!;
      const b = offsets[c + 1]!;
      const s = firstSource + c;
      const start = this.used;
      let previous = 0;
      for (let i = a; i < b; i += 1) {
        const label = labelOf(values[i]!);
        if (i === a) this.first[s] = label;
        if (i === b - 1) this.last[s] = label;
        // Runs are long: most points share the previous point's label.
        if (label === 0 || label === previous) {
          previous = label;
          continue;
        }
        previous = label;
        let seen = false;
        for (let j = start; j < this.used && !seen; j += 1) seen = this.labels[j] === label;
        if (seen) continue;
        if (this.used === this.labels.length) {
          const grown = new Int32Array(this.labels.length * 2);
          grown.set(this.labels);
          this.labels = grown;
        }
        this.labels[this.used] = label;
        this.used += 1;
      }
      this.ptr[s + 1] = this.used;
    }
  }

  finish(): RegionIndex {
    return { ptr: this.ptr, labels: this.labels.slice(0, this.used), first: this.first, last: this.last };
  }
}

export function regionHits(index: RegionIndex, labels: readonly number[], mode: RuleMode): Uint8Array {
  const n = index.first.length;
  const out = new Uint8Array(n);
  const wanted = labels.length === 0 ? null : new Set(labels);
  const has = (label: number): boolean => (wanted === null ? label !== 0 : wanted.has(label));
  for (let s = 0; s < n; s += 1) {
    let hit = false;
    if (mode === 'through') {
      for (let j = index.ptr[s]!; j < index.ptr[s + 1]! && !hit; j += 1) hit = has(index.labels[j]!);
    } else if (mode === 'ends') {
      hit = has(index.first[s]!) || has(index.last[s]!);
    } else {
      hit = has(index.first[s]!) && has(index.last[s]!);
    }
    if (hit) out[s] = 1;
  }
  return out;
}

/** Arc length: the sum of segment norms. */
export function lengthsInto(out: Float32Array, span: StreamlineSpan, points: Float32Array): void {
  const { offsets, first, last, pointBase } = span;
  for (let s = first; s < last; s += 1) {
    const a = offsets[s]! - pointBase;
    const b = offsets[s + 1]! - pointBase;
    let sum = 0;
    for (let i = a; i + 1 < b; i += 1) {
      const dx = points[i * 3 + 3]! - points[i * 3]!;
      const dy = points[i * 3 + 4]! - points[i * 3 + 1]!;
      const dz = points[i * 3 + 5]! - points[i * 3 + 2]!;
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    out[s] = sum;
  }
}

/**
 * tckedit widens `-minlength` / `-maxlength` by `step_size / (2 * downsample_factor)`, and by nothing
 * when the header has no `step_size` (measured with tckedit 3.0.8 by bisecting edited headers; see
 * README). Using it keeps the live count equal to the file tckedit would write.
 */
export function lengthToleranceMm(header: ReadonlyMap<string, string>): number {
  const step = Number(header.get('step_size'));
  if (!(step > 0)) return 0;
  const factor = Number(header.get('downsample_factor'));
  return step / (2 * (factor > 0 ? factor : 1));
}

/** TCK's `headerJson` is `[[key, value], ...]`; other formats carry something else and give an empty map. */
export function parseHeader(headerJson: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(headerJson);
    if (!Array.isArray(raw)) return out;
    for (const row of raw) {
      if (Array.isArray(row) && typeof row[0] === 'string') out.set(row[0], String(row[1]));
    }
  } catch {
    // Not JSON means no step size to honour, which is what an empty map says.
  }
  return out;
}

export interface Combine {
  n: number;
  includes: readonly Uint8Array[];
  excludes: readonly Uint8Array[];
  lengths?: Float32Array | undefined;
  minMm?: number | null | undefined;
  maxMm?: number | null | undefined;
  toleranceMm?: number | undefined;
  /** A further AND, e.g. the selected connection. */
  extra?: Uint8Array | null | undefined;
}

/** All includes met, no exclude met, length in range, `extra` met. */
export function combine(c: Combine): { keep: Uint8Array; count: number } {
  const lo = c.minMm == null ? -Infinity : c.minMm - (c.toleranceMm ?? 0);
  const hi = c.maxMm == null ? Infinity : c.maxMm + (c.toleranceMm ?? 0);
  const keep = new Uint8Array(c.n);
  let count = 0;
  outer: for (let s = 0; s < c.n; s += 1) {
    for (const m of c.includes) if (m[s] !== 1) continue outer;
    for (const m of c.excludes) if (m[s] === 1) continue outer;
    if (c.extra != null && c.extra[s] !== 1) continue;
    if (c.lengths !== undefined) {
      const l = c.lengths[s]!;
      if (l < lo || l > hi) continue;
    }
    keep[s] = 1;
    count += 1;
  }
  return { keep, count };
}

export function medianOf(values: Float32Array | number[]): number {
  if (values.length === 0) return NaN;
  const sorted = Float32Array.from(values).sort();
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : 0.5 * (sorted[n / 2 - 1]! + sorted[n / 2]!);
}

export interface Histogram {
  lo: number;
  hi: number;
  counts: number[];
}

export function histogramOf(values: ArrayLike<number>, bins: number, keep?: Uint8Array | null): Histogram {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo > hi) return { lo: 0, hi: 0, counts: new Array<number>(bins).fill(0) };
  lo = Math.floor(lo);
  hi = Math.max(Math.ceil(hi), lo + 1);
  const counts = new Array<number>(bins).fill(0);
  const scale = bins / (hi - lo);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (!Number.isFinite(v) || (keep != null && keep[i] !== 1)) continue;
    counts[Math.min(bins - 1, Math.floor((v - lo) * scale))]! += 1;
  }
  return { lo, hi, counts };
}
