import type { AppDatabase } from '../db/database';
import type { UpdateFileDto, UpdateGroupName } from '../../shared/types/domain';

export interface UpdateRow {
  id: number;
  game_id: number | null;
  file_path: string;
  file_name: string;
  detected_version: string | null;
  file_size: number;
  modified_time: number;
  match_confidence: number;
  manual_match: number;
}

export interface UpdateRecord {
  id: number;
  gameId: number | null;
  filePath: string;
  fileName: string;
  detectedVersion: string;
  fileSize: number;
  modifiedTime: number;
  matchConfidence: number;
  manualMatch: boolean;
}

const UPDATE_COLUMNS =
  'id, game_id, file_path, file_name, detected_version, file_size, modified_time, match_confidence, manual_match';

export function toUpdateRecord(row: UpdateRow): UpdateRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    filePath: row.file_path,
    fileName: row.file_name,
    detectedVersion: row.detected_version ?? '',
    fileSize: row.file_size,
    modifiedTime: row.modified_time,
    matchConfidence: row.match_confidence,
    manualMatch: row.manual_match === 1,
  };
}

/**
 * `group` must be derived by the caller (`scanner/classify-file.updateFileGroup`)
 * so this layer stays free of filename parsing.
 */
export function toUpdateFileDto(row: UpdateRow, group: UpdateGroupName): UpdateFileDto {
  const record = toUpdateRecord(row);
  return { ...record, group };
}

export function listUpdatesForGame(db: AppDatabase, gameId: number): UpdateRecord[] {
  const rows = db
    .prepare(`SELECT ${UPDATE_COLUMNS} FROM updates WHERE game_id = ? ORDER BY file_name`)
    .all(gameId) as UpdateRow[];
  return rows.map(toUpdateRecord);
}

export function listUnmatchedUpdates(db: AppDatabase): UpdateRecord[] {
  const rows = db
    .prepare(`SELECT ${UPDATE_COLUMNS} FROM updates WHERE game_id IS NULL ORDER BY file_name`)
    .all() as UpdateRow[];
  return rows.map(toUpdateRecord);
}

export function listAllUpdates(db: AppDatabase): UpdateRecord[] {
  const rows = db.prepare(`SELECT ${UPDATE_COLUMNS} FROM updates ORDER BY file_name`).all() as UpdateRow[];
  return rows.map(toUpdateRecord);
}

export function getUpdate(db: AppDatabase, updateId: number): UpdateRecord | null {
  const row = db.prepare(`SELECT ${UPDATE_COLUMNS} FROM updates WHERE id = ?`).get(updateId) as UpdateRow | undefined;
  return row ? toUpdateRecord(row) : null;
}

/** Every update grouped by owning game, in a single query. */
export function updatesByGame(db: AppDatabase): Map<number, UpdateRecord[]> {
  const rows = db
    .prepare(`SELECT ${UPDATE_COLUMNS} FROM updates WHERE game_id IS NOT NULL ORDER BY file_name`)
    .all() as UpdateRow[];
  const grouped = new Map<number, UpdateRecord[]>();
  for (const row of rows) {
    const record = toUpdateRecord(row);
    if (record.gameId === null) continue;
    const list = grouped.get(record.gameId);
    if (list) list.push(record);
    else grouped.set(record.gameId, [record]);
  }
  return grouped;
}

export function knownUpdatePaths(db: AppDatabase): Set<string> {
  const rows = db.prepare('SELECT file_path FROM updates').all() as Array<{ file_path: string }>;
  return new Set(rows.map((row) => row.file_path));
}

export interface UpdateUpsertInput {
  gameId: number | null;
  filePath: string;
  fileName: string;
  detectedVersion: string;
  fileSize: number;
  modifiedTime: number;
  matchConfidence: number;
}

/**
 * Ports `scanner._upsert_update`, including the rule that an existing manual
 * match is never overwritten by an automatic rescan.
 */
export function upsertUpdate(db: AppDatabase, input: UpdateUpsertInput): void {
  db.prepare(
    `
    INSERT INTO updates(game_id, file_path, file_name, detected_version, file_size, modified_time, match_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
        game_id = CASE WHEN updates.manual_match = 1 THEN updates.game_id ELSE excluded.game_id END,
        file_name = excluded.file_name,
        detected_version = excluded.detected_version,
        file_size = excluded.file_size,
        modified_time = excluded.modified_time,
        match_confidence = CASE WHEN updates.manual_match = 1 THEN updates.match_confidence ELSE excluded.match_confidence END
    `,
  ).run(
    input.gameId,
    input.filePath,
    input.fileName,
    input.detectedVersion,
    input.fileSize,
    input.modifiedTime,
    input.matchConfidence,
  );
}

/** Manual assignment from the Unmatched view: pins the match against rescans. */
export function assignManualMatch(db: AppDatabase, updateIds: number[], gameId: number): void {
  const statement = db.prepare('UPDATE updates SET game_id = ?, match_confidence = 1, manual_match = 1 WHERE id = ?');
  const apply = db.transaction(() => {
    for (const updateId of updateIds) statement.run(gameId, updateId);
  });
  apply();
}

export function unmatchUpdates(db: AppDatabase, updateIds: number[]): void {
  const statement = db.prepare('UPDATE updates SET game_id = NULL, match_confidence = 0, manual_match = 0 WHERE id = ?');
  const apply = db.transaction(() => {
    for (const updateId of updateIds) statement.run(updateId);
  });
  apply();
}

export function updateUpdatePath(
  db: AppDatabase,
  updateId: number,
  input: { filePath: string; fileName: string; modifiedTime: number },
): void {
  db.prepare('UPDATE updates SET file_path = ?, file_name = ?, modified_time = ? WHERE id = ?').run(
    input.filePath,
    input.fileName,
    input.modifiedTime,
    updateId,
  );
}

export function deleteUpdate(db: AppDatabase, updateId: number): void {
  db.prepare('DELETE FROM updates WHERE id = ?').run(updateId);
}

export function deleteUpdates(db: AppDatabase, updateIds: number[]): void {
  if (updateIds.length === 0) return;
  const placeholders = updateIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM updates WHERE id IN (${placeholders})`).run(...updateIds);
}

export function deleteUpdateByPath(db: AppDatabase, filePath: string): void {
  db.prepare('DELETE FROM updates WHERE file_path = ?').run(filePath);
}

export function deleteUpdatesByPaths(db: AppDatabase, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  const statement = db.prepare('DELETE FROM updates WHERE file_path = ?');
  const apply = db.transaction(() => {
    for (const filePath of filePaths) statement.run(filePath);
  });
  apply();
}

export function countUpdates(db: AppDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM updates').get() as { total: number };
  return row.total;
}

export function clearGameIdForUpdates(db: AppDatabase, gameId: number): void {
  db.prepare('UPDATE updates SET game_id = NULL WHERE game_id = ?').run(gameId);
}

/**
 * Ports `ui.mark_game_as_update`: the row is (re)created with no game, no
 * confidence and no manual match, clearing any previous association.
 */
export function upsertUnmatchedUpdate(db: AppDatabase, input: UpdateUpsertInput): void {
  db.prepare(
    `
    INSERT INTO updates(game_id, file_path, file_name, detected_version, file_size, modified_time, match_confidence, manual_match)
    VALUES (NULL, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(file_path) DO UPDATE SET
        game_id = NULL,
        file_name = excluded.file_name,
        detected_version = excluded.detected_version,
        file_size = excluded.file_size,
        modified_time = excluded.modified_time,
        match_confidence = 0,
        manual_match = 0
    `,
  ).run(input.filePath, input.fileName, input.detectedVersion, input.fileSize, input.modifiedTime);
}
