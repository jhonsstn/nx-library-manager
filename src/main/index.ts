import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeDatabase, openDatabase, type AppDatabase } from './db/database';
import { runMigrations } from './db/migrations';
import { createLogger, type Logger } from './lifecycle/logger';
import { registerAppProtocol, registerAppSchemes, registerCatalogImageProtocol } from './lifecycle/protocols';
import { createMainWindow, createRecoveryWindow } from './lifecycle/window';
import { createSafeStorageCipher } from './lifecycle/safe-cipher';
import { ShutdownCoordinator } from './lifecycle/shutdown';
import { ensureAppPaths, resolveAppPaths, type AppPaths } from './platform/paths';
import { resolveDatabaseRoot } from './platform/database-root';
import { SettingsStore } from './settings/settings.store';
import { ProdKeysStore } from './settings/prod-keys';
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
import { rejectNewIpcWork } from './ipc/handle';
import { resolveScanInput } from './ipc/scan.ipc';
import { EVENTS } from '../shared/contracts/ipc';
import { MTP_STATUS_REFRESH_MS } from '../shared/constants';
import { runPackagedSmoke } from './smoke';

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
  shuttingDown: boolean;
}

let state: AppState | null = null;
let mainWindow: BrowserWindow | null = null;
const shutdownCoordinator = new ShutdownCoordinator({
  shutdown,
  quit: () => app.quit(),
  waitingMessage: () => {
    if (state?.install.isBusy) return 'Waiting for the current install transfer to finish…';
    if (state?.scanner.isBusy) return 'Cancelling the active library scan…';
    return 'Finishing background work…';
  },
  onStatus: (status) => emit(EVENTS.shutdownStatusChanged, status),
});

registerAppSchemes();

const smokeTest = process.argv.includes('--smoke-test');
const developmentOverride = process.argv.find((arg) => arg.startsWith('--database-root='))?.slice('--database-root='.length);
const appRoot = resolveDatabaseRoot({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  executablePath: app.getPath('exe'),
  platform: process.platform,
  portableExecutableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  developmentOverride,
});
const portableDataRoot = join(appRoot, 'data');

// Configure Chromium storage before Electron's ready event so cookies, GPU
// caches and the app's own settings travel with the portable executable.
if (!smokeTest) {
  mkdirSync(portableDataRoot, { recursive: true });
  const sessionRoot = join(portableDataRoot, 'session');
  mkdirSync(sessionRoot, { recursive: true });
  app.setPath('userData', portableDataRoot);
  app.setPath('sessionData', sessionRoot);
  app.setAppLogsPath(join(portableDataRoot, 'logs'));
}

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

  app.on('before-quit', (event) => {
    shutdownCoordinator.request(event);
  });

  void app.whenReady().then(() => {
    if (smokeTest) {
      void runPackagedSmoke().then(
        () => { process.stdout.write('Package smoke passed\n'); app.exit(0); },
        (error: unknown) => {
          process.stderr.write(`Package smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
          app.exit(1);
        },
      );
    } else bootstrap();
  });
}

function bootstrap(): void {
  app.setAppUserModelId('com.switchgamecatalog.app');

  const paths = resolveAppPaths(app.getPath('userData'), appRoot);
  ensureAppPaths(paths);
  const logger = createLogger({ logsDir: paths.logsDir, level: app.isPackaged ? 'info' : 'debug' });

  const cipher = createSafeStorageCipher();
  if (!cipher) {
    // Without an OS keychain the app keeps working; secrets are simply not stored.
    logger.warn('settings.noSecretCipher', { platform: process.platform });
  }
  const settings = new SettingsStore({ paths, cipher });
  const prodKeys = new ProdKeysStore(paths.userDataDir, cipher);

  let db: AppDatabase | null = null;
  try {
    db = openDatabase(paths.databaseFile);
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
  versions.loadCached();
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
    prodKeys,
    logger: logger.child('scanner'),
    onProgress: (event) => emit(EVENTS.scanProgress, event),
    onCompleted: (event) => {
      emit(EVENTS.scanCompleted, event);
      if (!event.cancelled && !event.error) void metadata.bulkRefresh({
        onProgress: (progress) => emit(EVENTS.metadataBulkProgress, progress),
      }).catch((error: unknown) => logger.warn('metadata.autoRefreshFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    },
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
    shuttingDown: false,
  };

  const deps: IpcDeps = {
    paths,
    db,
    logger,
    settings,
    prodKeys,
    catalog,
    scanner,
    metadata,
    install,
    files,
    mtp,
    httpServer,
    appUpdate,
    currentVersion: app.getVersion(),
    emit,
  };
  registerIpc(deps);

  const preloadPath = join(__dirname, '..', 'preload', 'index.js');
  mainWindow = createMainWindow({ preloadPath, iconPath: resolveIconPath() });
  mainWindow.on('close', (event) => {
    shutdownCoordinator.request(event);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Startup work described in the spec: MTP status, HTTP server, versions, scan.
  install.recoverInterrupted();
  mtp.start();
  const currentSettings = settings.getFull();
  void httpServer.applySettings().catch((error: unknown) => {
    logger.warn('http.startupFailed', { error: error instanceof Error ? error.message : String(error) });
  });
  void versions.load().then(
    () => emit(EVENTS.versionsChanged, undefined),
    (error: unknown) => logger.warn('versions.loadFailed', { error: error instanceof Error ? error.message : String(error) }),
  );
  void versions.dlcIndex.refresh().then(
    (changed) => { if (changed) { versions.loadCached(); emit(EVENTS.versionsChanged, undefined); } },
    (error: unknown) => logger.warn('dlcIndex.refreshFailed', {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
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

async function shutdown(): Promise<void> {
  const current = state;
  if (!current || current.shuttingDown) return;
  current.shuttingDown = true;
  rejectNewIpcWork();
  try {
    current.scanner.shutdown();
    current.install.shutdown();
    await Promise.all([current.scanner.whenIdle(), current.install.whenIdle()]);
    current.mtp.stop();
    await current.httpServer.stop();
  } catch (error) {
    current.logger.error('app.shutdownFailed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    closeDatabase(current.db);
    current.logger.info('app.shutdown');
  }
}
