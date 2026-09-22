import { mkdtempSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '@main/db/database';
import { MIGRATIONS, appliedVersions, runMigrations } from '@main/db/migrations';
import { TEMP_ROOT } from '../../setup/vitest.setup';

function freshDatabasePath(): string {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  return join(dir, 'library.sqlite3');
}

describe('database migrations', () => {
  it('creates the complete Electron schema exactly once', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      const first = runMigrations(db, file);
      expect(first.applied).toEqual([1]);
      expect(first.backupFile).toBeNull();
      expect(runMigrations(db, file).applied).toEqual([]);
      expect(appliedVersions(db)).toEqual([1]);
      expect(MIGRATIONS[0].name).toBe('initial-schema');

      const jobColumns = db.prepare('PRAGMA table_info(install_jobs)').all() as Array<{ name: string }>;
      expect(jobColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['destination_type', 'transferred_bytes']),
      );
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
        'idx_install_jobs_status',
      ]) {
        expect(names).toContain(index);
      }
    } finally {
      closeDatabase(db);
    }
  });

  it('backs up before an upgrade and rolls back a failing migration', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      runMigrations(db, file);
      expect(() =>
        runMigrations(db, file, [
          ...MIGRATIONS,
          {
            version: 2,
            name: 'failing-migration',
            up: (database) => {
              database.exec('CREATE TABLE should_rollback(id INTEGER)');
              throw new Error('migration exploded');
            },
          },
        ]),
      ).toThrow('migration exploded');

      expect(appliedVersions(db)).not.toContain(2);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'").get()).toBeUndefined();
      expect(readdirSync(dirname(file)).filter((name) => name.includes('.pre-migration-'))).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });
});
