import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { resolveAppPaths, type AppPaths } from '@main/platform/paths';
import { readLegacyDataInfo, importLegacyData } from '@main/settings/legacy-import';
import { SwitchCatalogError } from '@shared/errors/app-error';
import { defaultAppSettings } from '@shared/schemas/settings';

import { TEMP_ROOT } from '../../setup/vitest.setup';

/** DDL copied from `switch_catalog/db.py` (Qt-era schema). */
const GAMES_DDL = `
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_title TEXT NOT NULL,
    cleaned_title TEXT NOT NULL UNIQUE,
    metadata_provider TEXT,
    metadata_provider_id TEXT,
    description TEXT,
    release_date TEXT,
    developer TEXT,
    publisher TEXT,
    genres TEXT,
    cover_image_path TEXT,
    cover_image_url TEXT,
    trailer_url TEXT,
    date_added TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_scanned TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_locked INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0
  );
`;

const UPDATES_DDL = `
  CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
    file_path TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    detected_version TEXT,
    file_size INTEGER NOT NULL,
    modified_time REAL NOT NULL,
    match_confidence REAL NOT NULL DEFAULT 0,
    manual_match INTEGER NOT NULL DEFAULT 0
  );
`;

interface Case {
  legacyDir: string;
  paths: AppPaths;
}

function makeCase(): Case {
  const root = mkdtempSync(join(TEMP_ROOT, 'case-'));
  const legacyDir = join(root, 'legacy');
  mkdirSync(legacyDir, { recursive: true });
  return { legacyDir, paths: resolveAppPaths(join(root, 'userData')) };
}

function createLegacyDatabase(
  legacyDir: string,
  rows: { games: Array<{ title: string; favorite?: boolean }>; updates: string[] },
): string {
  const file = join(legacyDir, 'library.sqlite3');
  const db = new Database(file);
  try {
    db.exec(GAMES_DDL);
    db.exec(UPDATES_DDL);
    const insertGame = db.prepare('INSERT INTO games (display_title, cleaned_title, favorite) VALUES (?, ?, ?)');
    for (const game of rows.games) {
      insertGame.run(game.title, game.title.toLowerCase(), game.favorite ? 1 : 0);
    }
    const insertUpdate = db.prepare(
      'INSERT INTO updates (file_path, file_name, file_size, modified_time, detected_version) VALUES (?, ?, 1, 1.0, NULL)',
    );
    for (const name of rows.updates) insertUpdate.run(`/updates/${name}`, name);
  } finally {
    db.close();
  }
  return file;
}

describe('readLegacyDataInfo', () => {
  it('reports nothing found when the legacy directory is missing', () => {
    const { legacyDir } = makeCase();
    const missingDir = join(legacyDir, 'does-not-exist');

    const info = readLegacyDataInfo(missingDir);

    expect(info).toEqual({
      found: false,
      sourceDirectory: missingDir,
      databasePresent: false,
      settingsPresent: false,
      games: 0,
      updates: 0,
      favorites: 0,
      error: null,
    });
  });

  it('reports a missing database as an error instead of throwing', () => {
    const { legacyDir } = makeCase();
    writeFileSync(join(legacyDir, 'settings.json'), '{}', 'utf8');

    const info = readLegacyDataInfo(legacyDir);

    expect(info.found).toBe(true);
    expect(info.databasePresent).toBe(false);
    expect(info.settingsPresent).toBe(true);
    expect(info.games).toBe(0);
    expect(info.error).toEqual(expect.any(String));
  });

  it('counts games, updates and favorites from the Qt database', () => {
    const { legacyDir } = makeCase();
    createLegacyDatabase(legacyDir, {
      games: [{ title: 'Alpha', favorite: true }, { title: 'Beta' }],
      updates: ['Alpha [v65536].nsp', 'Beta [v131072].nsp', 'Orphan [v0].nsp'],
    });

    const info = readLegacyDataInfo(legacyDir);

    expect(info.found).toBe(true);
    expect(info.databasePresent).toBe(true);
    expect(info.settingsPresent).toBe(false);
    expect(info.games).toBe(2);
    expect(info.updates).toBe(3);
    expect(info.favorites).toBe(1);
    expect(info.error).toBeNull();
  });

  it('survives a database with missing tables and a file that is not SQLite', () => {
    const { legacyDir } = makeCase();
    const partial = new Database(join(legacyDir, 'library.sqlite3'));
    partial.exec(GAMES_DDL);
    partial.exec("INSERT INTO games (display_title, cleaned_title) VALUES ('Alpha', 'alpha')");
    partial.close();

    const partialInfo = readLegacyDataInfo(legacyDir);
    expect(partialInfo.games).toBe(1);
    expect(partialInfo.updates).toBe(0);
    expect(partialInfo.error).toEqual(expect.any(String));

    const { legacyDir: brokenDir } = makeCase();
    writeFileSync(join(brokenDir, 'library.sqlite3'), 'not a database', 'utf8');
    const brokenInfo = readLegacyDataInfo(brokenDir);
    expect(brokenInfo.databasePresent).toBe(true);
    expect(brokenInfo.games).toBe(0);
    expect(brokenInfo.error).toEqual(expect.any(String));
  });
});

describe('importLegacyData', () => {
  it('copies the catalog without touching the legacy directory', () => {
    const { legacyDir, paths } = makeCase();
    const sourceDatabase = createLegacyDatabase(legacyDir, {
      games: [{ title: 'Alpha', favorite: true }, { title: 'Beta' }],
      updates: ['Alpha [v65536].nsp'],
    });
    writeFileSync(join(legacyDir, 'versions.json'), '{"Alpha": 65536}', 'utf8');
    writeFileSync(join(legacyDir, 'versions.txt'), 'Alpha\t65536\n', 'utf8');
    mkdirSync(join(legacyDir, 'images', 'nested'), { recursive: true });
    writeFileSync(join(legacyDir, 'images', 'cover-a.png'), 'cover-a', 'utf8');
    writeFileSync(join(legacyDir, 'images', 'nested', 'cover-b.png'), 'cover-b', 'utf8');

    const result = importLegacyData({ legacyDir, paths, settings: defaultAppSettings() });

    expect(result.imported).toEqual({ database: true, settings: false, imageCacheFiles: 2 });
    expect(readFileSync(paths.databaseFile, 'utf8')).toBe(readFileSync(sourceDatabase, 'utf8'));
    expect(readFileSync(paths.versionsJsonFile, 'utf8')).toBe('{"Alpha": 65536}');
    expect(readFileSync(paths.versionsTxtFile, 'utf8')).toBe('Alpha\t65536\n');
    expect(readFileSync(join(paths.coversCacheDir, 'cover-a.png'), 'utf8')).toBe('cover-a');
    expect(readFileSync(join(paths.coversCacheDir, 'nested', 'cover-b.png'), 'utf8')).toBe('cover-b');

    // The Qt installation stays intact: every file was copied, none moved.
    expect(readdirSync(legacyDir).sort()).toEqual([
      'images',
      'library.sqlite3',
      'versions.json',
      'versions.txt',
    ]);
    expect(existsSync(join(legacyDir, 'images', 'cover-a.png'))).toBe(true);
  });

  it('copies legacy settings onto the new keys and ignores unknown ones', () => {
    const { legacyDir, paths } = makeCase();
    writeFileSync(
      join(legacyDir, 'settings.json'),
      JSON.stringify({
        base_games_folder: '/legacy/games',
        updates_folder: '/legacy/updates',
        scan_recursively: false,
        fuzzy_match_threshold: 0.5,
        auto_rescan_on_startup: true,
        auto_check_updates_on_startup: false,
        cache_images: false,
        metadata_provider: 'igdb',
        igdb_client_id: 'legacy-client',
        igdb_client_secret: 'legacy-secret',
        http_server_enabled: true,
        http_server_port: 8081,
        http_server_username: 'legacy-user',
        http_server_password: 'legacy-password',
        install_folder: 'D:/games',
        install_folder_label: 'SD Card',
        install_destination: 'sd',
        unknown_key: 'ignored',
      }),
      'utf8',
    );

    const result = importLegacyData({
      legacyDir,
      paths,
      settings: { ...defaultAppSettings(), httpServerPort: 9000, defaultInstallDestination: 'folder' },
    });

    expect(result.imported.settings).toBe(true);
    expect(result.settings).toEqual({
      ...defaultAppSettings(),
      baseGamesFolder: '/legacy/games',
      updatesFolder: '/legacy/updates',
      scanRecursively: false,
      fuzzyMatchThreshold: 0.5,
      autoRescanOnStartup: true,
      autoCheckUpdatesOnStartup: false,
      cacheImages: false,
      metadataProvider: 'igdb',
      igdbClientId: 'legacy-client',
      // Plaintext from the Qt file; the store encrypts these when persisted.
      igdbClientSecret: 'legacy-secret',
      httpServerEnabled: true,
      httpServerPort: 8081,
      httpServerUsername: 'legacy-user',
      httpServerPassword: 'legacy-password',
      defaultInstallDestination: 'mtp-sd',
      defaultInstallFolder: 'D:/games',
      installFolderLabel: 'SD Card',
    });
    expect(result.settings).not.toHaveProperty('unknown_key');
  });

  it('keeps the current value when a legacy value is unusable', () => {
    const { legacyDir, paths } = makeCase();
    writeFileSync(
      join(legacyDir, 'settings.json'),
      JSON.stringify({
        http_server_port: 999999,
        fuzzy_match_threshold: 'high',
        install_destination: 'sideways',
        scan_recursively: 'yes',
        base_games_folder: '/legacy/games',
      }),
      'utf8',
    );

    const result = importLegacyData({ legacyDir, paths, settings: defaultAppSettings() });

    expect(result.settings.httpServerPort).toBe(defaultAppSettings().httpServerPort);
    expect(result.settings.fuzzyMatchThreshold).toBe(defaultAppSettings().fuzzyMatchThreshold);
    expect(result.settings.defaultInstallDestination).toBe('folder');
    expect(result.settings.scanRecursively).toBe(true);
    expect(result.settings.baseGamesFolder).toBe('/legacy/games');
  });

  it('leaves existing destination files in place', () => {
    const { legacyDir, paths } = makeCase();
    createLegacyDatabase(legacyDir, { games: [{ title: 'Alpha' }], updates: [] });
    mkdirSync(paths.coversCacheDir, { recursive: true });
    mkdirSync(join(legacyDir, 'images'), { recursive: true });
    mkdirSync(dirname(paths.versionsJsonFile), { recursive: true });
    writeFileSync(paths.databaseFile, 'existing-database', 'utf8');
    writeFileSync(join(paths.coversCacheDir, 'cover-a.png'), 'existing-cover', 'utf8');
    writeFileSync(join(legacyDir, 'images', 'cover-a.png'), 'legacy-cover', 'utf8');
    writeFileSync(join(legacyDir, 'images', 'cover-b.png'), 'legacy-cover-b', 'utf8');
    writeFileSync(join(legacyDir, 'versions.json'), '{"Alpha": 1}', 'utf8');
    writeFileSync(paths.versionsJsonFile, '{"Beta": 2}', 'utf8');

    const result = importLegacyData({ legacyDir, paths, settings: defaultAppSettings() });

    expect(result.imported).toEqual({ database: false, settings: false, imageCacheFiles: 1 });
    expect(readFileSync(paths.databaseFile, 'utf8')).toBe('existing-database');
    expect(readFileSync(join(paths.coversCacheDir, 'cover-a.png'), 'utf8')).toBe('existing-cover');
    expect(readFileSync(join(paths.coversCacheDir, 'cover-b.png'), 'utf8')).toBe('legacy-cover-b');
    expect(readFileSync(paths.versionsJsonFile, 'utf8')).toBe('{"Beta": 2}');
  });

  it('imports settings even when the image cache cannot be read', () => {
    const { legacyDir, paths } = makeCase();
    writeFileSync(join(legacyDir, 'images'), 'a file, not a directory', 'utf8');
    writeFileSync(join(legacyDir, 'settings.json'), JSON.stringify({ base_games_folder: '/legacy' }), 'utf8');

    const result = importLegacyData({ legacyDir, paths, settings: defaultAppSettings() });

    expect(result.imported).toEqual({ database: false, settings: true, imageCacheFiles: 0 });
    expect(result.settings.baseGamesFolder).toBe('/legacy');
  });

  it('fails with DATABASE_ERROR when the catalog cannot be copied', () => {
    const { legacyDir, paths } = makeCase();
    createLegacyDatabase(legacyDir, { games: [{ title: 'Alpha' }], updates: [] });
    const blocker = join(paths.userDataDir, 'blocker');
    mkdirSync(paths.userDataDir, { recursive: true });
    writeFileSync(blocker, 'not a directory', 'utf8');

    let thrown: unknown;
    try {
      importLegacyData({
        legacyDir,
        paths: { ...paths, databaseFile: join(blocker, 'library.sqlite3') },
        settings: defaultAppSettings(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SwitchCatalogError);
    expect((thrown as SwitchCatalogError).code).toBe('DATABASE_ERROR');
  });
});
