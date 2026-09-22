# Switch Game Catalog — Electron Migration Specification

This specification decomposes the migration of **Switch Game Catalog** from Python/PySide6 into a Windows desktop application built with **Electron + React + TypeScript + SQLite**.

The package is intended to be implementation-ready. The documents are split by concern so individual migration phases can be developed and reviewed independently.

## Target stack

- Electron
- React
- TypeScript
- Vite
- TanStack Query
- Zod
- SQLite via `better-sqlite3`
- Node.js filesystem / HTTP APIs
- PowerShell as the initial Windows MTP bridge
- Electron Builder
- Vitest + React Testing Library + Playwright

## Guiding constraints

1. Functional parity comes before new features.
2. The React renderer never gets unrestricted Node.js access.
3. Privileged operations run in the Electron main process or a dedicated worker/utility process.
4. Existing SQLite library data should remain reusable.
5. Current PowerShell/COM MTP behavior should be preserved during the first migration release.
6. Scans, metadata refreshes, installs, and large file operations must not block the renderer.

## File map

### Architecture

- `architecture/01-system-architecture.md` — process model, trust boundaries, layering, event flow.
- `architecture/02-project-structure.md` — proposed repository/file layout and module ownership.
- `architecture/03-ipc-contract.md` — typed preload API and IPC request/event contracts.
- `architecture/04-error-logging-security.md` — error model, logging, validation, security requirements.

### Backend/domain

- `backend/05-catalog-and-scanner.md` — scanning, indexing, reconciliation, cancellation, progress.
- `backend/06-filename-matching-and-versions.md` — title parsing, fuzzy matching, update/version logic.
- `backend/07-metadata-service.md` — IGDB integration, credential handling, cache behavior.
- `backend/08-file-and-install-service.md` — file operations, install queue, destructive actions.
- `backend/09-dbi-http-server.md` — DBI-compatible HTTP server and range request behavior.

### Data

- `data/10-database-schema-and-migrations.md` — SQLite ownership, schema compatibility, migrations.
- `data/11-settings-and-user-data.md` — settings schema, secrets, old-data import, filesystem paths.

### Frontend

- `frontend/12-ui-and-state.md` — navigation, pages, components, query/state strategy.
- `frontend/13-user-flows.md` — primary interaction flows and UX acceptance criteria.

### Windows/platform

- `platform/14-windows-mtp.md` — current PowerShell MTP strategy and future native replacement boundary.
- `platform/15-packaging-and-updates.md` — Windows installers, portable builds, release/update strategy.

### Quality and delivery

- `testing/16-testing-strategy.md` — unit, integration, E2E, hardware/manual test matrix.
- `delivery/17-migration-plan.md` — implementation phases, dependency order, rollback strategy.
- `delivery/18-definition-of-done.md` — parity checklist and release acceptance criteria.

## Recommended implementation order

1. Scaffold Electron/React/TypeScript and secure preload bridge.
2. Implement SQLite and compatibility layer for existing data.
3. Render the current library from SQLite without scanning.
4. Port scanner + filename/version logic.
5. Port metadata.
6. Port local file operations and install queue.
7. Port Windows MTP bridge.
8. Port DBI HTTP server.
9. Package, test, migrate user data, release.

## Source application modules being migrated

Current Python modules map approximately as follows:

| Current Python module | Target responsibility |
| --- | --- |
| `ui.py` | React renderer pages/components |
| `db.py` | SQLite repositories + migrations |
| `scanner.py` | Scanner service / worker |
| `filename.py` | Filename parser + title matcher |
| `versions.py` | Version service |
| `metadata.py` | IGDB service |
| `file_ops.py` | File service + Windows MTP adapter |
| `http_server.py` | DBI HTTP server |
| `settings.py` | Settings service |
| `app_updates.py` | Release/update service |
| `paths.py` | Main-process user-data path helpers |

