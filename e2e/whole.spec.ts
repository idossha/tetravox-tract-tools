// The real file through the real app and engine, hidden: every streamline against MRtrix 3.0.8, timed, with the UI thread
// watched and the screenshots taken from it. Slow, so it needs its own variable.
//
//   MRTRIX_BIN=<dir> scripts/reference/whole_refs.sh <refs>
//   TRACT_TOOLS_WHOLE=<refs> TRACT_TOOLS_SHOTS=<dir> pnpm run e2e
// Skips without TRACT_TOOLS_WHOLE.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectNoOverflow, idle, install, launch, openFiles, operation, ready, REPO, setSize, shot, stubOpen, visible } from './harness';

const WHOLE = process.env['TRACT_TOOLS_WHOLE'];
const D = '/Users/idohaber/datasets/000/derivatives';
const TCK = process.env['TRACT_TOOLS_TCK'] ?? `${D}/ti-toolbox/tract_validation/mrtrix_ref/tracks_ifod2_200k.tck`;
const ASEG = process.env['TRACT_TOOLS_ASEG'] ?? `${D}/qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-aseg_dseg.nii.gz`;
const T1 = process.env['TRACT_TOOLS_T1'] ?? `${D}/qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-preproc_T1w.nii.gz`;
const FA = process.env['TRACT_TOOLS_FA'] ?? `${D}/ti-toolbox/tract_validation/mrtrix_ref/fa.nii.gz`;
const WEIGHTS = process.env['TRACT_TOOLS_WEIGHTS'] ?? `${D}/ti-toolbox/tract_validation/mrtrix_ref/sift2_weights.txt`;
const PYTHON = process.env['TRACT_TOOLS_PYTHON'] ?? 'python3';
const ASEG_NAME = ASEG.split('/').pop()!;

const ids = (name: string): number => readFileSync(join(WHOLE!, `${name}.ids.txt`), 'utf8').trim().split('\n').length;
const shown = (n: number, total: number): string => `${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;

test.skip(WHOLE === undefined, 'skipping: TRACT_TOOLS_WHOLE is unset');

test('every streamline of the real file, through the real app', async () => {
  test.setTimeout(1_500_000);
  const total = Number(readFileSync(join(WHOLE!, 'count.txt'), 'utf8'));
  const app = await launch();
  const report: string[] = [];
  const timed = async (label: string, act: () => Promise<void>): Promise<void> => {
    const t0 = Date.now();
    await act();
    report.push(`${label}: ${((Date.now() - t0) / 1000).toFixed(2)} s`);
  };
  const narrowShots = async (page: Page, name: string): Promise<void> => {
    await setSize(app, 960, 700);
    await page.waitForTimeout(300);
    await shot(page, `${name}-960x700`);
    await expectNoOverflow(page);
    await setSize(app, 1800, 1126);
    await page.waitForTimeout(300);
  };
  try {
    const page = await ready(app, 1800, 1126);
    await install(page);
    await page.evaluate(() => {
      const w = window as unknown as { stalls: number[] };
      w.stalls = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.stalls.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    });
    await timed('open the files and read the whole tractogram (lengths, ends)', async () => {
      await openFiles(app, page, [T1, ASEG, FA, TCK]);
      await expect(page.getByTestId('tt-median')).toContainText('median length', { timeout: 280_000 });
      await idle(page);
    });
    report.push(`file: ${await page.evaluate(() => {
      const t = (window as any).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      return `${d.nStreamlines} of ${d.sourceStreamlines} streamlines held, ${d.nPoints} of ${d.sourcePoints} points`;
    })}`);

    await timed('first region rule (one pass building the region index)', async () => {
      await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10' });
      await expect(page.getByTestId('tt-count')).toHaveText(shown(ids('inc_10'), total), { timeout: 280_000 });
      await idle(page);
    });
    await timed('rule change (mode: Ends in)', async () => {
      await operation(page, 'clear', {});
      await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10', mode: 'ends' });
      await expect(page.getByTestId('tt-count')).toHaveText(shown(ids('ends_10'), total), { timeout: 60_000 });
    });
    await timed('rule change (second region)', async () => {
      await operation(page, 'clear', {});
      await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10' });
      await operation(page, 'add-region', { volume: ASEG_NAME, labels: '49', effect: 'exclude' });
      await expect(page.getByTestId('tt-count')).toHaveText(shown(ids('inc_10_exc_49'), total), { timeout: 60_000 });
    });
    await expect(page.getByTestId('tt-drawn')).toContainText(`numbers use all ${total.toLocaleString('en-US')}`);
    await expect.poll(() => visible(page), { timeout: 60_000 }).toBeLessThanOrEqual(ids('inc_10_exc_49'));
    await timed('new sphere (one pass)', async () => {
      await operation(page, 'add-sphere', { center: [0, 0, 10], radiusMm: 12 });
      await idle(page);
    });
    await operation(page, 'set-length', { minMm: 40, maxMm: 180 });
    await shot(page, 'rules-1800x1126');
    await expectNoOverflow(page);
    await narrowShots(page, 'rules');
    await operation(page, 'clear', {});

    await page.getByTestId('panel-tab-network').click();
    await page.getByTestId('tt-volume').selectOption(ASEG_NAME);
    await timed('build the network (radial 4 mm over every end)', async () => {
      await page.getByTestId('tt-build').click();
      await expect(page.getByTestId('tt-card-nodes')).toContainText('32', { timeout: 280_000 });
      await idle(page);
    });
    await expect(page.getByTestId('tt-names-from')).toContainText('FreeSurfer');
    await timed('load tcksift2 weights', async () => {
      await stubOpen(app, [WEIGHTS]);
      await page.getByTestId('tt-measures').locator('summary').click();
      await page.getByTestId('tt-load-weights').click();
      await expect(page.getByTestId('tt-sort-weight')).toBeVisible({ timeout: 280_000 });
      // An operation resolves once the queue has run, which is when the scan and the rebuild are done.
      await operation(page, 'clear-edge', {});
    });
    await timed('sample FA along every streamline', async () => {
      await page.getByTestId('tt-value').selectOption('v:fa.nii.gz');
      await expect(page.getByTestId('tt-sort-value')).toBeVisible({ timeout: 280_000 });
      await operation(page, 'clear-edge', {});
    });
    await page.getByTestId('tt-edges').locator('tbody tr').first().waitFor();
    await shot(page, 'network-1800x1126');
    await expectNoOverflow(page);
    await narrowShots(page, 'network');
    const row = page.getByTestId('tt-edges').locator('tbody tr').nth(2).locator('td').nth(1);
    await row.click();
    await expect(page.getByTestId('tt-edge-card')).toBeVisible({ timeout: 60_000 });
    await idle(page);
    await shot(page, 'connection-1800x1126');
    await expectNoOverflow(page);
    await narrowShots(page, 'connection');
    await page.getByTestId('tt-clear-edge').click();
    await idle(page);

    await page.getByTestId('panel-tab-export').click();
    await page.getByTestId('tt-export-figure').check();
    const dirA = mkdtempSync(join(tmpdir(), 'tt-whole-network-'));
    await timed('export: matrices, tables, figure, all 200,000 per-streamline rows, methods', async () => {
      await stubOpen(app, [dirA]);
      await page.getByTestId('tt-export-folder').click();
      await expect(page.getByTestId('tt-export-result')).toContainText('Wrote', { timeout: 280_000 });
    });
    report.push(`  files: ${readdirSync(dirA).join(', ')}`);
    await shot(page, 'export-1800x1126');
    await expectNoOverflow(page);
    await narrowShots(page, 'export');
    const save = (path: string): Promise<void> =>
      app.evaluate(async ({ dialog }, p) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
      }, path);
    await page.getByTestId('tt-export-advanced').locator('summary').click();
    await page.getByTestId('tt-export-symmetric').check();
    await save(join(dirA, 'connectome_count_sym.csv'));
    await operation(page, 'export-matrix', {});
    await page.getByTestId('tt-export-symmetric').uncheck();
    await operation(page, 'connectome', { volume: ASEG_NAME, mode: 'end' });
    await save(join(dirA, 'connectome_end.csv'));
    await operation(page, 'export-matrix', {});
    await operation(page, 'connectome', { volume: ASEG_NAME, mode: 'radial', radiusMm: 4 });

    const recipes = JSON.parse(readFileSync(join(REPO, 'scripts/reference/tracts.json'), 'utf8')) as { tracts: Record<string, [string, Record<string, unknown>][]> };
    for (const [name, ops] of Object.entries(recipes.tracts)) {
      for (const [op, args] of ops) await operation(page, op, op === 'add-region' ? { ...args, volume: ASEG_NAME } : args);
      await operation(page, 'save-tract', { name });
      await operation(page, 'clear', {});
    }
    const dirB = mkdtempSync(join(tmpdir(), 'tt-whole-tracts-'));
    await timed(`export: ${Object.keys(recipes.tracts).length} .tck files in one pass, streamlines.csv, methods`, async () => {
      await page.getByTestId('tt-export-matrices').uncheck();
      await page.getByTestId('tt-export-edges').uncheck();
      await page.getByTestId('tt-export-nodes').uncheck();
      await page.getByTestId('tt-export-figure').uncheck();
      await stubOpen(app, [dirB]);
      await page.getByTestId('tt-export-folder').click();
      await expect(page.getByTestId('tt-export-result')).toContainText('Wrote', { timeout: 600_000 });
    });
    // Load full on the real file with the crosshair moving: nothing may reach the copy it frees.
    await timed('Load full while the crosshair moves', async () => {
      const got = await page.evaluate(async () => {
        const engine = (window as any).__tetravox.engine;
        const id = [...engine.scene.datasets.values()].find((d: any) => d.kind === 'tractogram').id;
        const errors: string[] = [];
        const off = engine.on('error', (e: { message: string }) => errors.push(e.message));
        const moving = setInterval(() => engine.setCursor([Math.random() * 20, Math.random() * 20, 10]), 20);
        const ds = await engine.setTractBudget(id, null);
        clearInterval(moving);
        await engine.whenSettled();
        off?.();
        return { errors, held: ds.nStreamlines, handle: ds.handle };
      });
      expect(got.errors).toEqual([]);
      expect(got.handle).toBeGreaterThan(0);
      report.push(`Load full holds ${got.held} streamlines`);
    });
    const stalls = (await page.evaluate(() => (window as unknown as { stalls: number[] }).stalls)).sort((a, b) => b - a);
    report.push(`long tasks on the UI thread: ${stalls.length}, worst ${stalls.slice(0, 6).join(', ')} ms`);
    console.log(report.join('\n'));
    const bin = process.env['MRTRIX_BIN'];
    for (const dir of [dirA, dirB]) {
      const compare = spawnSync(PYTHON, [join(REPO, 'scripts/reference/compare_export.py'), dir, WHOLE!, ...(bin === undefined ? [] : ['--mrtrix-bin', bin])], { encoding: 'utf8' });
      console.log(compare.stdout, compare.stderr);
      expect(compare.status).toBe(0);
    }
    expect(stalls[0] ?? 0).toBeLessThan(1000);
  } finally {
    await app.close();
  }
});
