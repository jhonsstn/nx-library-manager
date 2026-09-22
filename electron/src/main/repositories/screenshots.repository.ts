import type { AppDatabase } from '../db/database';
import type { ScreenshotDto } from '../../shared/types/domain';

export interface ScreenshotRow {
  id: number;
  game_id: number;
  image_url: string;
  local_path: string | null;
  sort_order: number;
}

export interface ScreenshotRecord {
  id: number;
  gameId: number;
  imageUrl: string;
  localPath: string | null;
  sortOrder: number;
}

export function toScreenshotRecord(row: ScreenshotRow): ScreenshotRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    imageUrl: row.image_url,
    localPath: row.local_path,
    sortOrder: row.sort_order,
  };
}

/** `displayUrl` is resolved by the caller (cache path -> `catalog-image://` URL). */
export function toScreenshotDto(row: ScreenshotRow, displayUrl: string): ScreenshotDto {
  return { ...toScreenshotRecord(row), displayUrl };
}

export function listScreenshots(db: AppDatabase, gameId: number, limit?: number): ScreenshotRow[] {
  const limitClause = limit !== undefined ? `LIMIT ${Math.trunc(limit)}` : '';
  return db
    .prepare(`SELECT id, game_id, image_url, local_path, sort_order FROM screenshots WHERE game_id = ? ORDER BY sort_order ${limitClause}`)
    .all(gameId) as ScreenshotRow[];
}

export function listScreenshotsForGames(db: AppDatabase, gameIds: number[]): Map<number, ScreenshotRow[]> {
  const grouped = new Map<number, ScreenshotRow[]>();
  if (gameIds.length === 0) return grouped;
  const placeholders = gameIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, game_id, image_url, local_path, sort_order FROM screenshots
       WHERE game_id IN (${placeholders}) ORDER BY game_id, sort_order`,
    )
    .all(...gameIds) as ScreenshotRow[];
  for (const row of rows) {
    const list = grouped.get(row.game_id);
    if (list) list.push(row);
    else grouped.set(row.game_id, [row]);
  }
  return grouped;
}

/** Replaces a game's screenshot set, preserving cached local paths by URL. */
export function replaceScreenshots(db: AppDatabase, gameId: number, imageUrls: string[]): void {
  const previous = new Map<string, string>();
  for (const row of listScreenshots(db, gameId)) {
    if (row.local_path) previous.set(row.image_url, row.local_path);
  }
  const remove = db.prepare('DELETE FROM screenshots WHERE game_id = ?');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO screenshots(game_id, image_url, local_path, sort_order) VALUES (?, ?, ?, ?)',
  );
  const apply = db.transaction(() => {
    remove.run(gameId);
    imageUrls.forEach((url, index) => {
      insert.run(gameId, url, previous.get(url) ?? null, index);
    });
  });
  apply();
}

export function setScreenshotLocalPath(db: AppDatabase, screenshotId: number, localPath: string): void {
  db.prepare('UPDATE screenshots SET local_path = ? WHERE id = ?').run(localPath, screenshotId);
}

/** Screenshot URLs that still need downloading, capped per call. */
export function listScreenshotsMissingCache(db: AppDatabase, gameId: number, limit: number): ScreenshotRow[] {
  return db
    .prepare(
      `SELECT id, game_id, image_url, local_path, sort_order FROM screenshots
       WHERE game_id = ? AND (local_path IS NULL OR local_path = '')
       ORDER BY sort_order LIMIT ${Math.trunc(limit)}`,
    )
    .all(gameId) as ScreenshotRow[];
}
