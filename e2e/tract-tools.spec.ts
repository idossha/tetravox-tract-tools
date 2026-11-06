// The built extension in the real app, hidden, on a tenth of the real tractogram with the real aseg. Expected numbers come
// from what MRtrix 3.0.8 wrote (scripts/reference/thin_refs.sh), never from this extension.
//
//   MRTRIX_BIN=<dir> scripts/reference/thin_refs.sh <thin>
//   TRACT_TOOLS_THIN=<thin> TRACT_TOOLS_FA=<fa.nii.gz> TRACT_TOOLS_ASEG=<aseg> pnpm run e2e
// Skips without TRACT_TOOLS_THIN.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { readTck } from '../test/files';
import { APP_ROOT, CHECKOUT, ELECTRON, expectNoOverflow, ID, idle, install, launch, openFiles, ready, REPO, setSize, shot, stubOpen, VERSION, visible, operation } from './harness';
import type { Win } from './harness';

const THIN = process.env['TRACT_TOOLS_THIN'];
const D = '/Users/idohaber/datasets/000/derivatives';
const ASEG = process.env['TRACT_TOOLS_ASEG'] ?? `${D}/qsiprep/sub-CHN/anat/sub-CHN_space-ACPC_desc-aseg_dseg.nii.gz`;
const FA = process.env['TRACT_TOOLS_FA'] ?? `${D}/ti-toolbox/tract_validation/mrtrix_ref/fa.nii.gz`;
const PYTHON = process.env['TRACT_TOOLS_PYTHON'] ?? 'python3';
const ASEG_NAME = ASEG.split('/').pop()!;

const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));
const ids = (name: string): number[] => lines(join(THIN!, `${name}.ids.txt`)).map(Number);
const csv = (path: string): number[][] => lines(path).map((l) => l.split(',').map(Number));
const count = (n: number, total = 20000): string => `${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;

async function countIs(page: Page, n: number, total: number): Promise<void> {
  await expect(page.getByTestId('tt-count')).toHaveText(count(n, total), { timeout: 60_000 });
  await idle(page);
  await expect.poll(() => visible(page)).toBe(n);
}

async function drawnIs(page: Page, n: number): Promise<void> {
  await idle(page);
  await expect.poll(() => visible(page), { timeout: 60_000 }).toBe(n);
}

async function clickCell(page: Page, row: number, col: number): Promise<void> {
  const map = page.getByTestId('tt-heatmap');
  const cell = Number(await map.getAttribute('data-cell'));
  const gutter = Number(await map.getAttribute('data-gutter'));
  await map.click({ position: { x: gutter + (col + 0.5) * cell, y: gutter + (row + 0.5) * cell } });
}

const tab = (page: Page, id: string): Promise<void> => page.getByTestId(`panel-tab-${id}`).click();

function strongest(con: number[][]): { i: number; j: number; v: number } {
  let best = { i: 0, j: 0, v: 0 };
  con.forEach((row, i) => row.forEach((v, j) => {
    if (i !== j && v > best.v) best = { i, j, v };
  }));
  return best;
}

test.skip(THIN === undefined, 'skipping: TRACT_TOOLS_THIN is unset');

test('every class the panel names exists in the host stylesheet', () => {
  const assets = join(APP_ROOT, 'out/renderer/assets');
  const css = readdirSync(assets)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('');
  const classes = new Set(
    readdirSync(join(REPO, 'src/ui'))
      .filter((f) => f.endsWith('.tsx'))
      .flatMap((f) => [...readFileSync(join(REPO, 'src/ui', f), 'utf8').matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)])
      .flatMap((m) =>
        (m[1] ?? m[2] ?? '')
          .replace(/\$\{[^}]*\}/g, ' ')
          .split(/\s+/)
          .filter((c) => c !== '')
      )
  );
  // Ternaries inside a template: read their literals too.
  for (const f of readdirSync(join(REPO, 'src/ui'))) {
    for (const m of readFileSync(join(REPO, 'src/ui', f), 'utf8').matchAll(/\? '([a-z][^']*)' : '([a-z][^']*)'/g)) {
      for (const c of `${m[1]} ${m[2]}`.split(/\s+/)) if (/^(text|font|hover|border|bg)/.test(c)) classes.add(c);
    }
  }
  expect(classes.size).toBeGreaterThan(30);
  const escape = (c: string): string => c.replace(/[[\]./:%]/g, (x) => `\\${x}`);
  expect([...classes].filter((c) => !css.includes(`.${escape(c)}`))).toEqual([]);
});

for (const [file, kind] of [['tract_ras.trk', 'trk'], ['tract_f32_stored.trx', 'trx']] as const) {
  test(`a .${kind} filters and exports as a valid .tck with the positions the fixture was written with`, async () => {
    const testdata = join(CHECKOUT, 'testdata');
    const fixture = JSON.parse(readFileSync(join(testdata, 'manifest.json'), 'utf8')).tracts[kind][file];
    const offsets: number[] = fixture.offsets;
    const positions: number[] = fixture.positions.flat();
    const app = await launch();
    try {
      const page = await ready(app, 1800, 1126);
      await install(page);
      await openFiles(app, page, [join(testdata, file)]);
      await expect(page.getByTestId('tt-count')).toHaveText('4 of 4', { timeout: 60_000 });
      await idle(page);
      // The streamline lengths come from the fixture's own coordinates.
      const lengths = offsets.slice(0, -1).map((a, s) => {
        let sum = 0;
        for (let i = a; i + 1 < offsets[s + 1]!; i += 1) sum += Math.hypot(positions[i * 3 + 3]! - positions[i * 3]!, positions[i * 3 + 4]! - positions[i * 3 + 1]!, positions[i * 3 + 5]! - positions[i * 3 + 2]!);
        return sum;
      });
      const longest = lengths.indexOf(Math.max(...lengths));
      await operation(page, 'set-length', { minMm: lengths[longest]! - 0.01 });
      await expect(page.getByTestId('tt-count')).toHaveText('1 of 4', { timeout: 30_000 });
      await idle(page);
      const out = mkdtempSync(join(tmpdir(), `tt-${kind}-`));
      await page.getByTestId('panel-tab-export').click();
      await stubOpen(app, [out]);
      await page.getByTestId('tt-export-folder').click();
      await expect(page.getByTestId('tt-export-result')).toContainText('Wrote', { timeout: 60_000 });
      const t = readTck(join(out, 'current_filter.tck'));
      expect([...t.offsets]).toEqual([0, offsets[longest + 1]! - offsets[longest]!]);
      expect(Array.from(t.points)).toEqual(Array.from(Float32Array.from(positions.slice(offsets[longest]! * 3, offsets[longest + 1]! * 3))));
      const bin = process.env['MRTRIX_BIN'];
      if (bin !== undefined) {
        const info = spawnSync(join(bin, 'tckinfo'), [join(out, 'current_filter.tck'), '-count'], { encoding: 'utf8' });
        expect(info.status, info.stderr).toBe(0);
        expect(info.stdout).toMatch(/actual count in file: 1\b/);
      }
    } finally {
      await app.close();
    }
  });
}

test('a job file reaches the operations, and its numbers are MRtrix\'s', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tt-job-'));
  const store = join(root, 'modules');
  const profile = join(root, 'profile');
  const outDir = join(root, 'out');
  const dir = join(store, ID, VERSION);
  mkdirSync(dir, { recursive: true });
  mkdirSync(profile);
  mkdirSync(outDir);
  const files = ['index.js', 'manifest.json'].map((name) => {
    const bytes = readFileSync(join(REPO, 'dist', name));
    writeFileSync(join(dir, name), bytes);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(join(dir, 'tetravox-module.json'), JSON.stringify({ schema: 1, id: ID, version: VERSION, installedAt: new Date().toISOString(), files }));
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ extensions: { [ID]: { version: VERSION, hostApi: 1, grantedAt: new Date().toISOString(), permissions: [] } } }));
  const op = (name: string, args: object): object => ({ type: 'module', module: ID, op: name, args });
  const job = {
    scene: { files: [join(THIN!, 'thin.tck'), ASEG, FA] },
    actions: [
      op('add-region', { volume: ASEG_NAME, labels: '10' }),
      op('export-selection', { out: 'inc_10.txt' }),
      op('clear', {}),
      op('open-roi', { path: join(THIN!, 'left_thalamus_mask.nii.gz') }),
      op('save-tract', { name: 'mask' }),
      op('clear', {}),
      op('connectome', { volume: ASEG_NAME, mode: 'radial', radiusMm: 4 }),
      op('attach', { path: join(THIN!, 'thin_weights.txt'), use: 'weights' }),
      op('set-value', { volume: 'fa.nii.gz' }),
      op('export-matrix', { out: 'con.csv' }),
      op('export-file', { what: 'length', out: 'connectome_length.csv' }),
      op('export-file', { what: 'weight', out: 'connectome_weight.csv' }),
      op('export-file', { what: 'value', out: 'connectome_fa.csv' }),
      op('export-file', { what: 'edges', out: 'edges.csv' }),
      op('export-file', { what: 'nodes', out: 'nodes.csv' }),
      op('export-file', { what: 'methods', out: 'methods.txt' }),
      op('export-file', { what: 'svg', out: 'connectome.svg' }),
      op('export-file', { what: 'png', out: 'connectome.png' }),
    ],
  };
  const jobPath = join(root, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job));
  const run = spawnSync(ELECTRON, [APP_ROOT, `--user-data-dir=${profile}`, '--force-color-profile=srgb', '--job', jobPath, '--out', outDir], {
    cwd: APP_ROOT,
    env: { ...process.env, TETRAVOX_MODULE_DIR: store, TETRAVOX_E2E: '1' },
    encoding: 'utf8',
    timeout: 200_000,
  });
  const result = JSON.parse(readFileSync(join(outDir, 'job-result.json'), 'utf8'));
  expect(result.errors, run.stderr).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.outputs[0].result.selected).toBe(ids('inc_10').length);
  const row = readFileSync(join(outDir, 'inc_10.txt'), 'utf8').trim().split(' ').map(Number);
  expect(row.flatMap((v, i) => (v === 1 ? [i] : []))).toEqual(ids('inc_10'));
  expect(result.outputs[4].result.selected).toBe(ids('inc_10').length);
  writeFileSync(join(outDir, 'connectome_count.csv'), readFileSync(join(outDir, 'con.csv')));
  const compare = spawnSync(PYTHON, [join(REPO, 'scripts/reference/compare_export.py'), outDir, THIN!], { encoding: 'utf8' });
  console.log(compare.stdout, compare.stderr);
  expect(compare.status).toBe(0);
  expect(readFileSync(join(outDir, 'connectome.svg'), 'utf8')).toContain('Left-Thalamus');
  expect(readFileSync(join(outDir, 'connectome.png')).subarray(1, 4).toString()).toBe('PNG');
});

test('filter, build, export, restore, and every surface it can draw on', async () => {
  const total = lines(join(THIN!, 'as_end.txt')).length;
  const incL = ids('inc_10').length;
  const exc = ids('inc_10_exc_49').length;
  const ends = ids('ends_10').length;
  const out = mkdtempSync(join(tmpdir(), 'tt-out-'));
  const app: ElectronApplication = await launch();
  try {
    const page = await ready(app, 1800, 1126);
    await install(page);
    await openFiles(app, page, [ASEG, FA, join(THIN!, 'thin.tck')]);
    await expect(page.getByTestId('tt-count')).toHaveText(count(total, total), { timeout: 60_000 });
    await idle(page);
    await expect(page.getByTestId('tt-median')).toContainText('median length');

    // Rules are no longer in the panel, but a job's still filter, and the panel says so and can remove them.
    const clearAll = async (): Promise<void> => {
      await operation(page, 'clear', {});
      await countIs(page, total, total);
      await expect(page.getByTestId('tt-rules-note')).toHaveCount(0);
    };
    await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10' });
    await countIs(page, incL, total);
    await expect(page.getByTestId('tt-rules-note')).toContainText('1 rule');
    await operation(page, 'add-region', { volume: ASEG_NAME, labels: '49', effect: 'exclude' });
    await countIs(page, exc, total);
    await page.getByTestId('tt-clear').click();
    await countIs(page, total, total);
    await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10', mode: 'ends' });
    await countIs(page, ends, total);
    await clearAll();
    await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10', mode: 'both' });
    const end = lines(join(THIN!, 'as_end.txt')).map((l) => l.split(/\s+/).map(Number) as [number, number]);
    await countIs(page, end.filter(([a, b]) => a === 10 && b === 10).length, total);
    await clearAll();
    await operation(page, 'add-sphere', { center: [0, 0, 10], radiusMm: 12 });
    await countIs(page, ids('sph').length, total);
    await clearAll();
    await operation(page, 'open-roi', { path: join(THIN!, 'left_thalamus_mask.nii.gz') });
    await countIs(page, incL, total);
    await clearAll();
    // A saved tract under a name, in the Network tab's list.
    await operation(page, 'set-length', { minMm: 40, maxMm: 180 });
    await operation(page, 'add-region', { volume: ASEG_NAME, labels: '10' });
    await operation(page, 'add-region', { volume: ASEG_NAME, labels: '49', effect: 'exclude' });
    await countIs(page, ids('combo').length, total);
    await operation(page, 'save-tract', { name: 'combo' });
    await expect(page.getByTestId('tt-saved-0')).toContainText(ids('combo').length.toLocaleString('en-US'));
    await clearAll();
    await page.getByTestId('tt-saved-apply-0').click();
    await countIs(page, ids('combo').length, total);
    await page.getByTestId('tt-saved-rename-0').click();
    await page.getByTestId('tt-saved-name-0').fill('renamed');
    await page.getByTestId('tt-saved-rename-ok-0').click();
    await expect(page.getByTestId('tt-saved-0')).toContainText('renamed');
    await page.getByTestId('tt-saved-rename-0').click();
    await page.getByTestId('tt-saved-name-0').fill('combo');
    await page.getByTestId('tt-saved-rename-ok-0').click();
    await clearAll();
    await shot(page, 'thin-open');

    // The network, in the panel.
    await page.getByTestId('tt-volume').selectOption(ASEG_NAME);
    await page.getByTestId('tt-build').click();
    await expect(page.getByTestId('tt-card-nodes')).toContainText('32', { timeout: 60_000 });
    await idle(page);
    await expect(page.getByTestId('tract-tools').getByTestId('tt-matrix').getByTestId('tt-heatmap')).toBeVisible();
    await expect(page.getByTestId('module-center')).toHaveCount(0);
    // A real aseg at the default panel width: every name drawn, nothing outside the panel.
    expect(await page.getByTestId('tt-heatmap').getAttribute('data-label-every')).toBe('1');
    expect(Number(await page.getByTestId('tt-heatmap').getAttribute('data-cell'))).toBeGreaterThan(5);
    await expectNoOverflow(page);
    const con = csv(join(THIN!, 'con_radial4.csv'));
    // Every way of choosing, against MRtrix's matrix. `con` is its upper triangle, so a cell is
    // con[low - 1][high - 1] by label id: Left-Thalamus 10, Right-Thalamus 49, cortex 3 and 42.
    const cellN = (x: number, y: number): number => con[Math.min(x, y) - 1]![Math.max(x, y) - 1]!;
    const total_ = con.flatMap((row) => row.filter((v) => v > 0)).length;
    const thalamic = con.flatMap((row, i) => row.flatMap((v, j) => (v > 0 && [i + 1, j + 1].some((id) => id === 10 || id === 49) ? [v] : [])));
    const thalamicN = thalamic.reduce((a, b) => a + b, 0);
    const chosen = async (k: number | null, n: number): Promise<void> => {
      await expect(page.getByTestId('tt-edges-shown')).toContainText(k === null ? `All ${total_} connections` : `${k} of ${total_} connections`, { timeout: 60_000 });
      await expect(page.getByTestId('tt-count')).toHaveText(count(n, total), { timeout: 60_000 });
    };
    await chosen(null, total);
    // The table's search and its buttons.
    await page.getByTestId('tt-edge-search').fill('thalamus');
    await expect(page.getByTestId('tt-edge-found')).toHaveText(`${thalamic.length} of ${total_}`);
    for (const row of await page.getByTestId('tt-edges').locator('tbody tr').all()) await expect(row.locator('td').nth(1)).toContainText('Thalamus');
    await page.getByTestId('tt-edge-search').fill('no such region');
    await expect(page.getByTestId('tt-edges')).toHaveCount(0);
    await page.getByTestId('tt-edge-search').fill('');
    await expect(page.getByTestId('tt-edges-more')).toContainText('first 60');
    await page.getByTestId('tt-edges-hide').click();
    await chosen(0, 0);
    await page.getByTestId('tt-edge-search').fill('thalamus');
    await page.getByTestId('tt-edges-show').click();
    await chosen(thalamic.length, thalamicN);
    await page.getByTestId('tt-edge-search').fill('');
    await page.getByTestId('tt-clear-edge').click();
    await chosen(null, total);
    // From → To through the search boxes: typing narrows the list, Enter or a click adds, a chip removes.
    await expect(page.getByTestId('tt-how-fromto')).toHaveCount(0);
    await page.getByTestId('tt-from').fill('left thal');
    await expect(page.getByTestId('tt-from-list').getByRole('option')).toHaveCount(1);
    await page.getByTestId('tt-from').press('Enter');
    await expect(page.getByTestId('tt-from-chip-10')).toBeVisible();
    // The search and the list stay as they were, with what was taken marked; again takes it back.
    await expect(page.getByTestId('tt-from')).toHaveValue('left thal');
    await expect(page.getByTestId('tt-from-list').getByRole('option')).toHaveCount(1);
    await expect(page.getByTestId('tt-from-option-10')).toContainText('✓');
    await page.getByTestId('tt-from-option-10').click();
    await expect(page.getByTestId('tt-from-chip-10')).toHaveCount(0);
    await expect(page.getByTestId('tt-from')).toHaveValue('left thal');
    await page.getByTestId('tt-from-option-10').click();
    await expect(page.getByTestId('tt-from-chip-10')).toBeVisible();
    await page.getByTestId('tt-from').blur();
    await page.getByTestId('tt-to').fill('cerebral-cortex');
    await expect(page.getByTestId('tt-to-list').getByRole('option')).toHaveCount(2);
    await page.getByTestId('tt-to-option-3').click();
    await chosen(1, cellN(10, 3));
    await expect(page.getByTestId('tt-to')).toHaveValue('cerebral-cortex');
    await expect(page.getByTestId('tt-to-list').getByRole('option')).toHaveCount(2);
    await page.getByTestId('tt-to').fill('49');
    await expect(page.getByTestId('tt-to-list').getByRole('option')).toHaveCount(1);
    await page.getByTestId('tt-to').fill('right-cerebral-cortex');
    await page.getByTestId('tt-to-option-42').click();
    await page.getByTestId('tt-to').blur();
    await expect(page.getByTestId('tt-to-list')).toHaveCount(0);
    await chosen(cellN(10, 42) >= 5 ? 2 : 1, cellN(10, 3) + (cellN(10, 42) >= 5 ? cellN(10, 42) : 0));
    // The choice sits at the top of the table, whatever its counts.
    const firstRow = page.getByTestId('tt-edges').locator('tbody tr').first();
    await expect(firstRow.locator('td').nth(1)).toContainText('Left-Thalamus');
    await expect(firstRow.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'thin-fromto');
    await page.getByTestId('tt-to-chip-3').click();
    await page.getByTestId('tt-to-chip-42').click();
    await page.getByTestId('tt-min-n').fill('1');
    await page.getByTestId('tt-min-n').press('Enter');
    const leftThalamus = con.flatMap((row, i) => row.flatMap((v, j) => (v > 0 && (i + 1 === 10 || j + 1 === 10) ? [v] : [])));
    await chosen(leftThalamus.length, leftThalamus.reduce((a, b) => a + b, 0));
    await page.getByTestId('tt-from-chip-10').click();
    await chosen(null, total);
    // Ticks: an eye from everything showing hides that one; a click on a row starts a choice of it.
    let heaviest = { i: 0, j: 0, n: 0 };
    con.forEach((row, i) => row.forEach((n, j) => {
      if (n > heaviest.n && [i + 1, j + 1].some((id) => id === 10 || id === 49)) heaviest = { i, j, n };
    }));
    await page.getByTestId('tt-edge-search').fill('thalamus');
    const heavyId = `${heaviest.i + 1}-${heaviest.j + 1}`;
    const eye = page.getByTestId(`tt-edge-eye-${heavyId}`);
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    await eye.click();
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    // A choice holds streamlines of connections, so one with an unassigned end is out of it.
    await chosen(total_ - 1, con.flat().reduce((a, b) => a + b, 0) - heaviest.n);
    await eye.click();
    await chosen(null, total);
    await page.getByTestId(`tt-edge-${heavyId}`).locator('td').nth(1).click();
    await chosen(1, heaviest.n);
    await expect(page.getByTestId('tt-edge-card')).toBeVisible();
    // Colours: each swatch is what the layer gives that group, read back from the engine.
    await page.getByTestId('tt-edge-colour').check();
    await idle(page);
    const swatch = page.getByTestId('tt-edge-swatch').first();
    await expect(swatch).toBeVisible({ timeout: 60_000 });
    const colours = await swatch.evaluate((el) => ({ group: Number((el as HTMLElement).dataset['group']), css: getComputedStyle(el).backgroundColor }));
    await expect.poll(() => page.evaluate((id) => {
      const t = (window as unknown as Win).__tetravox;
      const layer = t.store.getState().layers.find((l: { kind: string }) => l.kind === 'tracts');
      const row = t.engine.tractStyleInfo(layer.id)?.groups.find((g: { id: number }) => g.id === id);
      return row === undefined ? null : `rgb(${row.color.join(', ')})`;
    }, colours.group), { timeout: 30_000 }).toBe(colours.css);
    await page.getByTestId('tt-edge-colour').uncheck();
    await idle(page);
    // Saved under a date, and every tick back.
    await page.getByTestId('tt-edges-save').click();
    await page.getByTestId('tt-edge-search').fill('');
    await page.getByTestId('tt-clear-edge').click();
    await chosen(null, total);
    const regions = [...new Set(lines(join(THIN!, 'as_radial4.txt')).flatMap((l) => l.split(/\s+/).map(Number)))].filter((v) => v > 0);
    const assigned = lines(join(THIN!, 'as_radial4.txt')).filter((l) => !l.split(/\s+/).includes('0')).length;
    await expect(page.getByTestId('tt-card-assigned')).toContainText(`${((100 * assigned) / total).toFixed(0)}%`);
    expect(regions.length).toBeLessThanOrEqual(32);

    // An aseg is named by default, and the panel says so.
    await expect(page.getByTestId('tt-names-from')).toContainText('FreeSurfer, assumed');
    await expect(page.getByTestId('tt-edges')).toContainText('Left-Thalamus');
    await idle(page);

    // The heaviest cell, by MRtrix's matrix: click it, and the card and the layer say what MRtrix says.
    const map = page.getByTestId('tt-heatmap');
    const ax = (await page.evaluate(() => {
      const t = (window as unknown as Win).__tetravox;
      const v = t.store.getState().datasets.find((d: { name: string }) => d.name.includes('aseg'));
      return [...v.labelIds].filter((x: number) => x > 0);
    })) as number[];
    const best = strongest(con);
    const row = ax.indexOf(best.i + 1);
    const col = ax.indexOf(best.j + 1);
    // Analytic pixel: the strongest edge is the top of the colour bar, viridis (253,231,37), up to antialias.
    const pixel = await map.evaluate((c: HTMLCanvasElement, at) => {
      const ratio = c.width / c.clientWidth;
      const cell = Number(c.dataset['cell']);
      const gutter = Number(c.dataset['gutter']);
      return [...c.getContext('2d')!.getImageData(Math.round((gutter + (at.col + 0.5) * cell) * ratio), Math.round((gutter + (at.row + 0.5) * cell) * ratio), 1, 1).data];
    }, { row, col });
    expect(pixel.slice(0, 3)).toEqual([253, 231, 37]);
    // The cell keeps its colour when chosen, and a red outline is drawn around it and its mirror.
    const edgeRed = (r: number, c: number): Promise<boolean> =>
      map.evaluate((el: HTMLCanvasElement, at) => {
        const ratio = el.width / el.clientWidth;
        const cell = Number(el.dataset['cell']);
        const gutter = Number(el.dataset['gutter']);
        const x = Math.round((gutter + (at.c + 0.5) * cell) * ratio);
        const y = Math.round((gutter + at.r * cell) * ratio);
        const px = el.getContext('2d')!.getImageData(x, y - 2, 1, 5).data;
        for (let i = 0; i < px.length; i += 4) if (px[i]! > 200 && px[i + 1]! < 110 && px[i + 2]! < 110) return true;
        return false;
      }, { r, c });
    expect(await edgeRed(row, col)).toBe(false);
    await clickCell(page, row, col);
    await drawnIs(page, best.v);
    await expect.poll(() => edgeRed(row, col)).toBe(true);
    expect(await edgeRed(col, row)).toBe(true);
    const centre = await map.evaluate((c: HTMLCanvasElement, at) => {
      const ratio = c.width / c.clientWidth;
      const cell = Number(c.dataset['cell']);
      const gutter = Number(c.dataset['gutter']);
      return [...c.getContext('2d')!.getImageData(Math.round((gutter + (at.col + 0.5) * cell) * ratio), Math.round((gutter + (at.row + 0.5) * cell) * ratio), 1, 1).data];
    }, { row, col });
    expect(centre.slice(0, 3)).toEqual([253, 231, 37]);
    // Hovering a cell bands its row and column, on the overlay, and nothing else.
    const overlayAlpha = (r: number, c: number): Promise<number> =>
      page.getByTestId('tt-heatmap-hover').evaluate((el: HTMLCanvasElement, at) => {
        const ratio = el.width / el.clientWidth;
        const read = (k: string): number => Number((el.previousElementSibling as HTMLCanvasElement).dataset[k]);
        const cell = read('cell');
        const gutter = read('gutter');
        return el.getContext('2d')!.getImageData(Math.round((gutter + (at.c + 0.5) * cell) * ratio), Math.round((gutter + (at.r + 0.5) * cell) * ratio), 1, 1).data[3]!;
      }, { r, c });
    const cellPx = Number(await map.getAttribute('data-cell'));
    const gutterPx = Number(await map.getAttribute('data-gutter'));
    await map.hover({ position: { x: gutterPx + 2.5 * cellPx, y: gutterPx + 4.5 * cellPx } });
    await expect.poll(() => overlayAlpha(4, 20)).toBeGreaterThan(0);
    expect(await overlayAlpha(20, 2)).toBeGreaterThan(0);
    expect(await overlayAlpha(20, 20)).toBe(0);
    await map.hover({ position: { x: 1, y: 1 } });
    await expect.poll(() => overlayAlpha(4, 20)).toBe(0);
    await expect(page.getByTestId('tt-edge-name')).toContainText('↔');
    await expect(page.getByTestId('tt-edge-stats')).toContainText(`${best.v.toLocaleString('en-US')} streamlines`);
    await map.hover({ position: { x: 300, y: 300 } });
    await expect(page.getByTestId('tt-hover')).toContainText('streamlines');

    // Save it, then show all.
    await page.getByTestId('tt-edges-save').click();
    await page.getByTestId('tt-clear-edge').first().click();
    await drawnIs(page, total);
    // A region through its label: degree and strength against the symmetric matrix.
    const sym = csv(join(THIN!, 'con_radial4_sym.csv'));
    const degree = sym[9]!.filter((v, j) => j !== 9 && v > 0).length;
    const strength = sym[9]!.reduce((sum, v, j) => (j === 9 ? sum : sum + v), 0);
    const gutter = Number(await map.getAttribute('data-gutter'));
    const cell = Number(await map.getAttribute('data-cell'));
    await map.click({ position: { x: gutter - 8, y: gutter + (ax.indexOf(10) + 0.5) * cell } });
    await expect(page.getByTestId('tt-region-stats')).toContainText(`connects to ${degree} regions · ${strength.toLocaleString('en-US')} streamlines`);
    await page.getByTestId('tt-clear-edge').first().click();
    await idle(page);

    // Keyboard: arrows and Enter reach a cell.
    await map.focus();
    await map.press('ArrowDown');
    await map.press('Enter');
    await expect(page.getByTestId('tt-edge-card').or(page.getByTestId('tt-message'))).toBeVisible();
    await map.press('Escape');
    await idle(page);
    await expect(page.getByTestId('tt-edge-card')).toHaveCount(0, { timeout: 30_000 });

    // The rest of what a matrix can show.
    await stubOpen(app, [join(THIN!, 'thin_weights.txt')]);
    await page.getByTestId('tt-measures').locator('summary').click();
    await page.getByTestId('tt-load-weights').click();
    await expect(page.getByTestId('tt-weight')).toHaveValue(/thin_weights/, { timeout: 30_000 });
    await page.getByTestId('tt-value').selectOption('v:fa.nii.gz');
    await expect(page.getByTestId('tt-edges')).toContainText('fa', { timeout: 60_000 });
    await idle(page);
    await page.getByTestId('tt-show').selectOption('value');
    await expect(page.getByTestId('tt-show')).toHaveValue('value');
    // The numbers themselves, not the column's name: a value still pending draws a blank matrix.
    await expect(page.getByTestId('tt-edges').locator('tbody tr').first().locator('td').last()).toHaveText(/^\d/, { timeout: 60_000 });
    await expect
      .poll(
        () =>
          page.getByTestId('tt-heatmap').evaluate((el) => {
            const canvas = el as HTMLCanvasElement;
            const n = Number(canvas.dataset['nodes']);
            const cell = Number(canvas.dataset['cell']);
            const gutter = Number(canvas.dataset['gutter']);
            const ratio = canvas.width / canvas.getBoundingClientRect().width;
            const px = canvas.getContext('2d')!.getImageData(gutter * ratio, gutter * ratio, n * cell * ratio, n * cell * ratio).data;
            let coloured = 0;
            for (let i = 0; i < px.length; i += 4) if (Math.max(px[i]!, px[i + 1]!, px[i + 2]!) - Math.min(px[i]!, px[i + 1]!, px[i + 2]!) > 40) coloured += 1;
            return coloured;
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0);
    await shot(page, 'thin-network');
    await expectNoOverflow(page);
    await page.getByTestId('tt-show').selectOption('count');

    // Sorting the table is a click on its header.
    await page.getByTestId('tt-sort-length').click();
    const firstMm = Number(await page.getByTestId('tt-edges').locator('tbody tr').first().locator('td').nth(3).textContent());
    const secondMm = Number(await page.getByTestId('tt-edges').locator('tbody tr').nth(1).locator('td').nth(3).textContent());
    expect(firstMm).toBeGreaterThanOrEqual(secondMm);
    await page.getByTestId('tt-sort-n').click();

    // Export a folder, stubbing the sheet, and read every file back.
    await tab(page, 'export');
    await page.getByTestId('tt-export-figure').check();
    await stubOpen(app, [out]);
    await page.getByTestId('tt-export-folder').click();
    await expect(page.getByTestId('tt-export-result')).toContainText('Wrote', { timeout: 120_000 });
    await shot(page, 'thin-export');
    await expectNoOverflow(page);
    const written = readdirSync(out);
    for (const name of ['connectome_count.csv', 'connectome_length.csv', 'connectome_weight.csv', 'connectome_fa.csv', 'edges.csv', 'nodes.csv', 'connectome.png', 'connectome.svg', 'combo.tck', 'streamlines.csv', 'methods.txt', 'recipe.json']) {
      expect(written).toContain(name);
    }
    expect(written.filter((n) => n.endsWith('.part'))).toEqual([]);
    const compare = spawnSync(PYTHON, [join(REPO, 'scripts/reference/compare_export.py'), out, THIN!, ...(process.env['MRTRIX_BIN'] === undefined ? [] : ['--mrtrix-bin', process.env['MRTRIX_BIN']])], { encoding: 'utf8' });
    console.log(compare.stdout, compare.stderr);
    expect(compare.status).toBe(0);
    // The figure: a real image at its size, read by Electron, with the top of the colour bar where the strongest cell is.
    const png = await app.evaluate(({ nativeImage }, path) => {
      const image = nativeImage.createFromPath(path);
      return image.getSize();
    }, join(out, 'connectome.png'));
    expect(png).toEqual({ width: 1200, height: 1200 });
    const methods = readFileSync(join(out, 'methods.txt'), 'utf8');
    for (const text of ['thin.tck', ASEG_NAME, 'fingerprint', '-assignment_radial_search 4', 'combo', 'upper triangle']) expect(methods).toContain(text);

    // A .tsf MRtrix wrote, attached instead of sampling: tcksample's numbers along each streamline, whole-file.
    await tab(page, 'network');
    await stubOpen(app, [join(THIN!, 'fa.tsf')]);
    await page.getByTestId('tt-load-value').click();
    await expect(page.getByTestId('tt-value')).toHaveValue('f:fa', { timeout: 60_000 });
    await idle(page);
    await tab(page, 'export');
    const out2 = mkdtempSync(join(tmpdir(), 'tt-out-tsf-'));
    await page.getByTestId('tt-export-figure').uncheck();
    await stubOpen(app, [out2]);
    await page.getByTestId('tt-export-folder').click();
    await expect(page.getByTestId('tt-export-result')).toContainText(out2.split('/').pop()!, { timeout: 120_000 });
    const compareTsf = spawnSync(PYTHON, [join(REPO, 'scripts/reference/compare_export.py'), out2, THIN!], { encoding: 'utf8' });
    console.log(compareTsf.stdout, compareTsf.stderr);
    expect(compareTsf.status).toBe(0);
    expect(existsSync(join(out2, 'connectome_fa.csv'))).toBe(true);

    // Exporting again asks first, and a refusal keeps what is there. The app's own confirm dialog answers Cancel here.
    const stamp = readFileSync(join(out, 'edges.csv'));
    await page.getByTestId('tt-export-folder').click();
    const dialog = page.getByTestId('confirm-dialog').or(page.locator('[role="alertdialog"], [role="dialog"]')).first();
    await expect(dialog).toContainText('Replace', { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('tt-export-result')).toContainText('cancelled');
    expect(readFileSync(join(out, 'edges.csv')).equals(stamp)).toBe(true);

    // Restore: the saved scene brings the recipe back and recomputes.
    await tab(page, 'network');
    await page.getByTestId('tt-saved-apply-0').click();
    await countIs(page, ids('combo').length, total);
    const scenePath = join(out, 'study.tetravox.json');
    await app.evaluate(async ({ dialog: d }, p) => {
      d.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof d.showSaveDialog;
    }, scenePath);
    await page.click('[data-testid="app-menu"]');
    await page.click('[data-testid="app-menu-save"]');
    await expect.poll(() => existsSync(scenePath)).toBe(true);
    const scene = JSON.parse(readFileSync(scenePath, 'utf8'));
    const block = scene.view?.extensions?.[ID] ?? scene.extensions?.[ID];
    expect(block.data.saved.map((s: { name: string }) => s.name)).toContain('combo');
    const blockText = JSON.stringify(block);
    for (const d of await page.evaluate(() => (window as unknown as Win).__tetravox.store.getState().datasets.map((x: { id: string }) => x.id))) {
      expect(blockText).not.toContain(`"${d}"`);
    }
    await stubOpen(app, [scenePath]);
    await page.click('[data-testid="app-menu"]');
    await page.click('[data-testid="app-menu-open-scene"]');
    await expect(page.getByTestId('tt-count')).toHaveText(count(ids('combo').length, total), { timeout: 120_000 });
    await idle(page);
    await expect.poll(() => visible(page)).toBe(ids('combo').length);
    await expect(page.getByTestId('tt-saved-0')).toContainText('combo');

    // A budget smaller than the file: numbers hold, the drawing shrinks, and the panel says so.
    await page.evaluate(async () => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      await t.engine.setTractBudget(d.id, 100_000);
    });
    await expect(page.getByTestId('tt-drawn')).toContainText(`numbers use all ${total.toLocaleString('en-US')}`, { timeout: 60_000 });
    await expect(page.getByTestId('tt-count')).toHaveText(count(ids('combo').length, total));
    await expect.poll(async () => (await visible(page))! < ids('combo').length, { timeout: 30_000 }).toBe(true);
    await page.evaluate(async () => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      await t.engine.setTractBudget(d.id, null);
    });
    await expect(page.getByTestId('tt-drawn')).toHaveCount(0, { timeout: 60_000 });
    await idle(page);
    await page.getByTestId('tt-clear').click();
    await countIs(page, total, total);

    // Still in the panel in a narrow window, and it takes the panel's width.
    await tab(page, 'network');
    await expect(page.getByTestId('tt-matrix').getByTestId('tt-heatmap')).toBeVisible({ timeout: 60_000 });
    await setSize(app, 1200, 800);
    await expect(page.getByTestId('tt-matrix').getByTestId('tt-heatmap')).toBeVisible({ timeout: 30_000 });
    const widths = await page.getByTestId('tt-matrix').evaluate((el) => ({ box: el.clientWidth, canvas: (el.querySelector('canvas') as HTMLCanvasElement).getBoundingClientRect().width }));
    expect(widths.canvas).toBe(widths.box);
    expect(Number(await page.getByTestId('tt-heatmap').getAttribute('data-cell'))).toBeGreaterThan(5);
    await expectNoOverflow(page);
    await shot(page, 'thin-narrow');
    await setSize(app, 1800, 1126);

    // Its own window (hidden, as every window here): its own nav, and the matrix in the panel.
    const popup = app.waitForEvent('window');
    await page.click('[data-testid="module-slot-popout"]');
    const win = await popup;
    await expect(win.getByTestId('tt-window-nav')).toBeVisible();
    await win.getByTestId('tt-tab-network').click();
    await expect(win.getByTestId('tt-matrix').getByTestId('tt-heatmap')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => Number(await win.getByTestId('tt-heatmap').getAttribute('data-cell'))).toBeGreaterThan(3);
    await expectNoOverflow(win, 'tract-tools');
    await expect(win.getByTestId('tt-tab-filter')).toHaveCount(0);
    await win.getByTestId('tt-tab-export').click();
    await expect(win.getByTestId('tt-export')).toBeVisible();
    await expect(win.getByTestId('tt-tab-export')).toHaveClass(/tvx-btn-on/);
    await expect(win.getByTestId('tt-tab-network')).not.toHaveClass(/tvx-btn-on/);
    if (process.env['TRACT_TOOLS_SHOTS'] !== undefined) await win.screenshot({ path: join(process.env['TRACT_TOOLS_SHOTS'], 'thin-popout.png') });
  } finally {
    await app.close();
  }
});
