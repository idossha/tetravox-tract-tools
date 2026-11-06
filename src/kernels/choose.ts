// Choosing a network: From and To regions, and the clicks and ticks on top of them. All of it ends in
// one list of region pairs, which is what the views draw and the tracts export.

import { edgeKey } from './connectome';
import type { Edge, EdgePair } from './connectome';

export interface ChooseRecipe {
  from: number[];
  to: number[];
  minN: number;
}

export const DEFAULT_CHOOSE: ChooseRecipe = { from: [], to: [], minN: 5 };

type EdgeLike = Pick<Edge, 'a' | 'b' | 'count'>;
const pairOf = (e: Pick<Edge, 'a' | 'b'>): EdgePair => [e.a, e.b];

/** Every connection joining a From region to a To region; with no To, every one a From region has. */
export function fromToPairs(edges: readonly EdgeLike[], from: readonly number[], to: readonly number[], minN: number): EdgePair[] {
  const a = new Set(from);
  const b = new Set(to);
  const joins = (x: number, y: number): boolean => a.has(x) && (b.size === 0 || b.has(y));
  return edges.filter((e) => e.count >= minN && (joins(e.a, e.b) || joins(e.b, e.a))).map(pairOf);
}

/** Every word in the region's name, or the whole of its id, whatever the case. */
export function regionMatches(id: number, name: string, query: string): boolean {
  const text = name.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
    .every((word) => text.includes(word) || word === String(id));
}

/**
 * A click on a row or a matrix cell. With everything showing it starts a choice of that one, because
 * "all but this" is never what a click on a cell means; after that it toggles, and an empty choice is
 * no choice.
 */
export function pickPair(shown: readonly EdgePair[] | null, pair: EdgePair): EdgePair[] | null {
  if (shown === null) return [pair];
  const key = edgeKey(pair[0], pair[1]);
  const next = shown.filter(([a, b]) => edgeKey(a, b) !== key);
  if (next.length === shown.length) return [...shown, pair];
  return next.length === 0 ? null : next;
}

/** The colour the tract layer gives group `id`: `palette` in tvx-tract's `query.rs`. */
export function groupColor(id: number): [number, number, number] {
  const h = ((id * 0.618033988749895) % 1) * 6;
  const v = 0.95;
  const c = v * 0.7;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const rgb: [number, number, number][] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = rgb[Math.min(5, Math.floor(h))]!;
  const m = v - c;
  return [r + m, g + m, b + m].map((u) => Math.round(u * 255)) as [number, number, number];
}

/** `20261106_1130`, in local time: what a saved network or export is called until the user renames it. */
export function dateStamp(when: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}_${two(when.getHours())}${two(when.getMinutes())}`;
}
