import type { AppDatabase } from '../db/database';
import type { GameDetailsDto, GameFileDto, GameSummaryDto, MetadataCandidateDto } from '../../shared/types/domain';

/** Row shape of the `games` table. Never leaves the repository layer. */
export interface GameRow {
  id: number;
  display_title: string;
  cleaned_title: string;
  metadata_provider: string | null;
  metadata_provider_id: string | null;
  description: string | null;
  release_date: string | null;
  developer: string | null;
  publisher: string | null;
  genres: string | null;
  cover_image_path: string | null;
  cover_image_url: string | null;
  trailer_url: string | null;
  date_added: string;
  last_scanned: string;
  metadata_locked: number;
  needs_review: number;
  favorite: number;
}

export interface GameRecord {
  id: number;
  displayTitle: string;
  cleanedTitle: string;
  metadataProvider: string | null;
  metadataProviderId: string | null;
  description: string;
  releaseDate: string | null;
  developer: string;
  publisher: string;
  genres: string[];
  coverImagePath: string | null;
  coverImageUrl: string | null;
  trailerUrl: string | null;
  dateAdded: string;
  lastScanned: string;
  metadataLocked: boolean;
  needsReview: boolean;
  favorite: boolean;
}

export interface GameListFilter {
  search?: string;
  genre?: string | null;
  favoritesOnly?: boolean;
  needsReview?: boolean;
  sort?: 'title-asc' | 'title-desc' | 'added-desc';
  limit?: number;
  offset?: number;
}

const GAME_COLUMNS =
  'id, display_title, cleaned_title, metadata_provider, metadata_provider_id, description, release_date, ' +
  'developer, publisher, genres, cover_image_path, cover_image_url, trailer_url, date_added, last_scanned, ' +
  'metadata_locked, needs_review, favorite';

/** Parses the JSON-encoded `genres` column, tolerating legacy/BLOB junk. */
export function parseGenres(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function toGameRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    displayTitle: row.display_title,
    cleanedTitle: row.cleaned_title,
    metadataProvider: row.metadata_provider,
    metadataProviderId: row.metadata_provider_id,
    description: row.description ?? '',
    releaseDate: row.release_date,
    developer: row.developer ?? '',
    publisher: row.publisher ?? '',
    genres: parseGenres(row.genres),
    coverImagePath: row.cover_image_path,
    coverImageUrl: row.cover_image_url,
    trailerUrl: row.trailer_url,
    dateAdded: row.date_added,
    lastScanned: row.last_scanned,
    metadataLocked: row.metadata_locked === 1,
    needsReview: row.needs_review === 1,
    favorite: row.favorite === 1,
  };
}

function buildWhere(filter: GameListFilter): { clause: string; args: unknown[] } {
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (filter.search) {
    // Prefix match, mirroring the Qt build's `display_title LIKE 'term%'`.
    conditions.push('g.display_title LIKE ?');
    args.push(`${filter.search}%`);
  }
  if (filter.genre && filter.genre !== 'All Genres') {
    conditions.push('g.genres LIKE ?');
    args.push(`%"${filter.genre}"%`);
  }
  if (filter.favoritesOnly) conditions.push('g.favorite = 1');
  if (filter.needsReview) conditions.push('(g.metadata_provider IS NULL OR g.needs_review = 1)');
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    args,
  };
}

function orderBy(sort: GameListFilter['sort']): string {
  switch (sort) {
    case 'title-desc':
      return 'ORDER BY g.display_title COLLATE NOCASE DESC';
    case 'added-desc':
      return 'ORDER BY g.date_added DESC, g.id DESC';
    default:
      return 'ORDER BY g.display_title COLLATE NOCASE';
  }
}

export function listGames(db: AppDatabase, filter: GameListFilter = {}): GameRecord[] {
  const { clause, args } = buildWhere(filter);
  const paging = filter.limit !== undefined ? `LIMIT ${filter.limit} OFFSET ${filter.offset ?? 0}` : '';
  const rows = db
    .prepare(`SELECT ${GAME_COLUMNS} FROM games g ${clause} ${orderBy(filter.sort)} ${paging}`)
    .all(...args) as GameRow[];
  return rows.map(toGameRecord);
}

export function countGames(db: AppDatabase, filter: GameListFilter = {}): number {
  const { clause, args } = buildWhere(filter);
  const row = db.prepare(`SELECT COUNT(*) AS total FROM games g ${clause}`).get(...args) as { total: number };
  return row.total;
}

export function getGame(db: AppDatabase, gameId: number): GameRecord | null {
  const row = db.prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE id = ?`).get(gameId) as GameRow | undefined;
  return row ? toGameRecord(row) : null;
}

export function listGenres(db: AppDatabase): string[] {
  const rows = db
    .prepare("SELECT genres FROM games WHERE genres IS NOT NULL AND genres != ''")
    .all() as Array<{ genres: string }>;
  const genres = new Set<string>();
  for (const row of rows) {
    for (const genre of parseGenres(row.genres)) {
      const trimmed = genre.trim();
      if (trimmed) genres.add(trimmed);
    }
  }
  return [...genres].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function setFavorite(db: AppDatabase, gameId: number, favorite: boolean): void {
  const result = db.prepare('UPDATE games SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, gameId);
  if (result.changes === 0) throw new Error(`No game with id ${gameId}`);
}

export function setNeedsReview(db: AppDatabase, gameId: number, value: boolean): void {
  db.prepare('UPDATE games SET needs_review = ? WHERE id = ?').run(value ? 1 : 0, gameId);
}

/** Scan reconciliation: creates the game row when the cleaned title is new. */
export function upsertGameByCleanedTitle(
  db: AppDatabase,
  input: { displayTitle: string; cleanedTitle: string },
): number {
  db.prepare(
    `
    INSERT INTO games(display_title, cleaned_title, last_scanned)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(cleaned_title) DO UPDATE SET last_scanned = CURRENT_TIMESTAMP
    `,
  ).run(input.displayTitle, input.cleanedTitle);
  const row = db.prepare('SELECT id FROM games WHERE cleaned_title = ?').get(input.cleanedTitle) as { id: number };
  return row.id;
}

export function findGameIdByCleanedTitle(db: AppDatabase, cleanedTitle: string): number | null {
  const row = db.prepare('SELECT id FROM games WHERE cleaned_title = ?').get(cleanedTitle) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

/**
 * Deletes rows that a rescan no longer sees on disk. Games with metadata,
 * favorites or manual matches are never removed implicitly by reconciliation;
 * the caller decides which ids are safe to drop.
 */
export function deleteGames(db: AppDatabase, gameIds: number[]): void {
  if (gameIds.length === 0) return;
  const placeholders = gameIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM games WHERE id IN (${placeholders})`).run(...gameIds);
}

export function deleteGame(db: AppDatabase, gameId: number): void {
  db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
}

export function markGameScanTime(db: AppDatabase, gameId: number): void {
  db.prepare('UPDATE games SET last_scanned = CURRENT_TIMESTAMP WHERE id = ?').run(gameId);
}

export interface MetadataApplyOptions {
  lock: boolean;
  needsReview: boolean;
}

/** Ports `metadata.apply_metadata_result`. */
export function applyMetadataResult(
  db: AppDatabase,
  gameId: number,
  result: MetadataCandidateDto,
  options: MetadataApplyOptions,
): void {
  db.prepare(
    `
    UPDATE games SET
        display_title = CASE WHEN ? THEN ? WHEN EXISTS (
          SELECT 1 FROM titles WHERE game_id = ? AND type = 'base' AND name_source = 'nacp'
        ) THEN display_title ELSE ? END,
        metadata_provider = ?,
        metadata_provider_id = ?,
        description = ?,
        release_date = ?,
        developer = ?,
        publisher = ?,
        genres = ?,
        cover_image_url = ?,
        trailer_url = ?,
        needs_review = ?,
        metadata_locked = CASE WHEN ? THEN 1 ELSE metadata_locked END
    WHERE id = ?
    `,
  ).run(
    options.lock ? 1 : 0,
    result.title,
    gameId,
    result.title,
    result.provider,
    result.providerId,
    result.description,
    result.releaseDate,
    result.developer,
    result.publisher,
    JSON.stringify(result.genres),
    result.coverImageUrl,
    result.trailerUrl,
    options.needsReview ? 1 : 0,
    options.lock ? 1 : 0,
    gameId,
  );
}

export function setCoverImagePath(db: AppDatabase, gameId: number, coverImagePath: string): void {
  db.prepare('UPDATE games SET cover_image_path = ? WHERE id = ?').run(coverImagePath, gameId);
}

/** Games eligible for a metadata refresh, ordered like the Qt build. */
export function listGamesNeedingMetadata(
  db: AppDatabase,
  options: { force?: boolean; limit?: number } = {},
): Array<{ id: number; displayTitle: string; cleanedTitle: string }> {
  const conditions = ['metadata_locked = 0'];
  if (!options.force) {
    conditions.push("(description IS NULL OR description = '' OR trailer_url IS NULL)");
  }
  const limit = options.limit ? `LIMIT ${Math.trunc(options.limit)}` : '';
  const rows = db
    .prepare(
      `SELECT id, display_title, cleaned_title FROM games WHERE ${conditions.join(' AND ')}
       ORDER BY display_title COLLATE NOCASE ${limit}`,
    )
    .all() as Array<{ id: number; display_title: string; cleaned_title: string }>;
  return rows.map((row) => ({
    id: row.id,
    displayTitle: row.display_title,
    cleanedTitle: row.cleaned_title,
  }));
}

/** Compatibility view used by the legacy `fetch_missing_metadata` semantics. */
export function listGamesForBulkRefresh(
  db: AppDatabase,
  provider: string,
  limit?: number,
): Array<{ id: number; displayTitle: string; cleanedTitle: string }> {
  const limitClause = limit ? `LIMIT ${Math.trunc(limit)}` : '';
  const rows = db
    .prepare(
      `
      SELECT id, display_title, cleaned_title FROM games
      WHERE metadata_locked = 0
        AND (
          metadata_provider IS NULL OR metadata_provider != ?
          OR description IS NULL OR description = ''
          OR cover_image_url IS NULL OR cover_image_url = ''
          OR trailer_url IS NULL OR needs_review = 1
        )
      ORDER BY display_title COLLATE NOCASE ${limitClause}
      `,
    )
    .all(provider) as Array<{ id: number; display_title: string; cleaned_title: string }>;
  return rows.map((row) => ({
    id: row.id,
    displayTitle: row.display_title,
    cleanedTitle: row.cleaned_title,
  }));
}

/** Game ids mapped to their display titles, for list joins. */
export function allGameTitles(db: AppDatabase): Map<number, string> {
  const rows = db.prepare('SELECT id, display_title FROM games').all() as Array<{
    id: number;
    display_title: string;
  }>;
  return new Map(rows.map((row) => [row.id, row.display_title]));
}

/** Removes every catalog row, mirroring `db.reset_library_cache`. */
export function resetLibrary(db: AppDatabase): void {
  db.exec(`
    DELETE FROM file_titles;
    DELETE FROM local_files;
    DELETE FROM titles;
    DELETE FROM install_jobs;
    DELETE FROM updates;
    DELETE FROM screenshots;
    DELETE FROM game_files;
    DELETE FROM games;
    DELETE FROM sqlite_sequence
      WHERE name IN ('install_jobs', 'updates', 'screenshots', 'game_files', 'games',
        'file_titles', 'local_files', 'titles');
  `);
}

export type { GameDetailsDto, GameSummaryDto, GameFileDto };
