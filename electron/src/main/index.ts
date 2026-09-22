import { existsSync, rmSync } from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { join, resolve } from 'node:path';
import type { PublicSettingsDto } from '../shared/types/settings';
import type { LegacyDataInfoDto } from '../shared/types/domain';
import { appError } from '../shared/errors/app-error';
import { closeDatabase, openDatabase, type AppDatabase } from './db/database';
import { runMigrations } from './db/migrations';
import { createLogger, type Logger } from './lifecycle/logger';
import { registerAppProtocol, registerAppSchemes, registerCatalogImageProtocol } from './lifecycle/protocols';
import { createMainWindow, createRecoveryWindow } from './lifecycle/window';
import { createSafeStorageCipher } from './lifecycle/safe-cipher';
import { ensureAppPaths, legacyAppDir, resolveAppPaths, type AppPaths } from './platform/paths';
import { SettingsStore } from './settings/settings.store';
import { importLegacyData, readLegacyDataInfo } from './settings/legacy-import';
import { PowerShellMtpAdapter } from './mtp/powershell-mtp.adapter';
import { CatalogService } from './services/catalog.service';
import { FileService } from './services/file.service';
import { HttpServerService } from './services/http-server.service';
import { InstallService } from './services/install.service';
import { MetadataService } from './services/metadata.service';
import { MtpService } from './services/mtp.service';
import { ScannerService } from './services/scanner.service';
import { VersionService } from './services/version.service';
import { AppUpdateService } from './services/app-update.service';
import { ImageCache } from './metadata/image-cache';
import { registerIpc, type IpcDeps } from './ipc';
import { resolveScanInput } from './ipc/scan.ipc';
import { EVENTS } from '../shared/contracts/ipc';
import { MTP_STATUS_REFRESH_MS } from '../shared/constants';

interface AppState {
  paths: AppPaths;
  logger: Logger;
  db: AppDatabase;
  settings: SettingsStore;
  scanner: ScannerService;
  install: InstallService;
  mtp: MtpService;
  httpServer: HttpServerService;
  versions: VersionService;
  /** True when this session created the catalog file, so it holds no user data. */
  createdFreshDatabase: boolean;
  shuttingDown: boolean;
}

let state: AppState | null = null;
let mainWindow: BrowserWindow | null = null;

registerAppSchemes();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    void shutdown();
  });

  void app.whenReady().then(() => {
    bootstrap();
  });
}

function bootstrap(): void {
  app.setAppUserModelId('com.switchgamecatalog.app');

  const paths = resolveAppPaths(app.getPath('userData'));
  ensureAppPaths(paths);
  const logger = createLogger({ logsDir: paths.logsDir, level: app.isPackaged ? 'info' : 'debug' });

  const cipher = createSafeStorageCipher();
  if (!cipher) {
    // Without an OS keychain the app keeps working; secrets are simply not stored.
    logger.warn('settings.noSecretCipher', { platform: process.platform });
  }
  const settings = new SettingsStore({ paths, cipher });

  const createdFreshDatabase = !existsSync(paths.databaseFile);
  const db = openDatabase(paths.databaseFile);
  try {
    const result = runMigrations(db, paths.databaseFile);
    if (result.applied.length > 0) {
      logger.info('db.migrated', { versions: result.applied, backup: result.backupFile });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('db.migrationFailed', { error: message });
    closeDatabase(db);
    createRecoveryWindow({ databaseFile: paths.databaseFile, message, backupFile: null });
    return;
  }

  registerAppProtocol(join(__dirname, '..', 'renderer'));
  registerCatalogImageProtocol({ coversCacheDir: paths.coversCacheDir, screenshotsCacheDir: paths.screenshotsCacheDir });

  const versions = new VersionService({ db, paths, logger: logger.child('versions') });
  const catalog = new CatalogService({
    db,
    versions,
    settings: () => settings.getFull(),
    logger: logger.child('catalog'),
  });
  const mtpAdapter = new PowerShellMtpAdapter({ scriptsDir: resolveScriptsDir() });
  const mtp = new MtpService({
    adapter: mtpAdapter,
    logger: logger.child('mtp'),
    pollIntervalMs: MTP_STATUS_REFRESH_MS,
    onStatusChanged: (status) => emit(EVENTS.mtpStatusChanged, status),
  });
  const httpServer = new HttpServerService({
    db,
    paths,
    settings: () => settings.getFull(),
    logger: logger.child('http'),
    onStatusChanged: (status) => emit(EVENTS.httpServerStatusChanged, status),
  });
  const install = new InstallService({
    db,
    mtp: mtpAdapter,
    settings: { getFull: () => settings.getFull() },
    logger: logger.child('install'),
    onJobChanged: (job) => emit(EVENTS.installChanged, job),
  });
  const files = new FileService({ db, logger: logger.child('files') });
  const metadata = new MetadataService({
    db,
    paths,
    credentials: () => {
      const secrets = settings.getSecrets();
      return { clientId: settings.getFull().igdbClientId, clientSecret: secrets.igdbClientSecret };
    },
    imageCache: new ImageCache({
      coversDir: paths.coversCacheDir,
      screenshotsDir: paths.screenshotsCacheDir,
      logger: logger.child('images'),
    }),
    logger: logger.child('metadata'),
  });
  const scanner = new ScannerService({
    db,
    logger: logger.child('scanner'),
    onProgress: (event) => emit(EVENTS.scanProgress, event),
    onCompleted: (event) => emit(EVENTS.scanCompleted, event),
  });
  const appUpdate = new AppUpdateService({ currentVersion: app.getVersion() });

  state = {
    paths,
    logger,
    db,
    settings,
    scanner,
    install,
    mtp,
    httpServer,
    versions,
    createdFreshDatabase,
    shuttingDown: false,
  };

  const deps: IpcDeps = {
    paths,
    db,
    logger,
    settings,
    catalog,
    scanner,
    metadata,
    install,
    files,
    mtp,
    httpServer,
    appUpdate,
    currentVersion: app.getVersion(),
    legacy: {
      info: () => readLegacyDataInfo(legacyAppDir()),
      import: () => runLegacyImport(),
      skip: () => settings.update({ legacyImportDismissed: true }),
    },
    emit,
  };
  registerIpc(deps);

  const preloadPath = join(__dirname, '..', 'preload', 'index.js');
  mainWindow = createMainWindow({ preloadPath, iconPath: resolveIconPath() });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Startup work described in the spec: MTP status, HTTP server, versions, scan.
  install.recoverInterrupted();
  mtp.start();
  const currentSettings = settings.getFull();
  void httpServer.applySettings();
  void versions.load();
  if (currentSettings.autoRescanOnStartup && currentSettings.baseGamesFolder) {
    void scanner.start(resolveScanInput(currentSettings, {})).catch((error: unknown) => {
      logger.warn('scan.autoStartFailed', { error: error instanceof Error ? error.message : String(error) });
    });
  }
}

function emit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

function resolveScriptsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'scripts')
    : resolve(__dirname, '..', '..', 'resources', 'scripts');
}

function resolveIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(__dirname, '..', '..', 'resources', 'icon.png');
}

/**
 * First-run import (Flow A): copy the Qt data, migrate the copy, then relaunch so
 * every service opens the imported database. The Qt files are never modified.
 */
async function runLegacyImport(): Promise<PublicSettingsDto> {
  const current = state;
  if (!current) throw appError('DATABASE_ERROR', 'The application is not ready yet.');
  if (current.shuttingDown) throw appError('JOB_CANCELLED', 'The application is shutting down.');

  // Release the catalog before its file is replaced on disk.
  closeDatabase(current.db);

  if (current.createdFreshDatabase) {
    // This session created an empty catalog; remove it so the import can copy in.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${current.paths.databaseFile}${suffix}`, { force: true });
      } catch {
        /* the file may not exist */
      }
    }
  }

  const result = importLegacyData({
    legacyDir: legacyAppDir(),
    paths: current.paths,
    settings: current.settings.getFull(),
  });

  const copy = openDatabase(current.paths.databaseFile);
  try {
    const migration = runMigrations(copy, current.paths.databaseFile);
    current.logger.info('legacy.imported', {
      migrated: migration.applied,
      database: result.imported.database,
      settings: result.imported.settings,
      imageCacheFiles: result.imported.imageCacheFiles,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    current.logger.error('legacy.migrationFailed', { error: message });
    closeDatabase(copy);
    throw appError('DATABASE_ERROR', `The imported catalog could not be upgraded: ${message}`);
  }
  closeDatabase(copy);

  const { schemaVersion: _schemaVersion, ...patch } = result.settings;
  const publicSettings = current.settings.update(patch);
  current.logger.info('legacy.restarting');

  app.relaunch();
  app.exit(0);
  return publicSettings;
}

/** Shutdown order from spec 01. */
async function shutdown(): Promise<void> {
  const current = state;
  if (!current || current.shuttingDown) return;
  current.shuttingDown = true;
  try {
    current.mtp.stop();
    await current.httpServer.stop();
    current.scanner.shutdown();
    current.install.shutdown();
    // Let an in-flight transfer settle before the handle closes.
    await current.install.whenIdle();
    closeDatabase(current.db);
    current.logger.info('app.shutdown');
  } catch (error) {
    current.logger.error('app.shutdownFailed', { error: error instanceof Error ? error.message : String(error) });
  }
}
