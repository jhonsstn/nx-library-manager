import type { AppDatabase } from '../db/database';
import type { GameFileDto } from '../../shared/types/domain';

export interface GameFileRow {
  id: number;
  game_id: number;
  file_path: string;
  file_name: string;
  file_extension: string;
  file_size: number;
  modified_time: number;
  file_type: string;
  is_base_game: number;
}

export interface GameFileRecord extends GameFileDto {}

export function toGameFileRecord(row: GameFileRow): GameFileRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileExtension: row.file_extension,
    fileSize: row.file_size,
    modifiedTime: row.modified_time,
    fileType: row.file_type,
    isBaseGame: row.is_base_game === 1,
  };
}

const FILE_COLUMNS = 'id, game_id, file_path, file_name, file_extension, file_size, modified_time, file_type, is_base_game';

export function listGameFiles(db: AppDatabase, gameId: number): GameFileRecord[] {
  const rows = db
    .prepare(`SELECT ${FILE_COLUMNS} FROM game_files WHERE game_id = ? ORDER BY id`)
    .all(gameId) as GameFileRow[];
  return rows.map(toGameFileRecord);
}

export function getBaseFile(db: AppDatabase, gameId: number): GameFileRecord | null {
  const row = db
    .prepare(`SELECT ${FILE_COLUMNS} FROM game_files WHERE game_id = ? AND is_base_game = 1 ORDER BY id LIMIT 1`)
    .get(gameId) as GameFileRow | undefined;
  return row ? toGameFileRecord(row) : null;
}

export function getGameFile(db: AppDatabase, fileId: number): GameFileRecord | null {
  const row = db.prepare(`SELECT ${FILE_COLUMNS} FROM game_files WHERE id = ?`).get(fileId) as GameFileRow | undefined;
  return row ? toGameFileRecord(row) : null;
}

export function findGameFileByPath(db: AppDatabase, filePath: string): GameFileRecord | null {
  const row = db.prepare(`SELECT ${FILE_COLUMNS} FROM game_files WHERE file_path = ?`).get(filePath) as
    | GameFileRow
    | undefined;
  return row ? toGameFileRecord(row) : null;
}

export function knownGameFilePaths(db: AppDatabase): Set<string> {
  const rows = db.prepare('SELECT file_path FROM game_files').all() as Array<{ file_path: string }>;
  return new Set(rows.map((row) => row.file_path));
}

/** Base file names per game, used for title-ID based update matching. */
export function baseFileNamesByGame(db: AppDatabase): Map<number, string> {
  const rows = db
    .prepare('SELECT game_id, file_name FROM game_files WHERE is_base_game = 1 ORDER BY id')
    .all() as Array<{ game_id: number; file_name: string }>;
  const result = new Map<number, string>();
  for (const row of rows) {
    if (!result.has(row.game_id)) result.set(row.game_id, row.file_name);
  }
  return result;
}

export interface BaseGameFileInput {
  gameId: number;
  filePath: string;
  fileName: string;
  fileExtension: string;
  fileSize: number;
  modifiedTime: number;
  fileType: string;
}

/** Ports the `game_files` upsert in `scanner._upsert_base_game`. */
export function upsertBaseGameFile(db: AppDatabase, input: BaseGameFileInput): number {
  db.prepare(
    `
    INSERT INTO game_files(game_id, file_path, file_name, file_extension, file_size, modified_time, file_type, is_base_game)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(file_path) DO UPDATE SET
        game_id = excluded.game_id,
        file_name = excluded.file_name,
        file_extension = excluded.file_extension,
        file_size = excluded.file_size,
        modified_time = excluded.modified_time,
        file_type = excluded.file_type
    `,
  ).run(
    input.gameId,
    input.filePath,
    input.fileName,
    input.fileExtension,
    input.fileSize,
    input.modifiedTime,
    input.fileType,
  );
  const row = db.prepare('SELECT id FROM game_files WHERE file_path = ?').get(input.filePath) as { id: number };
  return row.id;
}

export function updateGameFilePath(
  db: AppDatabase,
  fileId: number,
  input: { filePath: string; fileName: string; fileExtension: string; modifiedTime: number },
): void {
  db.prepare('UPDATE game_files SET file_path = ?, file_name = ?, file_extension = ?, modified_time = ? WHERE id = ?').run(
    input.filePath,
    input.fileName,
    input.fileExtension,
    input.modifiedTime,
    fileId,
  );
}

export function deleteGameFile(db: AppDatabase, fileId: number): void {
  db.prepare('DELETE FROM game_files WHERE id = ?').run(fileId);
}

export function deleteGameFilesForGame(db: AppDatabase, gameId: number): void {
  db.prepare('DELETE FROM game_files WHERE game_id = ?').run(gameId);
}

export function countBaseFiles(db: AppDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM game_files WHERE is_base_game = 1').get() as { total: number };
  return row.total;
}

/** Base game files keyed by game id, in a single query (first row wins). */
export function baseFilesByGame(db: AppDatabase): Map<number, GameFileRecord> {
  const rows = db
    .prepare(`SELECT ${FILE_COLUMNS} FROM game_files WHERE is_base_game = 1 ORDER BY id`)
    .all() as GameFileRow[];
  const result = new Map<number, GameFileRecord>();
  for (const row of rows) {
    if (!result.has(row.game_id)) result.set(row.game_id, toGameFileRecord(row));
  }
  return result;
}
