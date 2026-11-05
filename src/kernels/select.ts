// Streamline selection: a live `tckedit`. Pure: typed arrays in, typed arrays out.

export type Effect = 'include' | 'exclude';

export interface SphereRule {
  kind: 'sphere';
  effect: Effect;
  endsOnly: boolean;
  center: [number, number, number];
  radiusMm: number;
  /** `segment` counts a segment crossing the sphere; `point` is tckedit's own test. */
  test: 'segment' | 'point';
}

export interface RegionRule {
  kind: 'region';
  effect: Effect;
  endsOnly: boolean;
  /** Label volume by file name: dataset ids do not survive a scene reload. */
  volume: string;
  labels: number[];
}

export type Rule = SphereRule | RegionRule;

export interface StreamlineSpan {
  offsets: Uint32Array;
  first: number;
  /** Exclusive. */
  last: number;
  /** Index of the point `values[0]` / `points[0..2]` is, within the whole tractogram. */
  pointBase: number;
}

/** The part of a rule that decides its hits; effect is applied at combination. */
export function ruleKey(rule: Rule): string {
  return rule.kind === 'sphere'
    ? `s:${rule.center.join(',')}:${rule.radiusMm}:${rule.test}:${rule.endsOnly}`
    : `r:${rule.volume}:${[...rule.labels].sort((a, b) => a - b).join(',')}:${rule.endsOnly}`;
}

export function markSphere(hits: Uint8Array, span: StreamlineSpan, points: Float32Array, rule: SphereRule): void {
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
    let hit = false;
    if (rule.endsOnly) {
      // A segment has no meaning at an end, so an end is always a point test.
      hit = inside(a) || inside(b - 1);
    } else if (rule.test === 'point') {
      for (let i = a; i < b && !hit; i += 1) hit = inside(i);
    } else {
      hit = inside(a);
      for (let i = a; i + 1 < b && !hit; i += 1) {
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
        hit = dx * dx + dy * dy + dz * dz <= r2;
      }
    }
    if (hit) hits[s] = 1;
  }
}

/** `values` holds one nearest label per point of the span. */
export function markRegion(
  hits: Uint8Array,
  span: StreamlineSpan,
  values: Float32Array,
  labels: ReadonlySet<number>,
  endsOnly: boolean
): void {
  const { offsets, first, last, pointBase } = span;
  for (let s = first; s < last; s += 1) {
    const a = offsets[s]! - pointBase;
    const b = offsets[s + 1]! - pointBase;
    if (b === a) continue;
    let hit = false;
    if (endsOnly) hit = labels.has(values[a]!) || labels.has(values[b - 1]!);
    else for (let i = a; i < b && !hit; i += 1) hit = labels.has(values[i]!);
    if (hit) hits[s] = 1;
  }
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
  /** A further AND, e.g. the selected connectome edge. */
  extra?: Uint8Array | null | undefined;
}

/** All includes met, no exclude met, length in range, `extra` met. One float per streamline: 1 or 0. */
export function combine(c: Combine): { selected: Float32Array; count: number } {
  const lo = c.minMm == null ? -Infinity : c.minMm - (c.toleranceMm ?? 0);
  const hi = c.maxMm == null ? Infinity : c.maxMm + (c.toleranceMm ?? 0);
  const selected = new Float32Array(c.n);
  let count = 0;
  outer: for (let s = 0; s < c.n; s += 1) {
    for (const m of c.includes) if (m[s] !== 1) continue outer;
    for (const m of c.excludes) if (m[s] === 1) continue outer;
    if (c.extra != null && c.extra[s] !== 1) continue;
    if (c.lengths !== undefined) {
      const l = c.lengths[s]!;
      if (l < lo || l > hi) continue;
    }
    selected[s] = 1;
    count += 1;
  }
  return { selected, count };
}
