// Launching the real app, hidden, with the built extension installed through the real download-verify-consent path.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

export const CHECKOUT = process.env['TETRAVOX_CHECKOUT'] ?? '/Users/idohaber/00_development/tetravox';
export const SHOTS = process.env['TRACT_TOOLS_SHOTS'] ?? null;
export const ID = 'tetravox.tract-tools';
export const REPO = resolve(import.meta.dirname, '..');
export const APP_ROOT = join(CHECKOUT, 'packages/app');
export const ELECTRON = join(APP_ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
export const VERSION = (JSON.parse(readFileSync(join(REPO, 'dist/manifest.json'), 'utf8')) as { version: string }).version;

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
          versions: [{ version: VERSION, hostApi: 1, published: '2026-11-06', files }],
        },
      ],
    })
  );
  return index;
}

export function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: ELECTRON,
    args: [APP_ROOT, '--force-color-profile=srgb', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'tt-profile-'))}`, '--tvx-search=engine=real&modules=hello'],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      TETRAVOX_E2E_OFFSCREEN: '1',
      TETRAVOX_E2E_DISCARD: '1',
      TETRAVOX_MODULE_DIR: mkdtempSync(join(tmpdir(), 'tt-modules-')),
      TETRAVOX_EXT_INDEX: stageCatalogue(),
      TETRAVOX_HOME: mkdtempSync(join(tmpdir(), 'tt-home-')),
    } as Record<string, string>,
  });
}

export async function ready(app: ElectronApplication, width: number, height: number): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  await setSize(app, width, height);
  return page;
}

export const setSize = (app: ElectronApplication, width: number, height: number): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      if (win.isVisible()) throw new Error('the window took the screen');
      win.setContentSize(size.width, size.height);
    },
    { width, height }
  );

/** Download, verify, consent, activate: what a user does. */
export async function install(page: Page): Promise<void> {
  await page.click('[data-testid="module-switcher"]');
  await page.click('[data-testid="module-switcher-manage"]');
  await page.click(`[data-testid="extension-install-${ID}"]`);
  await expect(page.getByTestId('extension-consent-permissions')).toContainText('into a folder you choose');
  await page.click('[data-testid="extension-consent-accept"]');
  await expect(page.locator(`[data-testid="extension-card-${ID}"]`)).toHaveAttribute('data-state', 'enabled');
  await page.click('[data-testid="extensions-close"]');
  await page.click('[data-testid="module-switcher"]');
  await page.click(`[data-testid="module-switcher-${ID}"]`);
  await expect(page.getByTestId('tract-tools')).toBeVisible();
}

export type Win = Window & { __tetravox: any };

export async function stubOpen(app: ElectronApplication, files: string[]): Promise<void> {
  await app.evaluate(async ({ dialog }, list) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: list })) as typeof dialog.showOpenDialog;
  }, files);
}

export async function openFiles(app: ElectronApplication, page: Page, files: string[]): Promise<void> {
  await stubOpen(app, files);
  await page.click('[data-testid="app-menu"]');
  await page.click('[data-testid="app-menu-open"]');
}

/** What the layer really keeps, read past the extension. */
export const visible = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const t = (window as unknown as Win).__tetravox;
    const layer = t.store.getState().layers.find((l: { kind: string }) => l.kind === 'tracts');
    return t.engine.tractStyleInfo(layer.id)?.visibleStreamlines ?? null;
  });

/** The module's own job entry, for the bulk of a run the panel test already drives by hand. */
export const operation = (page: Page, op: string, args: object): Promise<any> =>
  page.evaluate(
    ([id, name, a]) => (window as unknown as Win).__tetravox.controller.moduleSessions.get(id).instance.runOperation(name, a),
    [ID, op, args] as const
  );

export const idle = async (page: Page, timeout = 280_000): Promise<void> => {
  await expect(page.getByTestId('tt-busy')).toHaveCount(0, { timeout });
};

export async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === null) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Nothing the panel holds may run past its own width: a number, not a look. */
export const overflow = (page: Page, testId = 'module-slot-body'): Promise<{ scroll: number; client: number; wide: string[] }> =>
  page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    const right = root.getBoundingClientRect().right + 0.5;
    const wide = [...root.querySelectorAll('*')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        // Inside a horizontal scroller or a truncated cell a child may be wider; nothing is here.
        return box.width > 0 && box.right > right && (el as HTMLElement).closest('svg') === null && (el.parentElement as HTMLElement).scrollWidth > (el.parentElement as HTMLElement).clientWidth + 1;
      })
      .map((el) => (el as HTMLElement).dataset['testid'] ?? el.tagName);
    return { scroll: root.scrollWidth, client: root.clientWidth, wide };
  }, testId);

export async function expectNoOverflow(page: Page, testId?: string): Promise<void> {
  const got = await overflow(page, testId);
  expect(got.wide).toEqual([]);
  expect(got.scroll).toBeLessThanOrEqual(got.client);
}
