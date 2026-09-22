# 10 — Database Schema and Migrations

The main process is the sole owner of the SQLite connection. Renderer code reaches data only through typed IPC and repository/service methods.

Fresh installations apply migration 1, `initial-schema`, which creates the complete Electron schema: games, game files, updates/DLC, install jobs, screenshots, metadata cache, indexes, and `schema_migrations`.

Future Electron releases add monotonically numbered migrations. Each migration runs in its own SQLite transaction and is recorded only after success. When pending work exists, the database is backed up beside the catalog first. A failed migration rolls back and opens the recovery screen instead of starting against a partial schema.

SQLite runs with foreign keys enabled, WAL journaling, normal synchronous mode, and a busy timeout. Shutdown waits for background work and checkpoints the WAL before closing.

The database is standalone. No compatibility, import, or shared-path behavior exists for databases from other applications.
