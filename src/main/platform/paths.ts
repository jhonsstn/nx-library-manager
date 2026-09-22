import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * User-data layout owned by the Electron app.
 *
 * Mirrors `migration-spec/data/11-settings-and-user-data.md`. The Electron
 * build takes `userDataDir` from `app.getPath('userData')`; keeping the
 * resolution pure means path handling stays testable without Electron.
 */
export interface AppPaths {
  userDataDir: string;
  databaseFile: string;
  settingsFile: string;
  logsDir: string;
  cacheDir: string;
  coversCacheDir: string;
  screenshotsCacheDir: string;
  versionsCacheDir: string;
  versionsJsonFile: string;
  versionsTxtFile: string;
  serverLogFile: string;
}

/** Qt-era application directory (`~/.switch_library_catalog`). Never mutated. */
export function legacyAppDir(home = homedir()): string {
  return join(home, '.switch_library_catalog');
}

export function resolveAppPaths(userDataDir: string): AppPaths {
  const root = resolve(userDataDir);
  const cacheDir = join(root, 'cache');
  return {
    userDataDir: root,
    databaseFile: join(root, 'library.sqlite3'),
    settingsFile: join(root, 'settings.json'),
    logsDir: join(root, 'logs'),
    cacheDir,
    coversCacheDir: join(cacheDir, 'covers'),
    screenshotsCacheDir: join(cacheDir, 'screenshots'),
    versionsCacheDir: join(cacheDir, 'versions'),
    versionsJsonFile: join(cacheDir, 'versions', 'versions.json'),
    versionsTxtFile: join(cacheDir, 'versions', 'versions.txt'),
    serverLogFile: join(root, 'logs', 'server.log'),
  };
}

export function ensureAppPaths(paths: AppPaths): void {
  for (const dir of [
    paths.userDataDir,
    paths.logsDir,
    paths.coversCacheDir,
    paths.screenshotsCacheDir,
    paths.versionsCacheDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Timestamped backup name used before destructive migrations. */
export function backupFileName(databaseFile: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${databaseFile}.pre-electron-${stamp}.bak`;
}
