import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { ensureAppPaths, resolveAppPaths, type AppPaths } from '@main/platform/paths';
import { HttpServerService } from '@main/services/http-server.service';
import { upsertBaseGameFile } from '@main/repositories/game-files.repository';
import { upsertGameByCleanedTitle } from '@main/repositories/games.repository';
import { defaultAppSettings } from '@shared/schemas/settings';
import type { AppSettings } from '@shared/types/settings';
import { TEMP_ROOT } from '../../setup/vitest.setup';

const open: Array<() => Promise<void>> = [];

async function createHarness(overrides: Partial<AppSettings> = {}): Promise<{
  db: AppDatabase;
  paths: AppPaths;
  service: HttpServerService;
  settings: AppSettings;
}> {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  const paths = resolveAppPaths(dir);
  ensureAppPaths(paths);
  const db = openDatabase(paths.databaseFile);
  runMigrations(db, paths.databaseFile);

  // One catalogued file so the listing has content to serve.
  const gameId = upsertGameByCleanedTitle(db, { displayTitle: 'Hades', cleanedTitle: 'Hades' });
  const libraryFile = join(dir, 'Hades.nsp');
  writeFileSync(libraryFile, Buffer.from('switch-package-bytes'));
  upsertBaseGameFile(db, {
    gameId,
    filePath: libraryFile,
    fileName: 'Hades.nsp',
    fileExtension: '.nsp',
    fileSize: 20,
    modifiedTime: Date.now(),
    fileType: 'NSP',
  });

  const settings: AppSettings = {
    ...defaultAppSettings(),
    httpServerPort: 0,
    httpServerEnabled: true,
    ...overrides,
  };
  const service = new HttpServerService({ db, paths, settings: () => settings });
  open.push(async () => {
    await service.stop();
    closeDatabase(db);
  });
  return { db, paths, service, settings };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

describe('HttpServerService', () => {
  it('reports a stopped server before it is started', async () => {
    const { service } = await createHarness();
    await expect(service.getStatus()).resolves.toMatchObject({
      running: false,
      directoryUrl: '',
      authEnabled: false,
    });
  });

  it('starts on the configured port, serves the catalog listing and stops', async () => {
    const { service } = await createHarness();
    const started = await service.start();
    expect(started.running).toBe(true);
    expect(started.port).toBeGreaterThan(0);
    expect(started.directoryUrl).toMatch(/^http:\/\/[\d.]+:\d+\/dir\/$/);

    const response = await fetch(`http://127.0.0.1:${started.port}/dir/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Hades.nsp');
    expect(html).toContain('Index of /dir/');

    const stopped = await service.stop();
    expect(stopped.running).toBe(false);
    await expect(fetch(`http://127.0.0.1:${started.port}/dir/`)).rejects.toThrow();
  });

  it('serves range requests for catalogued files', async () => {
    const { service } = await createHarness();
    const started = await service.start();
    const response = await fetch(`http://127.0.0.1:${started.port}/dir/Hades.nsp`, {
      headers: { Range: 'bytes=0-5' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-5/20');
    await expect(response.text()).resolves.toBe('switch');
  });

  it('enforces Basic Auth when a password is configured', async () => {
    const { service } = await createHarness({ httpServerUsername: 'dbiuser', httpServerPassword: 's3cret' });
    const started = await service.start();
    expect(started.authEnabled).toBe(true);

    const unauthorized = await fetch(`http://127.0.0.1:${started.port}/dir/`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('Basic realm=');

    const authorized = await fetch(`http://127.0.0.1:${started.port}/dir/`, {
      headers: { Authorization: `Basic ${Buffer.from('dbiuser:s3cret').toString('base64')}` },
    });
    expect(authorized.status).toBe(200);
  });

  it('surfaces a port conflict as an error status instead of crashing', async () => {
    const first = await createHarness();
    const running = await first.service.start();

    const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
    const paths = resolveAppPaths(dir);
    ensureAppPaths(paths);
    const db = openDatabase(paths.databaseFile);
    runMigrations(db, paths.databaseFile);
    const settings = { ...defaultAppSettings(), httpServerPort: running.port };
    const second = new HttpServerService({ db, paths, settings: () => settings });
    open.push(async () => {
      await second.stop();
      closeDatabase(db);
    });

    await expect(second.start()).rejects.toMatchObject({ code: 'HTTP_PORT_IN_USE' });
    await expect(second.getStatus()).resolves.toMatchObject({ running: false });
    expect((await second.getStatus()).error?.code).toBe('HTTP_PORT_IN_USE');
  });

  it('applies settings by starting when enabled and stopping when disabled', async () => {
    const harness = await createHarness({ httpServerEnabled: false });
    const disabled = await harness.service.applySettings();
    expect(disabled.running).toBe(false);

    harness.settings.httpServerEnabled = true;
    const enabled = await harness.service.applySettings();
    expect(enabled.running).toBe(true);
    expect(enabled.directoryUrl).not.toBe('');

    harness.settings.httpServerEnabled = false;
    await expect(harness.service.applySettings()).resolves.toMatchObject({ running: false });
  });
});
