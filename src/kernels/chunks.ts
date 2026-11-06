// Reading a host call bounded at some item count, and giving the UI thread a turn.

import { MAX_SAMPLE_POINTS } from './connectome';
import type { Sampler } from './connectome';

export const READ_CHUNK = 1_000_000;

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

/** Any number of xyz points through `sampleVolume`'s bound. */
export async function sampleAll(sample: Sampler, world: Float32Array): Promise<Float32Array> {
  const n = world.length / 3;
  if (n <= MAX_SAMPLE_POINTS) return sample(world);
  const out = new Float32Array(n);
  for (let at = 0; at < n; at += MAX_SAMPLE_POINTS) {
    out.set(await sample(world.subarray(at * 3, Math.min(n, at + MAX_SAMPLE_POINTS) * 3)), at);
  }
  return out;
}

export const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
