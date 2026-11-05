// What the Export buttons write. Refusals are strings: the panel shows them instead of truncating.

import { edgeKey } from './connectome';
import type { Connectome } from './connectome';

/** `main/module-io.ts`'s `MAX_MODULE_WRITE_BYTES`. */
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;

export type Written = { ok: true; text: string } | { ok: false; reason: string };

const tooBig = (what: string, bytes: number): Written => ({
  ok: false,
  reason: `${what} would be ${(bytes / 2 ** 20).toFixed(1)} MiB; Tetravox writes at most 8 MiB of text. Nothing was written.`,
});

/** tck2connectome's matrix, with both triangles: N rows of N, where N is the largest node id. */
export function matrixCsv(c: Connectome, size: number, value: 'count' | 'weight' | 'metric'): Written {
  const estimate = size * size * 2;
  if (estimate > MAX_WRITE_BYTES) return tooBig('The matrix', estimate);
  const rows: string[] = [];
  let bytes = 0;
  for (let i = 1; i <= size; i += 1) {
    const row = new Array<string>(size);
    for (let j = 1; j <= size; j += 1) {
      const e = c.edges.get(edgeKey(i, j));
      const v = e === undefined ? 0 : value === 'count' ? e.count : value === 'weight' ? e.weight : e.metric;
      row[j - 1] = Number.isFinite(v) ? String(v) : '0';
    }
    const line = row.join(',');
    bytes += line.length + 1;
    if (bytes > MAX_WRITE_BYTES) return tooBig('The matrix', Math.round((bytes * size) / i));
    rows.push(line);
  }
  return { ok: true, text: `${rows.join('\n')}\n` };
}

/**
 * One row of 0/1 in file order, for `tckedit in.tck out.tck -tck_weights_in this.txt -minweight 0.5`.
 * It needs every streamline in the file: a row for a budget subset would misalign against the `.tck`.
 */
export function selectionTxt(
  selected: Float32Array,
  sourceIndex: Uint32Array,
  sourceStreamlines: number
): Written {
  if (selected.length !== sourceStreamlines) {
    return {
      ok: false,
      reason: `Only ${selected.length.toLocaleString('en-US')} of ${sourceStreamlines.toLocaleString('en-US')} streamlines are held, so a row could not line up with the file. Raise the display budget to all of them first.`,
    };
  }
  const bytes = selected.length * 2;
  if (bytes > MAX_WRITE_BYTES) return tooBig('The selection', bytes);
  const row = new Array<string>(sourceStreamlines).fill('0');
  for (let s = 0; s < selected.length; s += 1) if (selected[s] === 1) row[sourceIndex[s]!] = '1';
  return { ok: true, text: `${row.join(' ')}\n` };
}
