import type { AppDatabase } from '../db/database';
import type { CatalogFileRecord, CatalogFileSource } from '../server/catalog-file-source';

/** Raw `UNION ALL` row shape; mapped before it leaves the repository. */
interface CatalogFileRow {
  kind: 'game' | 'update';
  id: number;
  file_path: string;
  file_name: string;
  file_size: number;
  modified_time: number;
}

function toCatalogFileRecord(row: CatalogFileRow): CatalogFileRecord {
  return {
    kind: row.kind,
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSize: row.file_size,
    modifiedTime: row.modified_time,
  };
}

const CATALOG_UNION = `
  SELECT 'game' AS kind, gf.id AS id, gf.file_path AS file_path, gf.file_name AS file_name,
         gf.file_size AS file_size, gf.modified_time AS modified_time
  FROM game_files gf
  WHERE gf.is_base_game = 1
  UNION ALL
  SELECT 'update' AS kind, u.id AS id, u.file_path AS file_path, u.file_name AS file_name,
         u.file_size AS file_size, u.modified_time AS modified_time
  FROM updates u
`;

/**
 * Catalog file rows exposed to the DBI HTTP server. Only indexed rows are ever
 * returned, so the server can never resolve an arbitrary filesystem path.
 */
export function listCatalogFiles(db: AppDatabase): CatalogFileRecord[] {
  const rows = db.prepare(`${CATALOG_UNION} ORDER BY file_name COLLATE NOCASE`).all() as CatalogFileRow[];
  return rows.map(toCatalogFileRecord);
}

export function findCatalogFileById(
  db: AppDatabase,
  kind: 'game' | 'update',
  fileId: number,
): CatalogFileRecord | null {
  const row = (
    kind === 'game'
      ? db
          .prepare(
            `SELECT 'game' AS kind, id, file_path, file_name, file_size, modified_time
             FROM game_files WHERE id = ? AND is_base_game = 1`,
          )
          .get(fileId)
      : db
          .prepare(
            `SELECT 'update' AS kind, id, file_path, file_name, file_size, modified_time
             FROM updates WHERE id = ?`,
          )
          .get(fileId)
  ) as CatalogFileRow | undefined;
  return row ? toCatalogFileRecord(row) : null;
}

export function findCatalogFileByName(db: AppDatabase, fileName: string): CatalogFileRecord | null {
  const match = db
    .prepare(
      `
      SELECT 'game' AS kind, gf.id AS id, gf.file_path AS file_path, gf.file_name AS file_name,
             gf.file_size AS file_size, gf.modified_time AS modified_time
      FROM game_files gf
      WHERE gf.is_base_game = 1 AND gf.file_name = ?
      UNION ALL
      SELECT 'update' AS kind, u.id AS id, u.file_path AS file_path, u.file_name AS file_name,
             u.file_size AS file_size, u.modified_time AS modified_time
      FROM updates u
      WHERE u.file_name = ?
      LIMIT 1
      `,
    )
    .get(fileName, fileName) as CatalogFileRow | undefined;
  return match ? toCatalogFileRecord(match) : null;
}

/** Builds the seam the HTTP server consumes; `log` is supplied by the logger. */
export function createCatalogFileSource(db: AppDatabase, log: (line: string) => void): CatalogFileSource {
  return {
    listFiles: () => listCatalogFiles(db),
    findById: (kind, id) => findCatalogFileById(db, kind, id),
    findByName: (fileName) => findCatalogFileByName(db, fileName),
    logServerEvent: log,
  };
}
