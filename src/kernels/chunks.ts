// Reading a tractogram a chunk at a time, on whole-streamline boundaries.

/** `TRACT_READ_CHUNK` in the engine. */
export const READ_CHUNK = 1_000_000;

export interface Chunk {
  first: number;
  /** Exclusive. */
  last: number;
}

/** Spans of whole streamlines holding at most `maxPoints`, or one streamline when it alone is longer. */
export function planChunks(offsets: Uint32Array, maxPoints: number = READ_CHUNK): Chunk[] {
  const n = offsets.length - 1;
  const out: Chunk[] = [];
  let first = 0;
  while (first < n) {
    let last = first + 1;
    while (last < n && offsets[last + 1]! - offsets[first]! <= maxPoints) last += 1;
    out.push({ first, last });
    first = last;
  }
  return out;
}

/** A range of any length through a reader bounded at `READ_CHUNK` items. */
export async function readRange(
  read: (first: number, count: number) => Promise<Float32Array>,
  first: number,
  count: number,
  stride: number
): Promise<Float32Array> {
  if (count <= READ_CHUNK) return read(first, count);
  const out = new Float32Array(count * stride);
  for (let at = 0; at < count; at += READ_CHUNK) {
    out.set(await read(first + at, Math.min(READ_CHUNK, count - at)), at * stride);
  }
  return out;
}

export const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
