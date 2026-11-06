// Readers for real-data tests. Nothing here shares code with src/: TCK and NIfTI per their specifications.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { FakeVolume } from './fakeHost';

export function readTck(path: string): { offsets: Uint32Array; points: Float32Array; header: [string, string][] } {
  const raw = readFileSync(path);
  const end = raw.indexOf('\nEND\n');
  const lines = raw.subarray(0, end).toString('latin1').split('\n').slice(1);
  const header = lines.map((l): [string, string] => {
    const at = l.indexOf(': ');
    return [l.slice(0, at), l.slice(at + 2)];
  });
  const file = header.find(([k]) => k === 'file')![1].split(' ')[1]!;
  const data = new Float32Array(raw.buffer.slice(raw.byteOffset + Number(file), raw.byteOffset + raw.length));
  const offsets: number[] = [0];
  const points = new Float32Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i += 3) {
    const x = data[i]!;
    if (Number.isNaN(x)) offsets.push(n);
    else if (x === Infinity) break;
    else {
      points[n * 3] = x;
      points[n * 3 + 1] = data[i + 1]!;
      points[n * 3 + 2] = data[i + 2]!;
      n += 1;
    }
  }
  return { offsets: Uint32Array.from(offsets), points: points.slice(0, n * 3), header };
}

/** World from sform, as the app's reader does for these files. Column-major, like the engine's mat4. */
export function readNifti(path: string, name: string, isLabel: boolean): FakeVolume {
  const raw = gunzipSync(readFileSync(path));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const dims: [number, number, number] = [dv.getInt16(42, true), dv.getInt16(44, true), dv.getInt16(46, true)];
  const datatype = dv.getInt16(70, true);
  const offset = dv.getFloat32(108, true);
  const row = (at: number): number[] => [0, 1, 2, 3].map((i) => dv.getFloat32(at + i * 4, true));
  const [r0, r1, r2] = [row(280), row(296), row(312)] as [number[], number[], number[]];
  const affine = [r0[0]!, r1[0]!, r2[0]!, 0, r0[1]!, r1[1]!, r2[1]!, 0, r0[2]!, r1[2]!, r2[2]!, 0, r0[3]!, r1[3]!, r2[3]!, 1];
  const inverseAffine = invert(affine);
  const count = dims[0] * dims[1] * dims[2];
  const body = raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + count * (datatype === 4 ? 2 : datatype === 2 ? 1 : 4));
  const data = datatype === 4 ? new Int16Array(body) : datatype === 2 ? new Uint8Array(body) : new Float32Array(body);
  const labelIds = isLabel ? Uint32Array.from(new Set(Array.from(data, Math.round))).sort() : undefined;
  return { name, dims, affine, inverseAffine, data, isLabel, ...(labelIds === undefined ? {} : { labelIds }), path };
}

function invert(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[12]!, m[13]!, m[14]!];
  const tr = [0, 1, 2].map((k) => -(r[k * 3]! * t[0]! + r[k * 3 + 1]! * t[1]! + r[k * 3 + 2]! * t[2]!));
  return [r[0]!, r[3]!, r[6]!, 0, r[1]!, r[4]!, r[7]!, 0, r[2]!, r[5]!, r[8]!, 0, tr[0]!, tr[1]!, tr[2]!, 1];
}

export const numbersIn = (path: string): number[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .trim()
    .split(/\s+/)
    .map(Number);
