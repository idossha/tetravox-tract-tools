// The built extension in the real app, hidden, through the real download-verify-consent path. Expected
// numbers come from the files MRtrix 3.0.8 wrote (TRACT_TOOLS_MX/ref), never from this extension.
//
//   TRACT_TOOLS_MX=<dir> TETRAVOX_CHECKOUT=<tetravox> TRACT_TOOLS_SHOTS=<dir> pnpm run e2e
// Skips without TRACT_TOOLS_MX.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

const MX = process.env['TRACT_TOOLS_MX'];
const CHECKOUT = process.env['TETRAVOX_CHECKOUT'] ?? '/Users/idohaber/00_development/tetravox';
const SHOTS = process.env['TRACT_TOOLS_SHOTS'] ?? null;
const ID = 'tetravox.tract-tools';
const REPO = resolve(import.meta.dirname, '..');
const APP_ROOT = join(CHECKOUT, 'packages/app');

const ints = (path: string): number[] => readFileSync(path, 'utf8').trim().split(/\s+/).map(Number);
const csv = (path: string): number[][] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.split(',').map(Number));
const numbers = (path: string): number[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .trim()
    .split(/\s+/)
    .map(Number);

function stageCatalogue(): string {
  const store = mkdtempSync(join(tmpdir(), 'tt-store-'));
  const files = ['index.js', 'manifest.json'].map((name) => {
    const bytes = readFileSync(join(REPO, 'dist', name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    copyFileSync(join(REPO, 'dist', name), join(store, sha256));
    return { name, bytes: bytes.length, sha256, url: pathToFileURL(join(store, sha256)).toString() };
  });
  const index = join(store, 'index.json');
  writeFileSync(
    index,
    JSON.stringify({
      schema: 1,
      generated: '2026-11-06T00:00:00Z',
      modules: [
        {
          id: ID,
          title: 'Tract tools',
          summary: 'Local catalogue for the test.',
          repo: 'https://example.invalid/tetravox-tract-tools',
          author: 'tetravox',
          licence: 'MIT',
          docs: 'https://example.invalid/tetravox-tract-tools#readme',
          versions: [{ version: '0.1.0', hostApi: 1, published: '2026-11-06', files }],
        },
      ],
    })
  );
  return index;
}

function launch(modules: string, profile: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: join(APP_ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [APP_ROOT, '--force-color-profile=srgb', `--user-data-dir=${profile}`, '--tvx-search=engine=real&modules=hello'],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      TETRAVOX_E2E_OFFSCREEN: '1',
      TETRAVOX_E2E_DISCARD: '1',
      TETRAVOX_MODULE_DIR: modules,
      TETRAVOX_EXT_INDEX: stageCatalogue(),
      TETRAVOX_HOME: mkdtempSync(join(tmpdir(), 'tt-home-')),
    } as Record<string, string>,
  });
}

/** Download, verify, consent, activate: what a user does. */
async function install(page: Page): Promise<void> {
  await page.click('[data-testid="module-switcher"]');
  await page.click('[data-testid="module-switcher-manage"]');
  await page.click(`[data-testid="extension-install-${ID}"]`);
  await expect(page.getByTestId('extension-consent-permissions')).toContainText('Write .csv, .txt');
  await page.click('[data-testid="extension-consent-accept"]');
  await expect(page.locator(`[data-testid="extension-card-${ID}"]`)).toHaveAttribute('data-state', 'enabled');
  await page.click('[data-testid="extensions-close"]');
  await page.click('[data-testid="module-switcher"]');
  await page.click(`[data-testid="module-switcher-${ID}"]`);
  await expect(page.getByTestId('tract-tools')).toBeVisible();
}

type Win = Window & { __tetravox: any };

const settled = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    await (window as unknown as Win).__tetravox.engine.whenSettled();
  });

async function openFiles(app: ElectronApplication, page: Page, files: string[]): Promise<void> {
  await app.evaluate(async ({ dialog }, list) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: list })) as typeof dialog.showOpenDialog;
  }, files);
  await page.click('[data-testid="app-menu"]');
  await page.click('[data-testid="app-menu-open"]');
}

const stubSave = (app: ElectronApplication, path: string): Promise<void> =>
  app.evaluate(async ({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, path);

/** `Engine.tractStyleInfo`: what the layer really keeps, read past the extension. */
const visible = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const t = (window as unknown as Win).__tetravox;
    const layer = t.store.getState().layers.find((l: { kind: string }) => l.kind === 'tracts');
    return t.engine.tractStyleInfo(layer.id)?.visibleStreamlines ?? null;
  });

const countIs = async (page: Page, n: number, total = 2000): Promise<void> => {
  await expect(page.getByTestId('tt-count')).toHaveText(`${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`);
  await expect.poll(() => visible(page)).toBe(n);
};

const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS === null) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

async function clickCell(page: Page, row: number, col: number): Promise<void> {
  const map = page.getByTestId('tt-heatmap');
  const cell = Number(await map.getAttribute('data-cell'));
  const gutter = Number(await map.getAttribute('data-gutter'));
  await map.scrollIntoViewIfNeeded();
  await map.click({ position: { x: gutter + (col + 0.5) * cell, y: (row + 0.5) * cell } });
}

test.skip(MX === undefined, 'skipping: TRACT_TOOLS_MX is unset');

test('a job file reaches the same operations, and its counts are MRtrix\'s', async () => {
  const ref = join(MX!, 'ref');
  const root = mkdtempSync(join(tmpdir(), 'tt-job-'));
  const store = join(root, 'modules');
  const profile = join(root, 'profile');
  const outDir = join(root, 'out');
  const dir = join(store, ID, '0.1.0');
  mkdirSync(dir, { recursive: true });
  mkdirSync(profile);
  mkdirSync(outDir);
  const files = ['index.js', 'manifest.json'].map((name) => {
    const bytes = readFileSync(join(REPO, 'dist', name));
    writeFileSync(join(dir, name), bytes);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(
    join(dir, 'tetravox-module.json'),
    JSON.stringify({ schema: 1, id: ID, version: '0.1.0', installedAt: new Date().toISOString(), files })
  );
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ extensions: { [ID]: { version: '0.1.0', hostApi: 1, grantedAt: new Date().toISOString(), permissions: [] } } })
  );
  const [idA] = ints(join(ref, 'top.txt')) as [number];
  const op = (name: string, args: object): object => ({ type: 'module', module: ID, op: name, args });
  const job = {
    scene: { files: [join(MX!, 'sub2k.tck'), join(ref, 'nodes.nii.gz')] },
    actions: [
      op('add-region', { volume: 'nodes.nii.gz', labels: String(idA) }),
      op('export-selection', { out: 'inc_A.txt' }),
      op('clear', {}),
      op('connectome', { volume: 'nodes.nii.gz', mode: 'radial', radiusMm: 4 }),
      op('export-matrix', { out: 'con.csv' }),
    ],
  };
  const jobPath = join(root, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job));
  const electronBin = join(APP_ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const run = spawnSync(
    electronBin,
    [APP_ROOT, `--user-data-dir=${profile}`, '--force-color-profile=srgb', '--job', jobPath, '--out', outDir],
    { cwd: APP_ROOT, env: { ...process.env, TETRAVOX_MODULE_DIR: store, TETRAVOX_E2E: '1' }, encoding: 'utf8', timeout: 120_000 }
  );
  const result = JSON.parse(readFileSync(join(outDir, 'job-result.json'), 'utf8'));
  expect(result.errors, run.stderr).toEqual([]);
  expect(result.ok).toBe(true);
  const expected = ints(join(ref, 'inc_A.sel.txt'));
  expect(result.outputs[0].result.selected).toBe(expected.length);
  expect(ints(join(outDir, 'inc_A.txt')).flatMap((v, i) => (v === 1 ? [i] : []))).toEqual(expected);
  const ours = csv(join(outDir, 'con.csv'));
  const con = csv(join(ref, 'con_radial.csv'));
  let sum = 0;
  for (let i = 0; i < con.length; i += 1) for (let j = i; j < con.length; j += 1) sum += Math.abs(ours[i]![j]! - con[i]![j]!);
  expect(sum).toBe(0);
});

// Set TRACT_TOOLS_BIG to a large .tck to measure the UI thread: prints, asserts only that nothing stalls for long.
test('a large tractogram leaves the UI thread free', async () => {
  const big = process.env['TRACT_TOOLS_BIG'];
  test.skip(big === undefined, 'skipping: TRACT_TOOLS_BIG is unset');
  const ref = join(MX!, 'ref');
  const modules = mkdtempSync(join(tmpdir(), 'tt-modules-'));
  const profile = mkdtempSync(join(tmpdir(), 'tt-profile-'));
  const app = await launch(modules, profile);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
    await install(page);
    await openFiles(app, page, [join(ref, 'nodes.nii.gz'), big!]);
    await expect(page.getByTestId('tt-count')).toContainText(' of ', { timeout: 120_000 });
    await settled(page);
    const size = await page.evaluate(async () => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      await t.engine.setTractBudget(d.id, null);
      await t.engine.whenSettled();
      const now = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      return `${now.nStreamlines} of ${now.sourceStreamlines} streamlines, ${now.nPoints} points`;
    });
    console.log(size);
    await page.evaluate(() => {
      const w = window as unknown as { stalls: number[] };
      w.stalls = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.stalls.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    });
    const timed = async (label: string, act: () => Promise<void>): Promise<void> => {
      const t0 = Date.now();
      await act();
      await expect(page.getByTestId('tt-busy')).toHaveCount(0, { timeout: 280_000 });
      console.log(`${label}: ${Date.now() - t0} ms; count ${await page.getByTestId('tt-count').textContent()}`);
    };
    const [idA] = ints(join(ref, 'top.txt')) as [number];
    await timed('first region rule', async () => {
      await page.getByTestId('tt-region-search').fill(String(idA));
      await page.getByTestId(`tt-region-${idA}`).check();
      await page.getByTestId('tt-region-add').click();
      await expect(page.getByTestId('tt-rule-0')).toBeVisible();
      await page.waitForTimeout(300);
    });
    await timed('include to exclude (cached)', async () => {
      await page.getByTestId('tt-rule-effect-0').click();
      await page.waitForTimeout(300);
    });
    await timed('radial connectome', async () => {
      await page.getByTestId('tt-compute').click();
      await page.waitForTimeout(300);
    });
    const stalls = (await page.evaluate(() => (window as unknown as { stalls: number[] }).stalls)).sort((a, b) => b - a);
    console.log(`long tasks: ${stalls.length}, worst ${stalls.slice(0, 5).join(', ')} ms`);
    expect(stalls[0] ?? 0).toBeLessThan(1000);
  } finally {
    await app.close();
  }
});

test('every class the panel names exists in the host stylesheet', () => {
  const assets = join(APP_ROOT, 'out/renderer/assets');
  const css = readdirSync(assets)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('');
  const panel = readFileSync(join(REPO, 'src/Panel.tsx'), 'utf8');
  const classes = new Set(
    [...panel.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) =>
      (m[1] ?? m[2] ?? '')
        .replace(/\$\{[^}]*\}/g, ' ')
        .split(/\s+/)
        .filter((c) => c !== '')
    )
  );
  expect(classes.size).toBeGreaterThan(10);
  const escape = (c: string): string => c.replace(/[[\]./:%]/g, (x) => `\\${x}`);
  expect([...classes].filter((c) => !css.includes(`.${escape(c)}`))).toEqual([]);
});

test('install, select, browse a connectome, compute statistics, export, restore', async () => {
  const ref = join(MX!, 'ref');
  const modules = mkdtempSync(join(tmpdir(), 'tt-modules-'));
  const profile = mkdtempSync(join(tmpdir(), 'tt-profile-'));
  const out = mkdtempSync(join(tmpdir(), 'tt-out-'));
  const app = await launch(modules, profile);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      if (win.isVisible()) throw new Error('the window took the screen');
      win.setContentSize(1440, 900);
    });

    await install(page);
    expect(existsSync(join(modules, ID, '0.1.0', 'index.js'))).toBe(true);

    await openFiles(app, page, [join(ref, 'nodes.nii.gz'), join(MX!, 'sub2k.tck')]);
    await expect(page.getByTestId('tt-count')).toHaveText('2,000 of 2,000', { timeout: 60_000 });
    await settled(page);
    await expect.poll(() => visible(page)).toBe(2000);

    // Region rules: the crosshair route, then search.
    const [idA, idB] = ints(join(ref, 'top.txt')) as [number, number];
    const incA = ints(join(ref, 'inc_A.sel.txt')).length;
    const incAB = ints(join(ref, 'inc_AB.sel.txt')).length;
    const excB = ints(join(ref, 'exc_B.sel.txt')).length;
    const endsA = ints(join(ref, 'ends_A.sel.txt')).length;
    await page.getByTestId('tt-region-search').fill(String(idA));
    await page.getByTestId(`tt-region-${idA}`).check();
    await page.getByTestId('tt-region-add').click();
    await countIs(page, incA);
    await page.getByTestId('tt-region-search').fill(String(idB));
    await page.getByTestId(`tt-region-${idB}`).check();
    await page.getByTestId('tt-region-add').click();
    await countIs(page, incAB);
    await page.getByTestId('tt-rule-effect-1').click();
    await countIs(page, excB);
    await page.getByTestId('tt-rule-remove-1').click();
    await countIs(page, incA);
    await page.getByTestId('tt-rule-ends-0').click();
    await countIs(page, endsA);
    await shot(page, '1-select-region-docked');
    await page.getByTestId('tt-clear').click();
    await countIs(page, 2000);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const t = (window as unknown as Win).__tetravox;
          const l = t.store.getState().layers.find((x: { kind: string }) => x.kind === 'tracts');
          return l.keepField ?? null;
        })
      )
      .toBe(null);

    // A sphere at the crosshair, in tckedit's own test, and its drawn layer at world radius.
    await page.evaluate(() => (window as unknown as Win).__tetravox.engine.setCursor([0, 0, 10]));
    await page.getByTestId('tt-sphere-radius').fill('12');
    await page.getByTestId('tt-add-sphere').click();
    await page.getByTestId('tt-rule-test-0').click();
    await countIs(page, ints(join(ref, 'sph.sel.txt')).length);
    const sphere = await page.evaluate(() => {
      const t = (window as unknown as Win).__tetravox;
      const l = t.store.getState().layers.find((x: { kind: string; module?: string }) => x.kind === 'points' && x.module === 'tetravox.tract-tools');
      return { radius: l.points[0].radiusMm, position: Array.from(l.points[0].position) };
    });
    expect(sphere).toEqual({ radius: 12, position: [0, 0, 10] });
    await page.getByTestId('tt-min').fill('60');
    await page.getByTestId('tt-clear').click();
    await countIs(page, 2000);

    // Length: live, with tckedit's tolerance from the tck header.
    await page.getByTestId('tt-min').fill('60');
    await page.getByTestId('tt-max').fill('120');
    await countIs(page, ints(join(ref, 'len.sel.txt')).length);
    await page.getByTestId('tt-clear').click();
    await countIs(page, 2000);

    // The connectome.
    await page.getByTestId('tt-compute').click();
    const con = csv(join(ref, 'con_radial.csv'));
    const edgeCount = con.flat().filter((v) => v > 0).length;
    await expect(page.getByTestId('tt-matrix-summary')).toContainText(`${edgeCount.toLocaleString('en-US')} edges`, { timeout: 60_000 });
    await expect(page.getByTestId('tt-heatmap')).toBeVisible();
    const nodes = await page.evaluate(() => {
      const assign = document.querySelector('[data-testid="tt-heatmap"]') as HTMLCanvasElement;
      return Number(assign.dataset['nodes']);
    });
    const ids = [...new Set(con.flatMap((row, i) => row.flatMap((v, j) => (v > 0 ? [i + 1, j + 1] : []))))].sort((a, b) => a - b);
    expect(nodes).toBe(ids.length);
    await shot(page, '2-connectome-docked');

    // A drawn pixel: the map holds data, not a blank canvas, asserted on a cell by value.
    const painted = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="tt-heatmap"]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 200 && d[i]! !== d[i + 1]!) colored += 1;
      return colored;
    });
    expect(painted).toBeGreaterThan(100);

    // The heaviest edge from the reference matrix: click it, and the count is MRtrix's.
    let best = { i: 0, j: 0, v: 0 };
    con.forEach((row, i) => row.forEach((v, j) => {
      if (v > best.v && i !== j) best = { i, j, v };
    }));
    await clickCell(page, ids.indexOf(best.i + 1), ids.indexOf(best.j + 1));
    await countIs(page, best.v);
    await shot(page, '3-edge-selected-docked');
    const hover = await page.getByTestId('tt-hover').textContent();
    expect(hover).toContain(`${best.i + 1} ↔ ${best.j + 1}: ${best.v}`);

    // Combines with a rule (AND). The expected count is the reference's own: edge streamlines from the
    // assignments, intersected with tckedit's retained set.
    const assignments = readFileSync(join(ref, 'as_radial.txt'), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split(/\s+/).map(Number) as [number, number]);
    const inEdge = new Set(
      assignments.flatMap(([a, b], s) =>
        (a === best.i + 1 && b === best.j + 1) || (a === best.j + 1 && b === best.i + 1) ? [s] : []
      )
    );
    expect(inEdge.size).toBe(best.v);
    const retained = ints(join(ref, 'len.sel.txt'));
    await page.getByTestId('tt-min').fill('60');
    await page.getByTestId('tt-max').fill('120');
    await countIs(page, retained.filter((s) => inEdge.has(s)).length);
    await page.getByTestId('tt-clear').click();
    await countIs(page, 2000);

    // A row: a node's streamlines.
    const row = ids.indexOf(best.i + 1);
    const map = page.getByTestId('tt-heatmap');
    const cell = Number(await map.getAttribute('data-cell'));
    await map.scrollIntoViewIfNeeded();
    await map.click({ position: { x: 4, y: (row + 0.5) * cell } });
    const touching = assignments.filter(([a, b]) => a !== 0 && b !== 0 && (a === best.i + 1 || b === best.i + 1)).length;
    await countIs(page, touching);
    await page.getByTestId('tt-clear-edge').click();
    await countIs(page, 2000);

    // Statistics from a sampled field: the sidecar MRtrix wrote, matched to its stat_tck.
    await openFiles(app, page, [join(MX!, 'fa.tsf')]);
    await page.waitForFunction(() => {
      const t = (window as unknown as Win).__tetravox;
      return t.store.getState().datasets.find((d: { kind: string }) => d.kind === 'tractogram').vertexFields.length > 0;
    });
    await page.locator('[data-testid="tt-stats"] summary').click();
    const field = (await page.evaluate(() => {
      const t = (window as unknown as Win).__tetravox;
      return t.store.getState().datasets.find((d: { kind: string }) => d.kind === 'tractogram').vertexFields.find((f: { name: string }) => !f.name.startsWith('tract-tools:')).name;
    })) as string;
    await page.getByTestId('tt-stat-max').click();
    await page.getByTestId('tt-stat-run').click();
    await page.waitForFunction((f) => {
      const t = (window as unknown as Win).__tetravox;
      return t.store.getState().datasets.find((d: { kind: string }) => d.kind === 'tractogram').streamlineFields.some((x: { name: string }) => x.name === `${f}:max`);
    }, field);
    const stat = (name: string): Promise<number[]> =>
      page.evaluate(async (n) => {
        const t = (window as unknown as Win).__tetravox;
        const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
        return Array.from(await t.engine.tractFieldValues(d.id, 'streamline', n, 0, d.nStreamlines));
      }, name) as Promise<number[]>;
    for (const [s, name] of [['mean', 'fa_mean.txt'], ['max', 'fa_max.txt']] as const) {
      const got = await stat(`${field}:${s}`);
      const expected = numbers(join(ref, name));
      expect(got.length).toBe(2000);
      expect(Math.max(...got.map((v, i) => Math.abs(v - expected[i]!)))).toBeLessThan(1e-5);
    }

    // Export the matrix and the selection; the matrix against tck2connectome's.
    await page.locator('[data-testid="tt-export"] summary').click();
    const csvPath = join(out, 'matrix.csv');
    await stubSave(app, csvPath);
    await page.getByTestId('tt-export-matrix').click();
    await expect.poll(() => existsSync(csvPath)).toBe(true);
    const ours = csv(csvPath);
    let sum = 0;
    for (let i = 0; i < con.length; i += 1) for (let j = i; j < con.length; j += 1) sum += Math.abs(ours[i]![j]! - con[i]![j]!);
    expect(ours.length).toBe(con.length);
    expect(sum).toBe(0);

    await page.getByTestId('tt-min').fill('60');
    await page.getByTestId('tt-max').fill('120');
    await countIs(page, retained.length);
    const selPath = join(out, 'selection.txt');
    await stubSave(app, selPath);
    await page.getByTestId('tt-export-selection').click();
    await expect.poll(() => existsSync(selPath)).toBe(true);
    const row01 = ints(selPath);
    expect(row01.length).toBe(2000);
    expect(row01.flatMap((v, i) => (v === 1 ? [i] : []))).toEqual(retained);

    // Save the scene, reopen it, and the recipe recomputes: count, layer, and matrix.
    await clickCell(page, ids.indexOf(best.i + 1), ids.indexOf(best.j + 1));
    const both = retained.filter((s) => inEdge.has(s)).length;
    await countIs(page, both);
    const scenePath = join(out, 'study.tetravox.json');
    await stubSave(app, scenePath);
    await page.click('[data-testid="app-menu"]');
    await page.click('[data-testid="app-menu-save"]');
    await expect.poll(() => existsSync(scenePath)).toBe(true);
    const scene = JSON.parse(readFileSync(scenePath, 'utf8'));
    const block = scene.view?.extensions?.[ID] ?? scene.extensions?.[ID];
    expect(block.data.tract).toBe('sub2k.tck');
    const blockText = JSON.stringify(block);
    for (const d of await page.evaluate(() => (window as unknown as Win).__tetravox.store.getState().datasets.map((x: { id: string }) => x.id))) {
      expect(blockText).not.toContain(`"${d}"`);
    }

    await app.evaluate(async ({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
    }, scenePath);
    await page.click('[data-testid="app-menu"]');
    await page.click('[data-testid="app-menu-open-scene"]');
    await expect(page.getByTestId('tt-count')).toHaveText(`${both} of 2,000`, { timeout: 90_000 });
    await expect.poll(() => visible(page)).toBe(both);
    await expect(page.getByTestId('tt-matrix-summary')).toContainText(`${edgeCount.toLocaleString('en-US')} edges`);
    await shot(page, '4-restored-docked');

    // A budget change drops written fields: the recipe recomputes, says it covers a subset, and export refuses.
    await page.evaluate(async () => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      await t.engine.setTractBudget(d.id, 100_000);
    });
    await expect(page.getByTestId('tt-subset')).toContainText('displayed ones only', { timeout: 60_000 });
    const subset = await page.evaluate(() => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      return { held: d.nStreamlines };
    });
    expect(subset.held).toBeLessThan(2000);
    await expect(page.getByTestId('tt-count')).toContainText(` of ${subset.held.toLocaleString('en-US')}`);
    await expect.poll(() => page.evaluate(() => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      return d.streamlineFields.some((f: { name: string }) => f.name === 'tract-tools:selected');
    })).toBe(true);
    await page.locator('[data-testid="tt-export"] summary').scrollIntoViewIfNeeded();
    const details = page.getByTestId('tt-export');
    if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
    await page.getByTestId('tt-export-selection').click();
    await expect(page.getByTestId('tt-message')).toContainText('of 2,000 streamlines are held');
    await shot(page, '5-subset-refusal-docked');
    await page.evaluate(async () => {
      const t = (window as unknown as Win).__tetravox;
      const d = t.store.getState().datasets.find((x: { kind: string }) => x.kind === 'tractogram');
      await t.engine.setTractBudget(d.id, null);
    });
    await expect(page.getByTestId('tt-count')).toHaveText(`${both} of 2,000`, { timeout: 60_000 });

    // The pop-out window (hidden, as every window here), where the map gets real pixels.
    const popup = app.waitForEvent('window');
    await page.click('[data-testid="module-slot-popout"]');
    const win = await popup;
    await expect(win.getByTestId('tt-heatmap')).toBeVisible();
    await expect.poll(async () => Number(await win.getByTestId('tt-heatmap').getAttribute('data-cell'))).toBeGreaterThan(2);
    // The map fits the window, so nothing needs a scroll to reach it.
    const fits = await win.evaluate(() => {
      const box = document.querySelector('[data-testid="tt-heatmap"]')!.getBoundingClientRect();
      return { bottom: box.bottom, height: window.innerHeight };
    });
    expect(fits.bottom).toBeLessThanOrEqual(fits.height);
    if (SHOTS !== null) await win.screenshot({ path: join(SHOTS, '6-popout.png') });
  } finally {
    await app.close();
  }
});
