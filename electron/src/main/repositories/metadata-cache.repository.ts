import type { AppDatabase } from '../db/database';

/**
 * Provider response cache (`metadata_cache`). Ports `db.upsert_cache` /
 * `db.get_cache`; cache keys carry a version segment so matching changes can
 * invalidate stale entries without wiping unrelated rows.
 */
export function getCacheEntry(db: AppDatabase, provider: string, query: string): unknown | null {
  const row = db
    .prepare('SELECT response_json FROM metadata_cache WHERE provider = ? AND query = ?')
    .get(provider, query) as { response_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.response_json) as unknown;
  } catch {
    return null;
  }
}

export function setCacheEntry(db: AppDatabase, provider: string, query: string, payload: unknown): void {
  db.prepare(
    `
    INSERT INTO metadata_cache(provider, query, response_json, cached_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, query) DO UPDATE SET
      response_json = excluded.response_json,
      cached_at = CURRENT_TIMESTAMP
    `,
  ).run(provider, query, JSON.stringify(payload));
}

export function cacheEntryCount(db: AppDatabase, provider: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM metadata_cache WHERE provider = ?')
    .get(provider) as { total: number };
  return row.total;
}
