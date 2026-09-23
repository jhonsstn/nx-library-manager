import { basename, extname } from 'node:path';
import type { AppDatabase } from '../db/database';
import { cleanTitle } from '../scanner/filename-parser';
import type { InspectedTitle } from '../scanner/package-inspector';

export interface ContainedTitle {
  titleId: string | null;
  baseTitleId: string | null;
  type: 'base' | 'update' | 'dlc';
  name: string;
  rawVersion: number | null;
  source: string;
  filePath: string;
  provisional: boolean;
  inspectionError: string | null;
}

/** Verified Title IDs are the identity key. A guessed filename never becomes one. */
export function recordInspection(db: AppDatabase, input: {
  path: string; size: number; mtime: number; parserVersion: number; keysRevision: number;
  titles: InspectedTitle[]; error: string | null;
}): void {
  const fileName = basename(input.path);
  db.prepare(`INSERT INTO local_files(file_path,file_name,file_extension,file_size,modified_time,
    inspection_version,keys_revision,inspection_error) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(file_path) DO UPDATE SET file_name=excluded.file_name,
    file_extension=excluded.file_extension,file_size=excluded.file_size,
    modified_time=excluded.modified_time,inspection_version=excluded.inspection_version,
    keys_revision=excluded.keys_revision,inspection_error=excluded.inspection_error`).run(
      input.path, fileName, extname(fileName).toLowerCase(), input.size, input.mtime,
      input.parserVersion, input.keysRevision, input.error,
    );
  const file = db.prepare('SELECT id FROM local_files WHERE file_path = ?').get(input.path) as { id: number };
  db.prepare('DELETE FROM file_titles WHERE local_file_id = ?').run(file.id);
  const legacyBase = db.prepare('SELECT game_id FROM game_files WHERE file_path = ?').get(input.path) as
    | { game_id: number } | undefined;
  const legacyUpdate = db.prepare('SELECT game_id FROM updates WHERE file_path = ?').get(input.path) as
    | { game_id: number | null } | undefined;
  const contents = input.titles.length
    ? [...input.titles].sort((a, b) => Number(b.type === 'base') - Number(a.type === 'base'))
    : [null];
  for (const detected of contents) {
    const type = detected?.type ?? (legacyUpdate ? 'update' : 'base');
    const parentRow = detected && type !== 'base' ? db.prepare(
      "SELECT game_id FROM titles WHERE title_id = ? AND type = 'base' AND game_id IS NOT NULL",
    ).get(detected.baseTitleId) as { game_id: number } | undefined : undefined;
    let gameId = type === 'base' ? legacyBase?.game_id ?? null : parentRow?.game_id ?? legacyUpdate?.game_id ?? null;
    if (detected && type === 'base') {
      const existing = db.prepare('SELECT game_id FROM titles WHERE title_id = ?').get(detected.titleId) as
        | { game_id: number | null } | undefined;
      if (existing?.game_id) gameId = existing.game_id;
      else if (gameId) {
        const assigned = db.prepare("SELECT title_id FROM titles WHERE game_id = ? AND type = 'base' AND title_id IS NOT NULL")
          .get(gameId) as { title_id: string } | undefined;
        if (assigned && assigned.title_id !== detected.titleId) gameId = null;
      }
      if (!gameId) {
        const name = detected.name || cleanTitle(fileName) || fileName;
        // The old cleaned-title key is only a compatibility key; verified IDs
        // make otherwise identical game names distinct.
        const cleaned = `${cleanTitle(name) || name} [${detected.titleId}]`;
        db.prepare(`INSERT INTO games(display_title,cleaned_title) VALUES (?,?)
          ON CONFLICT(cleaned_title) DO UPDATE SET last_scanned=CURRENT_TIMESTAMP`).run(name,cleaned);
        gameId = (db.prepare('SELECT id FROM games WHERE cleaned_title=?').get(cleaned) as { id:number }).id;
      }
      if (legacyBase && legacyBase.game_id !== gameId)
        db.prepare('UPDATE game_files SET game_id = ? WHERE file_path = ?').run(gameId, input.path);
    }
    let titleRow: { id: number; name_source: string } | undefined;
    if (detected) titleRow = db.prepare('SELECT id,name_source FROM titles WHERE title_id = ?').get(detected.titleId) as
      | { id: number; name_source: string } | undefined;
    if (!titleRow && gameId && type === 'base') titleRow = db.prepare(
      "SELECT id,name_source FROM titles WHERE game_id = ? AND type = 'base' AND title_id IS NULL LIMIT 1",
    ).get(gameId) as { id: number; name_source: string } | undefined;
    const name = detected?.name || cleanTitle(fileName) || fileName;
    let titleRowId: number;
    if (titleRow) {
      db.prepare(`UPDATE titles SET title_id=COALESCE(?,title_id), base_title_id=COALESCE(?,base_title_id),
        game_id=COALESCE(game_id,?), provisional=?,
        display_name=CASE WHEN ? IS NOT NULL AND name_source IN ('filename','migration') THEN ? ELSE display_name END,
        name_source=CASE WHEN ? IS NOT NULL AND name_source IN ('filename','migration') THEN 'nacp' ELSE name_source END,
        publisher=COALESCE(?,publisher) WHERE id=?`).run(
          detected?.titleId ?? null, detected?.baseTitleId ?? null, gameId,
          detected ? 0 : 1, detected?.name ?? null, name, detected?.name ?? null,
          detected?.publisher ?? null, titleRow.id,
        );
      titleRowId = titleRow.id;
    } else {
      const result = db.prepare(`INSERT INTO titles(game_id,title_id,base_title_id,type,display_name,
        name_source,publisher,provisional) VALUES (?,?,?,?,?,?,?,?)`).run(
          gameId, detected?.titleId ?? null, detected?.baseTitleId ?? null, type,
          name, detected?.name ? 'nacp' : 'filename', detected?.publisher ?? null,
          detected ? 0 : 1,
        );
      titleRowId = Number(result.lastInsertRowid);
    }
    db.prepare(`INSERT INTO file_titles(local_file_id,title_id,raw_version,detection_source)
      VALUES (?,?,?,?)`).run(file.id, titleRowId, detected?.rawVersion ?? null,
        detected?.source ?? 'filename');
    if (detected?.name && gameId && type === 'base') db.prepare(
      'UPDATE games SET display_title = ? WHERE id = ? AND metadata_locked = 0',
    ).run(detected.name, gameId);
  }
}

export function cachedInspection(db: AppDatabase, path: string, size: number, mtime: number,
  parserVersion: number, keysRevision: number): boolean {
  const row = db.prepare(`SELECT id FROM local_files WHERE file_path=? AND file_size=? AND modified_time=?
    AND inspection_version=? AND keys_revision=?`).get(path,size,mtime,parserVersion,keysRevision);
  return Boolean(row);
}

export function cachedHasBaseTitle(db: AppDatabase, path: string): boolean | null {
  const rows = db.prepare(`SELECT t.type FROM local_files lf JOIN file_titles ft ON ft.local_file_id=lf.id
    JOIN titles t ON t.id=ft.title_id WHERE lf.file_path=? AND t.provisional=0`).all(path) as Array<{ type: string }>;
  return rows.length ? rows.some((row) => row.type === 'base') : null;
}

export function contentsForGame(db: AppDatabase, gameId: number): ContainedTitle[] {
  const rows = db.prepare(`SELECT t.title_id, t.base_title_id, t.type, t.display_name, ft.raw_version,
    ft.detection_source, lf.file_path, lf.inspection_error, t.provisional FROM file_titles ft
    JOIN titles t ON t.id=ft.title_id JOIN local_files lf ON lf.id=ft.local_file_id
    WHERE t.game_id=? ORDER BY t.type, t.display_name`).all(gameId) as Array<{
      title_id: string | null; base_title_id: string | null; type: ContainedTitle['type'];
      display_name: string; raw_version: number | null; detection_source: string;
      file_path: string; inspection_error: string | null; provisional: number;
    }>;
  return rows.map((row) => ({ titleId: row.title_id, baseTitleId: row.base_title_id,
    type: row.type, name: row.display_name, rawVersion: row.raw_version,
    source: row.detection_source, filePath: row.file_path,
    inspectionError: row.inspection_error, provisional: Boolean(row.provisional) }));
}

export function pruneMissingLocalFiles(db: AppDatabase, exists: (path: string) => boolean): void {
  const rows = db.prepare('SELECT id,file_path FROM local_files').all() as Array<{ id: number; file_path: string }>;
  const deleteRow = db.prepare('DELETE FROM local_files WHERE id=?');
  for (const row of rows) if (!exists(row.file_path)) deleteRow.run(row.id);
}

/** Update every catalog projection after one physical move. */
export function movePhysicalFileRows(db: AppDatabase, source: string, destination: string, mtime: number): void {
  const name = basename(destination);
  const extension = extname(name).toLowerCase();
  db.prepare(`UPDATE local_files SET file_path=?,file_name=?,file_extension=?,modified_time=?
    WHERE file_path=?`).run(destination,name,extension,mtime,source);
  db.prepare(`UPDATE game_files SET file_path=?,file_name=?,file_extension=?,modified_time=?
    WHERE file_path=?`).run(destination,name,extension,mtime,source);
  db.prepare(`UPDATE updates SET file_path=?,file_name=?,modified_time=? WHERE file_path=?`)
    .run(destination,name,mtime,source);
}

export function deletePhysicalFileRows(db: AppDatabase, path: string): void {
  db.prepare('DELETE FROM local_files WHERE file_path=?').run(path);
  db.prepare('DELETE FROM game_files WHERE file_path=?').run(path);
  db.prepare('DELETE FROM updates WHERE file_path=?').run(path);
}

/** Attach update/DLC titles whose base was indexed later in the same scan. */
export function resolveTitleParents(db: AppDatabase): void {
  db.exec(`UPDATE titles SET game_id = (
    SELECT base.game_id FROM titles base WHERE base.title_id = titles.base_title_id
      AND base.type='base' AND base.game_id IS NOT NULL LIMIT 1)
    WHERE type IN ('update','dlc') AND game_id IS NULL AND base_title_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM titles base WHERE base.title_id=titles.base_title_id
        AND base.type='base' AND base.game_id IS NOT NULL)`);
  db.exec(`UPDATE updates SET game_id = (
    SELECT t.game_id FROM local_files lf JOIN file_titles ft ON ft.local_file_id=lf.id
    JOIN titles t ON t.id=ft.title_id WHERE lf.file_path=updates.file_path
      AND t.type IN ('update','dlc') AND t.provisional=0 AND t.game_id IS NOT NULL LIMIT 1)
    WHERE manual_match=0 AND EXISTS(
      SELECT 1 FROM local_files lf JOIN file_titles ft ON ft.local_file_id=lf.id
      JOIN titles t ON t.id=ft.title_id WHERE lf.file_path=updates.file_path
        AND t.type IN ('update','dlc') AND t.provisional=0 AND t.game_id IS NOT NULL)`);
}
