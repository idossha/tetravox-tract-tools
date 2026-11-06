// One folder of plain files. Everything streams: a `.tck` of a whole file never exists in memory.

import type { ModuleFileWriter, ModuleFolder, TractScanChunk } from '@tetravox/module-sdk';
import { slug, tckChunk, tckEnd, tckHeader } from './kernels/export';

export interface ExportPlanItem {
  name: string;
  /** Text or bytes known before the scan; absent for a `.tck`. */
  content?: () => string | Uint8Array | Promise<string | Uint8Array>;
  /** Written streaming, line by line, off the UI thread's back. */
  stream?: (write: (text: string) => Promise<void>) => Promise<void>;
  tract?: { keep: Uint8Array; count: number };
}

export interface ExportHooks {
  scan(onChunk: (chunk: TractScanChunk) => Promise<void>, signal: AbortSignal): Promise<unknown>;
  progress(label: string, fraction: number): void;
  confirmOverwrite(names: string[]): Promise<boolean>;
  total: number;
  header: ReadonlyMap<string, string>;
  history: string;
  signal: AbortSignal;
}

export interface ExportOutcome {
  folder: string;
  finished: string[];
  failed: string | null;
  cancelled: boolean;
}

const encoder = new TextEncoder();
/** Writers open at once in main; a bigger export takes several scans. */
const MAX_OPEN = 24;
const TEXT_BLOCK = 1 << 20;

/** Unique, valid names: `seen` is case-insensitive because the disk may be. */
export function uniqueName(base: string, ext: string, seen: Set<string>): string {
  const stem = slug(base);
  let name = `${stem}.${ext}`;
  for (let i = 2; seen.has(name.toLowerCase()); i += 1) name = `${stem}_${i}.${ext}`;
  seen.add(name.toLowerCase());
  return name;
}

async function existing(folder: ModuleFolder, plan: ExportPlanItem[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of plan) {
    try {
      await (await folder.create(item.name)).abort();
    } catch (error) {
      if (!/exists/.test(error instanceof Error ? error.message : String(error))) throw error;
      out.push(item.name);
    }
  }
  return out;
}

export async function runExport(folder: ModuleFolder, plan: ExportPlanItem[], hooks: ExportHooks): Promise<ExportOutcome> {
  const finished: string[] = [];
  const open = new Set<ModuleFileWriter>();
  const outcome = (failed: string | null, cancelled = false): ExportOutcome => ({ folder: folder.path, finished, failed, cancelled });
  const clashes = await existing(folder, plan);
  if (clashes.length > 0 && !(await hooks.confirmOverwrite(clashes))) return outcome(null, true);
  const overwrite = new Set(clashes);
  const create = async (name: string): Promise<ModuleFileWriter> => {
    const w = await folder.create(name, { overwrite: overwrite.has(name) });
    open.add(w);
    return w;
  };
  const close = async (w: ModuleFileWriter, name: string): Promise<void> => {
    await w.close();
    open.delete(w);
    finished.push(name);
  };
  try {
    const known = plan.filter((p) => p.tract === undefined);
    for (let i = 0; i < known.length; i += 1) {
      const item = known[i]!;
      hooks.signal.throwIfAborted();
      hooks.progress(`Writing ${item.name}`, i / Math.max(1, plan.length));
      const w = await create(item.name);
      if (item.stream !== undefined) {
        let pending: string[] = [];
        let size = 0;
        const flush = async (): Promise<void> => {
          await w.write(encoder.encode(pending.join('')));
          pending = [];
          size = 0;
          hooks.signal.throwIfAborted();
        };
        await item.stream(async (text) => {
          pending.push(text);
          size += text.length;
          if (size >= TEXT_BLOCK) await flush();
        });
        if (size > 0) await flush();
      } else {
        const content = await item.content!();
        await w.write(typeof content === 'string' ? encoder.encode(content) : content);
      }
      await close(w, item.name);
    }
    const tracts = plan.filter((p) => p.tract !== undefined);
    for (let at = 0; at < tracts.length; at += MAX_OPEN) {
      const batch = tracts.slice(at, at + MAX_OPEN);
      const writers: ModuleFileWriter[] = [];
      for (const item of batch) {
        const w = await create(item.name);
        writers.push(w);
        await w.write(tckHeader(hooks.header, item.tract!.count, hooks.history));
      }
      await hooks.scan(async (chunk) => {
        hooks.progress(`Writing ${batch.length} .tck ${batch.length === 1 ? 'file' : 'files'}`, chunk.firstSource / hooks.total);
        for (let i = 0; i < batch.length; i += 1) {
          const bytes = tckChunk(chunk.offsets, chunk.positions, batch[i]!.tract!.keep, chunk.firstSource);
          if (bytes.length > 0) await writers[i]!.write(bytes);
        }
      }, hooks.signal);
      for (let i = 0; i < batch.length; i += 1) {
        await writers[i]!.write(tckEnd());
        await close(writers[i]!, batch[i]!.name);
      }
    }
    return outcome(null);
  } catch (error) {
    await Promise.all([...open].map((w) => w.abort().catch(() => undefined)));
    const cancelled = hooks.signal.aborted;
    return outcome(cancelled ? null : error instanceof Error ? error.message : String(error), cancelled);
  }
}
