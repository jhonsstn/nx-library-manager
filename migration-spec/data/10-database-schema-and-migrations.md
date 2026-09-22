# 10 — Database Schema and Migrations

## Database engine

SQLite through `better-sqlite3`.

## Connection defaults

Recommended pragmas after validation on Windows:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

WAL should be verified with the application's actual user-data path and backup behavior before release.

## Compatibility goal

Prefer opening/importing the existing Python database without destructive conversion.

Current known core tables include:
- `games`;
- `game_files`;
- `updates`;
- `screenshots`;
- `metadata_cache`;
- `install_jobs`.

## Migration system

Create a `schema_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Migrations execute in numeric order inside transactions.

## Migration policy

- Never drop user tables as part of a normal upgrade without an explicit data-preserving replacement strategy.
- Before high-risk migration, create a backup copy.
- Migration failure aborts startup into a recovery screen instead of continuing against a half-upgraded DB.

## Repository boundary

SQL should live in repository/data modules, not React or IPC handlers.

Repositories return typed DTO/domain objects rather than `better-sqlite3` row objects.

## Suggested indexes

Verify with actual queries, but likely indexes include:

```sql
CREATE INDEX IF NOT EXISTS idx_game_files_game_id ON game_files(game_id);
CREATE INDEX IF NOT EXISTS idx_updates_game_id ON updates(game_id);
CREATE INDEX IF NOT EXISTS idx_updates_manual_match ON updates(manual_match);
CREATE INDEX IF NOT EXISTS idx_games_favorite ON games(favorite);
CREATE INDEX IF NOT EXISTS idx_games_needs_review ON games(needs_review);
```

Search by title may initially use normalized lower-case columns; FTS can be introduced later if needed.

## Existing DB import modes

Preferred first-run behavior:

1. detect old `~/.switch_library_catalog/library.sqlite3`;
2. inspect schema/version;
3. copy it to the Electron user-data location;
4. run migrations on the copied DB;
5. leave original untouched.

Do not migrate in place on the first Electron launch.

## Backup

Before migration:

```text
library.sqlite3
library.sqlite3.pre-electron-YYYYMMDD-HHMMSS.bak
```

## Transactions

Use transactions for:
- scan reconciliation;
- metadata apply involving multiple tables;
- delete/move operations that update filesystem + DB state carefully;
- migration scripts.

Filesystem operations cannot be fully transactional with SQLite, so define compensation behavior explicitly:

Example move:
1. move file;
2. update DB;
3. if DB write fails, attempt to move file back;
4. log if compensation also fails.

