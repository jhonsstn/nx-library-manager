/**
 * Read seam between the DBI HTTP server and the catalog database.
 *
 * The server may only serve files that are already indexed in SQLite
 * (`migration-spec/backend/09-dbi-http-server.md`: "A request may only resolve to
 * a row already indexed in SQLite"). Implemented by the repository layer.
 */
export interface CatalogFileRecord {
  kind: 'game' | 'update';
  id: number;
  filePath: string;
  fileName: string;
  fileSize: number;
  modifiedTime: number;
}

export interface CatalogFileSource {
  /** Base games and updates, ordered by file name (case-insensitive). */
  listFiles(): CatalogFileRecord[];
  findById(kind: 'game' | 'update', id: number): CatalogFileRecord | null;
  /** Matches on the base name of the stored file path, like the Qt build did. */
  findByName(fileName: string): CatalogFileRecord | null;
  /** Structured server log line (never includes authorization headers). */
  logServerEvent(line: string): void;
}
