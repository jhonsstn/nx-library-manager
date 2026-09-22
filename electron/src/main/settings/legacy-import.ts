import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import { appError } from '../../shared/errors/app-error';
import { defaultAppSettings } from '../../shared/schemas/settings';
import type { LegacyDataInfoDto } from '../../shared/types/domain';
import type { AppSettings } from '../../shared/types/settings';
import type { AppPaths } from '../platform/paths';

/** Qt `settings.json` (snake_case) -> Electron settings keys. */
export const LEGACY_KEYS = {
  base_games_folder: 'baseGamesFolder',
  updates_folder: 'updatesFolder',
  scan_recursively: 'scanRecursively',
  fuzzy_match_threshold: 'fuzzyMatchThreshold',
  auto_rescan_on_startup: 'autoRescanOnStartup',
  auto_check_updates_on_startup: 'autoCheckUpdatesOnStartup',
  cache_images: 'cacheImages',
  metadata_provider: 'metadataProvider',
  igdb_client_id: 'igdbClientId',
  http_server_enabled: 'httpServerEnabled',
  http_server_port: 'httpServerPort',
  http_server_username: 'httpServerUsername',
  install_folder: 'defaultInstallFolder',
  install_folder_label: 'installFolderLabel',
  install_destination: 'defaultInstallDestination',
} as const;

type LegacySettingKey = (typeof LEGACY_KEYS)[keyof typeof LEGACY_KEYS];

const LEGACY_INSTALL_DESTINATIONS: Record<string, AppSettings['defaultInstallDestination']> = {
  local: 'folder',
  sd: 'mtp-sd',
  nand: 'mtp-nand',
};

/**
 * The Qt build stored these as plaintext. They are mapped into the imported
 * settings unchanged; the store encrypts them when the import is persisted.
 */
const LEGACY_SECRET_KEYS: Record<string, 'igdbClientSecret' | 'httpServerPassword'> = {
  igdb_client_secret: 'igdbClientSecret',
  http_server_password: 'httpServerPassword',
};

const LEGACY_DATABASE_FILE = 'library.sqlite3';
const LEGACY_SETTINGS_FILE = 'settings.json';
const LEGACY_IMAGES_DIR = 'images';
const LEGACY_VERSION_FILES = ['versions.json', 'versions.txt'];

interface LegacyImportOptions {
  legacyDir: string;
  paths: AppPaths;
  settings: AppSettings;
}

interface LegacyImportResult {
  settings: AppSettings;
  imported: { database: boolean; settings: boolean; imageCacheFiles: number };
}

/** Reports what a legacy Qt installation contains; never throws. */
export function readLegacyDataInfo(legacyDir: string): LegacyDataInfoDto {
  const info: LegacyDataInfoDto = {
    found: existsSync(legacyDir),
    sourceDirectory: legacyDir,
    databasePresent: false,
    settingsPresent: false,
    games: 0,
    updates: 0,
    favorites: 0,
    error: null,
  };
  if (!info.found) return info;

  const databaseFile = join(legacyDir, LEGACY_DATABASE_FILE);
  info.databasePresent = existsSync(databaseFile);
  info.settingsPresent = existsSync(join(legacyDir, LEGACY_SETTINGS_FILE));
  if (!info.databasePresent) {
    info.error = 'The legacy catalog database was not found.';
    return info;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(databaseFile, { readonly: true });
    const problems: string[] = [];
    const games = countRows(db, 'games', '', problems, 'games');
    const updates = countRows(db, 'updates', '', problems, 'updates');
    const favorites = countRows(db, 'games', ' WHERE favorite = 1', problems, 'favorites');
    info.games = games;
    info.updates = updates;
    info.favorites = favorites;
    info.error = problems.length > 0 ? problems.join(' ') : null;
  } catch (error) {
    info.error = describeFailure(error);
  } finally {
    try {
      db?.close();
    } catch {
      /* the connection is already gone */
    }
  }
  return info;
}

/**
 * Copies the legacy catalog into the Electron user-data directory. The legacy
 * directory is only ever read: every file is copied, and an existing
 * destination is left untouched.
 */
export function importLegacyData(options: LegacyImportOptions): LegacyImportResult {
  const { legacyDir, paths, settings } = options;
  const imported: LegacyImportResult['imported'] = {
    database: false,
    settings: false,
    imageCacheFiles: 0,
  };

  const merged: AppSettings = { ...defaultAppSettings(), ...settings };
  const legacySettings = readLegacySettings(join(legacyDir, LEGACY_SETTINGS_FILE));
  if (legacySettings) {
    applyLegacySettings(merged, legacySettings);
    imported.settings = true;
  }

  const sourceDatabase = join(legacyDir, LEGACY_DATABASE_FILE);
  if (existsSync(sourceDatabase) && !existsSync(paths.databaseFile)) {
    try {
      mkdirSync(dirname(paths.databaseFile), { recursive: true });
      copyFileSync(sourceDatabase, paths.databaseFile);
      imported.database = true;
    } catch (cause) {
      throw appError('DATABASE_ERROR', 'Could not copy the legacy catalog database.', {
        details: { source: sourceDatabase, destination: paths.databaseFile },
        cause,
      });
    }
  }

  for (const name of LEGACY_VERSION_FILES) {
    const destination = name === 'versions.json' ? paths.versionsJsonFile : paths.versionsTxtFile;
    copyFileIfMissing(join(legacyDir, name), destination);
  }

  imported.imageCacheFiles = copyDirectoryFiles(join(legacyDir, LEGACY_IMAGES_DIR), paths.coversCacheDir);

  return { settings: merged, imported };
}

function countRows(
  db: Database.Database,
  table: string,
  where: string,
  problems: string[],
  label: string,
): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get() as
      | { count?: unknown }
      | undefined;
    const value = Number(row?.count ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    problems.push(`The legacy database has no readable "${label}" rows.`);
    return 0;
  }
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `The legacy catalog database could not be read: ${message}`;
}

function readLegacySettings(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Legacy values win over the (default) settings, per-field and type-checked. */
function applyLegacySettings(target: AppSettings, legacy: Record<string, unknown>): void {
  for (const [legacyKey, settingKey] of Object.entries(LEGACY_KEYS)) {
    if (!Object.hasOwn(legacy, legacyKey)) continue;
    const value = legacy[legacyKey];
    if (typeof value === 'undefined') continue;
    assignSetting(target, settingKey as LegacySettingKey, value);
  }
  for (const [legacyKey, settingKey] of Object.entries(LEGACY_SECRET_KEYS)) {
    const value = legacy[legacyKey];
    if (typeof value === 'string' && value.length > 0) target[settingKey] = value;
  }
}

function assignSetting(target: AppSettings, key: LegacySettingKey, value: unknown): void {
  switch (key) {
    case 'baseGamesFolder':
    case 'updatesFolder':
    case 'igdbClientId':
    case 'httpServerUsername':
    case 'defaultInstallFolder':
    case 'installFolderLabel':
      if (typeof value === 'string') target[key] = value;
      break;
    case 'scanRecursively':
    case 'autoRescanOnStartup':
    case 'autoCheckUpdatesOnStartup':
    case 'cacheImages':
    case 'httpServerEnabled':
      if (typeof value === 'boolean') target[key] = value;
      break;
    case 'fuzzyMatchThreshold':
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
        target.fuzzyMatchThreshold = value;
      }
      break;
    case 'httpServerPort':
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
        target.httpServerPort = value;
      }
      break;
    case 'metadataProvider':
      if (value === 'igdb') target.metadataProvider = 'igdb';
      break;
    case 'defaultInstallDestination': {
      const destination = LEGACY_INSTALL_DESTINATIONS[String(value)];
      if (destination) target.defaultInstallDestination = destination;
      break;
    }
  }
}

function copyFileIfMissing(source: string, destination: string): void {
  if (!existsSync(source) || existsSync(destination)) return;
  try {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  } catch {
    // Cached title metadata can be downloaded again, so a failed copy is not fatal.
  }
}

/** Best-effort image-cache migration; returns the number of files copied. */
function copyDirectoryFiles(sourceDir: string, destinationDir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let copied = 0;
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirectoryFiles(source, destination);
      continue;
    }
    if (!entry.isFile() || existsSync(destination)) continue;
    try {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      copied += 1;
    } catch {
      // Image cache migration must never fail the import.
    }
  }
  return copied;
}
