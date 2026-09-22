import { app, BrowserWindow, shell } from 'electron';
import { APP_ORIGIN } from './protocols';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:']);

export interface MainWindowOptions {
  preloadPath: string;
  /** Absolute path to the application icon (dev tree or packaged resources). */
  iconPath: string;
}

/**
 * BrowserWindow hardening from spec 04: context isolation on, Node off, sandbox
 * on, plus navigation and window-open restrictions.
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    show: false,
    autoHideMenuBar: true,
    title: 'Switch Game Catalog',
    icon: options.iconPath,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Never let the renderer navigate away from the bundled application.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith(APP_ORIGIN);
    if (!allowed) {
      event.preventDefault();
      void openExternalUrl(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  void window.loadURL(DEV_SERVER_URL ? DEV_SERVER_URL : `${APP_ORIGIN}/index.html`);

  return window;
}

/** Routed through `shell.openExternal` after protocol validation (spec 04). */
export async function openExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return;
  await shell.openExternal(parsed.toString());
}

export interface RecoveryDetails {
  databaseFile: string;
  message: string;
  backupFile: string | null;
}

/**
 * Migration failure must not continue against a half-upgraded database (spec 10),
 * so startup is replaced by a static recovery page when this happens.
 */
export function createRecoveryWindow(details: RecoveryDetails): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 480,
    backgroundColor: '#1a1a1a',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const query = new URLSearchParams({
    databaseFile: details.databaseFile,
    message: details.message,
    backupFile: details.backupFile ?? '',
    logDir: app.getPath('logs'),
    version: app.getVersion(),
  });
  const base = DEV_SERVER_URL ?? APP_ORIGIN;
  void window.loadURL(`${base}/recovery.html?${query.toString()}`);
  return window;
}
