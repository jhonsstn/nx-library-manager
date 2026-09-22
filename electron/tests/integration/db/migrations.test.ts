import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '@main/db/database';
import { MIGRATIONS, appliedVersions, runMigrations } from '@main/db/migrations';
import { TEMP_ROOT } from '../../setup/vitest.setup';

const LEGACY_SCHEMA = readFileSync(join(__dirname, '../../fixtures/legacy/legacy-schema.sql'), 'utf8');

function freshDatabasePath(): string {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  return join(dir, 'library.sqlite3');
}

/** Builds a database with the exact Qt-era schema plus representative rows. */
function createLegacyDatabase(file: string): void {
  const db = openDatabase(file);
  try {
    db.exec(LEGACY_SCHEMA);
    db.prepare(
      `INSERT INTO games(id, display_title, cleaned_title, description, genres, favorite, metadata_locked, needs_review)
       VALUES (1, 'Hades', 'Hades', 'A rogue-like', '["Action"]', 1, 1, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO game_files(id, game_id, file_path, file_name, file_extension, file_size, modified_time, file_type, is_base_game)
       VALUES (10, 1, 'C:/games/Hades.nsp', 'Hades.nsp', '.nsp', 1024, 1.5, 'NSP', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO updates(id, game_id, file_path, file_name, detected_version, file_size, modified_time, match_confidence, manual_match)
       VALUES (20, 1, 'C:/updates/Hades [v131072].nsp', 'Hades [v131072].nsp', '131072', 2048, 2.5, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO screenshots(id, game_id, image_url, local_path, sort_order)
       VALUES (30, 1, 'https://images.igdb.com/a.jpg', NULL, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO metadata_cache(id, provider, query, response_json) VALUES (40, 'igdb', 'token:abc', '{"access_token":"t"}')`,
    ).run();
    const insertJob = db.prepare(
      `INSERT INTO install_jobs(id, game_id, source_path, destination_folder, file_name, file_size, file_kind, status)
       VALUES (?, 1, ?, 'D:/install', ?, 1, 'base', ?)`,
    );
    insertJob.run(50, 'C:/games/Hades.nsp', 'Hades.nsp', 'copying');
    insertJob.run(51, 'C:/games/Hades.nsp', 'Hades.nsp', 'finished');
    insertJob.run(52, 'C:/games/Hades.nsp', 'Hades.nsp', 'sent');
    insertJob.run(53, 'C:/games/Hades.nsp', 'Hades.nsp', 'failed');
    db.pragma('user_version = 0');
  } finally {
    closeDatabase(db);
  }
}

describe('database migrations', () => {
  it('applies every migration to a fresh database exactly once', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      const first = runMigrations(db, file);
      expect(first.applied).toEqual(MIGRATIONS.map((migration) => migration.version));

      const second = runMigrations(db, file);
      expect(second.applied).toEqual([]);
      expect(appliedVersions(db)).toEqual(MIGRATIONS.map((migration) => migration.version));
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades a Qt-era database without losing library state', () => {
    const file = freshDatabasePath();
    createLegacyDatabase(file);

    const db = openDatabase(file);
    try {
      runMigrations(db, file);

      const game = db.prepare('SELECT * FROM games WHERE id = 1').get() as Record<string, unknown>;
      expect(game.display_title).toBe('Hades');
      expect(game.description).toBe('A rogue-like');
      expect(game.favorite).toBe(1);
      expect(game.metadata_locked).toBe(1);

      const update = db.prepare('SELECT * FROM updates WHERE id = 20').get() as Record<string, unknown>;
      expect(update.game_id).toBe(1);
      expect(update.manual_match).toBe(1);
      expect(update.detected_version).toBe('131072');

      expect(db.prepare('SELECT COUNT(*) AS total FROM screenshots').get()).toEqual({ total: 1 });
      expect(db.prepare('SELECT COUNT(*) AS total FROM metadata_cache').get()).toEqual({ total: 1 });

      // Electron-only columns exist after the upgrade.
      const job = db.prepare('SELECT * FROM install_jobs WHERE id = 50').get() as Record<string, unknown>;
      expect(job.destination_type).toBeNull();
      expect(job.transferred_bytes).toBe(0);

      // The outcome/verdict columns become the DTO vocabulary, so the same row
      // reads the same in both applications.
      const statuses = db
        .prepare('SELECT id, status FROM install_jobs ORDER BY id')
        .all() as Array<{ id: number; status: string }>;
      expect(statuses).toEqual([
        { id: 50, status: 'running' },
        { id: 51, status: 'completed' },
        { id: 52, status: 'completed' },
        { id: 53, status: 'failed' },
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('creates the documented indexes', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      runMigrations(db, file);
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const index of [
        'idx_game_files_game_id',
        'idx_updates_game_id',
        'idx_updates_manual_match',
        'idx_games_favorite',
        'idx_games_needs_review',
        'idx_games_display_title',
      ]) {
        expect(names).toContain(index);
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('backs the database up before changing it and rolls back a failing migration', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      runMigrations(db, file);

      expect(() =>
        runMigrations(db, file, [
          ...MIGRATIONS,
          {
            version: 99,
            name: 'failing-migration',
            up: () => {
              throw new Error('migration exploded');
            },
          },
        ]),
      ).toThrow('migration exploded');

      // The failed version is not recorded, so the next launch retries it.
      expect(appliedVersions(db)).not.toContain(99);
      // A backup was taken before the attempt.
      const backups = readdirSync(dirname(file)).filter((name) => name.includes('.pre-electron-'));
      expect(backups).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('never mutates the original Qt database during a copy-based import', () => {
    const legacyFile = freshDatabasePath();
    createLegacyDatabase(legacyFile);
    const legacyBytes = readFileSync(legacyFile);

    const importPath = join(dirname(legacyFile), 'imported.sqlite3');
    copyFileSync(legacyFile, importPath);
    const db = openDatabase(importPath);
    try {
      runMigrations(db, importPath);
    } finally {
      closeDatabase(db);
    }

    expect(existsSync(importPath)).toBe(true);
    expect(readFileSync(legacyFile)).toEqual(legacyBytes);
  });
});
