import Database from 'better-sqlite3';

export type AppDatabase = Database.Database;

export interface OpenDatabaseOptions {
  readOnly?: boolean;
  /** Applied after the connection opens. Defaults to the app's pragma set. */
  pragmas?: Partial<Record<'foreign_keys' | 'journal_mode' | 'synchronous' | 'busy_timeout', string | number>>;
}

const DEFAULT_PRAGMAS = {
  foreign_keys: 'ON',
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  busy_timeout: 5000,
} as const;

/**
 * Opens the catalog database. Only the main process (and main-side workers) may
 * call this; repositories are the only modules that issue SQL.
 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): AppDatabase {
  const db = new Database(file, { readonly: options.readOnly ?? false });
  const pragmas = { ...DEFAULT_PRAGMAS, ...options.pragmas };
  for (const [name, value] of Object.entries(pragmas)) {
    if (value === undefined) continue;
    db.pragma(`${name} = ${value}`);
  }
  return db;
}

export function closeDatabase(db: AppDatabase | null): void {
  if (!db || !db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* checkpoint is best effort during shutdown */
  }
  db.close();
}

/** Runs `fn` inside a single transaction, rolling back if it throws. */
export function withTransaction<T>(db: AppDatabase, fn: () => T): T {
  return db.transaction(fn)();
}

export function tableExists(db: AppDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

export function columnNames(db: AppDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
