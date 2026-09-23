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
      expect(first.applied).toEqual([1, 2, 3]);
      expect(first.backupFile).toBeNull();
      expect(runMigrations(db, file).applied).toEqual([]);
      expect(appliedVersions(db)).toEqual([1, 2, 3]);
      expect(MIGRATIONS[0].name).toBe('initial-schema');

      const jobColumns = db.prepare('PRAGMA table_info(install_jobs)').all() as Array<{ name: string }>;
      expect(jobColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['destination_type', 'transferred_bytes']),
      );
      for (const table of ['titles', 'local_files', 'file_titles']) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeDefined();
      }
      const gameColumns = db.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>;
      expect(gameColumns.map((column) => column.name)).toContain('hidden');
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
        'idx_games_hidden',
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
            version: 4,
            name: 'failing-migration',
            up: (database) => {
              database.exec('CREATE TABLE should_rollback(id INTEGER)');
              throw new Error('migration exploded');
            },
          },
        ]),
      ).toThrow('migration exploded');

      expect(appliedVersions(db)).not.toContain(4);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_rollback'").get()).toBeUndefined();
      expect(readdirSync(dirname(file)).filter((name) => name.includes('.pre-migration-'))).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('migrates an existing library without changing game IDs or user state', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      runMigrations(db,file,[MIGRATIONS[0]]);
      db.prepare(`INSERT INTO games(id,display_title,cleaned_title,favorite,metadata_locked)
        VALUES (41,'Example','Example',1,1)`).run();
      db.prepare(`INSERT INTO game_files(game_id,file_path,file_name,file_extension,file_size,modified_time,
        file_type,is_base_game) VALUES (41,'/library/example.nsp','example.nsp','.nsp',10,123,'NSP',1)`).run();
      db.prepare(`INSERT INTO updates(game_id,file_path,file_name,detected_version,file_size,modified_time,
        manual_match) VALUES (41,'/library/example-dlc.nsp','example-dlc.nsp','65536',5,124,1)`).run();
      db.prepare(`INSERT INTO screenshots(game_id,image_url) VALUES (41,'https://example.test/shot')`).run();
      db.prepare(`INSERT INTO install_jobs(game_id,source_path,destination_folder,destination_type,file_name,
        file_kind,status) VALUES (41,'/library/example.nsp','/dest','folder','example.nsp','base','completed')`).run();
      expect(runMigrations(db,file).applied).toEqual([2, 3]);
      expect(db.prepare('SELECT id,favorite,metadata_locked FROM games WHERE id=41').get())
        .toMatchObject({ id:41,favorite:1,metadata_locked:1 });
      expect(db.prepare('SELECT count(*) AS n FROM local_files').get()).toMatchObject({ n:2 });
      expect(db.prepare("SELECT count(*) AS n FROM titles WHERE game_id=41").get()).toMatchObject({ n:2 });
      expect(db.prepare('SELECT count(*) AS n FROM screenshots WHERE game_id=41').get()).toMatchObject({ n:1 });
      expect(db.prepare('SELECT count(*) AS n FROM install_jobs WHERE game_id=41').get()).toMatchObject({ n:1 });
      expect(db.prepare('SELECT manual_match FROM updates WHERE game_id=41').get()).toMatchObject({ manual_match:1 });
      expect(db.prepare('SELECT hidden FROM games WHERE id=41').get()).toMatchObject({ hidden:0 });
    } finally { closeDatabase(db); }
  });

  it('adds visibility to an existing title catalog without changing its game rows', () => {
    const file = freshDatabasePath();
    const db = openDatabase(file);
    try {
      runMigrations(db, file, MIGRATIONS.slice(0, 2));
      db.prepare("INSERT INTO games(id,display_title,cleaned_title,favorite) VALUES (73,'Existing','existing',1)").run();
      expect(runMigrations(db, file).applied).toEqual([3]);
      expect(db.prepare('SELECT id,favorite,hidden FROM games WHERE id=73').get())
        .toMatchObject({ id: 73, favorite: 1, hidden: 0 });
      expect(readdirSync(dirname(file)).some((name) => name.includes('.pre-migration-'))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });
});
