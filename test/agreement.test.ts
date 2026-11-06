// The model over the real whole tractogram and the real aseg, its exports read back by a numpy script against what
// MRtrix 3.0.8 wrote (scripts/reference/whole_refs.sh). Runs here on this repo's own test sampler; e2e/whole.spec.ts is
// the same comparison through the real app and engine.
//
//   MRTRIX_BIN=<dir> scripts/reference/whole_refs.sh <refs>
//   TRACT_TOOLS_WHOLE=<refs> pnpm exec vitest run test/agreement.test.ts --disable-console-intercept
//
// TRACT_TOOLS_TCK, _ASEG, _FA, _WEIGHTS override the inputs as whole_refs.sh does. Synthetic behaviour: model.test.ts.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModel } from '../src/model';
import { fakeHost } from './fakeHost';
import { numbersIn, readNifti, readTck } from './files';

const refs = process.env['TRACT_TOOLS_WHOLE'];
if (refs === undefined) console.log('skipping: TRACT_TOOLS_WHOLE is unset');

const D = '/Users/idohaber/datasets/000/derivatives';
const TCK = process.env['TRACT_TOOLS_TCK'] ?? `${D}/ti-toolbox/tract_validation/mrtrix_ref/tracks_ifod2_200k.tck`;
const ASEG = process.env['TRACT_TOOLS_ASEG'] ?? `${D}/qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-aseg_dseg.nii.gz`;
const FA = process.env['TRACT_TOOLS_FA'] ?? `${D}/ti-toolbox/tract_validation/mrtrix_ref/fa.nii.gz`;
const SCRIPT = resolve('scripts/reference/compare_export.py');

describe.skipIf(refs === undefined)('agreement with MRtrix 3.0.8 over the whole file', () => {
  it('every number', async () => {
    const tck = readTck(TCK);
    const n = tck.offsets.length - 1;
    const weights = Float32Array.from(numbersIn(join(refs!, 'weights.txt')));
    expect(weights.length).toBe(n);
    const dirA = mkdtempSync(join(tmpdir(), 'tt-agree-network-'));
    const dirB = mkdtempSync(join(tmpdir(), 'tt-agree-tracts-'));
    const aseg = readNifti(ASEG, 'aseg.nii.gz', true);
    const fa = readNifti(FA, 'fa.nii.gz', false);
    let f = fakeHost(
      { name: 'whole.tck', offsets: tck.offsets, points: tck.points, headerJson: JSON.stringify(tck.header), streamlineFields: { weights } },
      [aseg, fa],
      { folder: dirA }
    );
    let m = createModel(f.host);
    await m.operation('connectome', { volume: 'aseg.nii.gz', mode: 'radial', radiusMm: 4 });
    await m.operation('set-weights', { field: 'weights' });
    await m.operation('set-value', { volume: 'fa.nii.gz' });
    await m.run('set-export', { figure: false });
    await m.settled();
    await m.run('export-folder');
    expect(m.state().exportResult?.failed).toBeNull();
    const toFile = async (op: string, args: object, out: string): Promise<void> => {
      await m.operation(op, { ...args, out });
      writeFileSync(join(dirA, out), f.files.get(out)!);
    };
    await toFile('export-file', { what: 'count', symmetric: true }, 'connectome_count_sym.csv');
    await m.operation('connectome', { volume: 'aseg.nii.gz', mode: 'end' });
    await toFile('export-file', { what: 'count' }, 'connectome_end.csv');
    m.dispose();

    f = fakeHost({ name: 'whole.tck', offsets: tck.offsets, points: tck.points, headerJson: JSON.stringify(tck.header) }, [aseg], { folder: dirB });
    m = createModel(f.host);
    const recipes = JSON.parse(readFileSync('scripts/reference/tracts.json', 'utf8')) as { tracts: Record<string, [string, Record<string, unknown>][]> };
    for (const [name, ops] of Object.entries(recipes.tracts)) {
      for (const [op, args] of ops) await m.operation(op, op === 'add-region' ? { ...args, volume: 'aseg.nii.gz' } : args);
      await m.operation('save-tract', { name });
      await m.operation('clear', {});
    }
    await m.settled();
    await m.run('export-folder');
    expect(m.state().exportResult?.failed).toBeNull();
    m.dispose();

    const python = process.env['TRACT_TOOLS_PYTHON'] ?? 'python3';
    const bin = process.env['MRTRIX_BIN'];
    for (const dir of [dirA, dirB]) {
      const run = spawnSync(python, [SCRIPT, dir, refs!, ...(bin === undefined ? [] : ['--mrtrix-bin', bin])], { encoding: 'utf8' });
      console.log(run.stdout, run.stderr);
      expect(run.status).toBe(0);
    }
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }, 1_800_000);
});
