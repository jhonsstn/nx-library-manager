import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Playwright loads specs in this project as CommonJS (the app itself is CJS for
// the Electron main process), so `__dirname` is what is available here.
const PROJECT_ROOT = resolve(__dirname, '../..');

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let libraryDir: string;
let updatesDir: string;
let serverPort: number;

/** The library list is the only listbox whose accessible name is `Games`. */
function gameRow(name: string) {
  return page.getByRole('listbox', { name: 'Games' }).getByRole('option', { name, exact: true });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`, `--database-root=${userDataDir}`],
    cwd: PROJECT_ROOT,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'nlm-e2e-userdata-'));
  libraryDir = mkdtempSync(join(tmpdir(), 'nlm-e2e-library-'));
  updatesDir = mkdtempSync(join(tmpdir(), 'nlm-e2e-updates-'));
  serverPort = await freePort();

  // Fake package files: only names and sizes matter to the scanner.
  mkdirSync(join(libraryDir, 'nested'), { recursive: true });
  writeFileSync(join(libraryDir, 'Hades.nsp'), Buffer.alloc(2048));
  writeFileSync(join(libraryDir, 'nested', 'Mario Kart 8 Deluxe.nsz'), Buffer.alloc(2048));
  writeFileSync(join(updatesDir, 'Hades [v131072].nsp'), Buffer.alloc(1024));
  writeFileSync(join(updatesDir, 'Unknown Thing [v65536].nsp'), Buffer.alloc(1024));

  await launch();
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  for (const dir of [userDataDir, libraryDir, updatesDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launches with a working shell and no Node access in the renderer', async () => {
  const storage = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData'),
    sessionData: electronApp.getPath('sessionData'),
  }));
  expect(storage).toEqual({
    userData: join(userDataDir, 'data'),
    sessionData: join(userDataDir, 'data', 'session'),
  });
  expect(existsSync(join(userDataDir, 'library.sqlite3'))).toBe(true);

  await expect(page.getByText('NX Library Manager').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Library' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

  const nodeLeak = await page.evaluate(() => ({
    hasRequire: typeof (globalThis as { require?: unknown }).require === 'function',
    hasProcess: typeof (globalThis as { process?: unknown }).process !== 'undefined',
    hasBridge: typeof (globalThis as { switchCatalog?: unknown }).switchCatalog !== 'undefined',
  }));
  expect(nodeLeak).toEqual({ hasRequire: false, hasProcess: false, hasBridge: true });
});

test('configures the library folders, scans them and lists the catalog', async () => {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Base games folder').fill(libraryDir);
  await page.getByLabel('Updates folder').fill(updatesDir);
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByRole('link', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'Rescan Library' }).click();

  // Both base games are discovered recursively; the update is matched to Hades.
  await expect(gameRow('Hades')).toBeVisible({ timeout: 30_000 });
  await expect(gameRow('Mario Kart 8 Deluxe')).toBeVisible();

  // The unmatched update surfaces its own section.
  await expect(page.getByRole('link', { name: /Unmatched/ })).toBeVisible();
});

test('search filters the library and details show the matched update', async () => {
  await page.getByRole('link', { name: 'Library' }).click();
  await page.getByLabel('Search library').fill('Hades');
  await expect(gameRow('Hades')).toBeVisible();
  await expect(gameRow('Mario Kart 8 Deluxe')).toBeHidden();

  await gameRow('Hades').click();
  await expect(page.getByText('Hades.nsp').first()).toBeVisible();
  await expect(page.getByText(/Update status unknown/)).toBeVisible();
  await expect(page.getByRole('listbox', { name: 'DLC and updates' })
    .getByRole('option', { name: /^Hades \[v131072\]\.nsp/ })).toBeVisible();
});

test('favorites persist across a restart, and the DBI server starts and stops', async () => {
  await page.getByRole('link', { name: 'Library' }).click();
  await page.getByLabel('Search library').fill('');
  await gameRow('Hades').click();
  await page.getByRole('button', { name: 'Favorite game' }).click();
  await expect(page.getByRole('button', { name: 'Remove favorite' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('HTTP port').fill(String(serverPort));
  await page.getByLabel('Enable HTTP server').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Start server' }).click();
  // The URL is rendered both in the DBI panel and in the status bar.
  await expect(page.getByText(`http://`).first()).toBeVisible();
  await expect(page.getByText(`:${serverPort}/dir/`).first()).toBeVisible();
  await page.getByRole('button', { name: 'Stop server' }).click();

  await app.close();

  await launch();
  await page.getByRole('link', { name: 'Library' }).click();
  await gameRow('Hades').click();
  await expect(page.getByRole('button', { name: 'Remove favorite' })).toBeVisible();
  await expect(page.getByText(/Update status unknown/)).toBeVisible();
});
