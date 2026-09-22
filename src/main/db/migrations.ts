import { copyFileSync, existsSync } from 'node:fs';
import type { AppDatabase } from './database';
import { backupFileName } from '../platform/paths';

export interface Migration {
  version: number;
  name: string;
  up: (db: AppDatabase) => void;
}

/**
 * Migration 1 recreates the Qt-era schema verbatim so a database created by
 * either application is byte-compatible in shape. Later migrations only extend.
 */
const legacyBaseline: Migration = {
  version: 1,
  name: 'legacy-baseline',
  up: (db) => {
    db.exec(`
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

      CREATE TABLE IF NOT EXISTS game_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          file_extension TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          modified_time REAL NOT NULL,
          file_type TEXT NOT NULL,
          is_base_game INTEGER NOT NULL
      );

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

      CREATE TABLE IF NOT EXISTS install_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
          source_path TEXT NOT NULL,
          destination_path TEXT,
          destination_folder TEXT NOT NULL,
          destination_label TEXT,
          file_name TEXT NOT NULL,
          file_size INTEGER NOT NULL DEFAULT 0,
          file_kind TEXT NOT NULL,
          detected_version TEXT,
          raw_version INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS screenshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          image_url TEXT NOT NULL,
          local_path TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          UNIQUE(game_id, image_url)
      );

      CREATE TABLE IF NOT EXISTS metadata_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          query TEXT NOT NULL,
          response_json TEXT NOT NULL,
          cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(provider, query)
      );
    `);
    ensureColumn(db, 'updates', 'manual_match', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'games', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'games', 'trailer_url', 'TEXT');
  },
};

/**
 * Migration 2 adds Electron-only columns and indexes, and normalizes the Qt
 * install-job statuses onto the DTO vocabulary (`running`/`completed`).
 */
const electronIndexes: Migration = {
  version: 2,
  name: 'electron-indexes-and-install-status',
  up: (db) => {
    ensureColumn(db, 'install_jobs', 'destination_type', 'TEXT');
    ensureColumn(db, 'install_jobs', 'transferred_bytes', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE install_jobs SET status = CASE status
        WHEN 'copying' THEN 'running'
        WHEN 'finished' THEN 'completed'
        WHEN 'sent' THEN 'completed'
        ELSE status
      END;

      CREATE INDEX IF NOT EXISTS idx_game_files_game_id ON game_files(game_id);
      CREATE INDEX IF NOT EXISTS idx_game_files_base ON game_files(is_base_game);
      CREATE INDEX IF NOT EXISTS idx_updates_game_id ON updates(game_id);
      CREATE INDEX IF NOT EXISTS idx_updates_manual_match ON updates(manual_match);
      CREATE INDEX IF NOT EXISTS idx_games_favorite ON games(favorite);
      CREATE INDEX IF NOT EXISTS idx_games_needs_review ON games(needs_review);
      CREATE INDEX IF NOT EXISTS idx_games_display_title ON games(display_title COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_screenshots_game_id ON screenshots(game_id);
      CREATE INDEX IF NOT EXISTS idx_install_jobs_game_id ON install_jobs(game_id);
      CREATE INDEX IF NOT EXISTS idx_install_jobs_status ON install_jobs(status);
    `);
  },
};

export const MIGRATIONS: Migration[] = [legacyBaseline, electronIndexes];

function ensureColumn(db: AppDatabase, table: string, column: string, definition: string): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function appliedVersions(db: AppDatabase): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
  }>;
  return rows.map((row) => row.version);
}

export interface MigrationResult {
  applied: number[];
  backupFile: string | null;
}

/**
 * Applies pending migrations in numeric order, each inside its own transaction.
 * A backup copy is taken first when there is something to change.
 */
export function runMigrations(
  db: AppDatabase,
  databaseFile: string,
  migrations: Migration[] = MIGRATIONS,
): MigrationResult {
  const done = new Set(appliedVersions(db));
  const pending = migrations.filter((migration) => !done.has(migration.version)).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { applied: [], backupFile: null };

  const backupFile = createBackup(databaseFile);
  const applied: number[] = [];
  const record = db.prepare('INSERT INTO schema_migrations(version, name) VALUES (?, ?)');
  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name);
    });
    apply();
    applied.push(migration.version);
  }
  return { applied, backupFile };
}

/** Copies the database beside itself before a high-risk migration. */
export function createBackup(databaseFile: string, now = new Date()): string | null {
  if (!existsSync(databaseFile)) return null;
  const target = backupFileName(databaseFile, now);
  copyFileSync(databaseFile, target);
  return target;
}
