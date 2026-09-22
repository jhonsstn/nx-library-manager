# 17 — Migration Plan

## Strategy

Build the Electron implementation alongside the Python app until parity is demonstrated.

Do not rewrite every subsystem at once.

## Phase 0 — Behavior capture

Before major implementation:
- gather representative filenames;
- snapshot existing SQLite schema;
- capture scanner results for a known test library;
- document MTP behavior and PowerShell scripts;
- capture DBI HTTP request/response behavior.

Deliverable: regression fixtures.

## Phase 1 — Scaffold

Deliver:
- Electron + Vite + React + TypeScript;
- secure BrowserWindow config;
- preload API;
- IPC error envelope;
- logging;
- test framework.

Exit criteria:
- renderer invokes a typed health/version API;
- no Node integration in renderer.

## Phase 2 — Database and import

Deliver:
- `better-sqlite3`;
- migrations;
- old DB detection/copy/import;
- repositories;
- read-only library UI.

Exit criteria:
- existing Python catalog appears correctly in Electron without rescan.

## Phase 3 — Core library UI

Deliver:
- Library;
- details;
- Grid;
- Favorites;
- search/filter;
- cached images.

Exit criteria:
- normal browsing can be done entirely in Electron.

## Phase 4 — Scanner/matching/version

Deliver:
- recursive scan;
- filename parser;
- update matching;
- unmatched view;
- version cache/compare;
- scan progress/cancel.

Exit criteria:
- regression fixture results match Python implementation within reviewed exceptions.

## Phase 5 — Metadata

Deliver:
- IGDB settings;
- token/cache/search;
- bulk/manual refresh;
- candidate selector;
- screenshots/trailers.

Exit criteria:
- equivalent metadata workflows.

## Phase 6 — Local file operations/install model

Deliver:
- delete/move;
- install queue schema;
- folder destination installation;
- progress event framework.

Exit criteria:
- local operations stable and path-safe.

## Phase 7 — Windows MTP

Deliver:
- PowerShell adapter;
- device/storage status;
- SD/NAND install;
- disconnect/error handling.

Exit criteria:
- manual hardware test matrix passes.

## Phase 8 — DBI server

Deliver:
- routes;
- directory listing;
- basic auth;
- Range streaming;
- Settings controls.

Exit criteria:
- real DBI device successfully lists/downloads/installs from Electron app.

## Phase 9 — Packaging/beta

Deliver:
- Windows installer;
- portable build if desired;
- first-run migration UI;
- update check;
- release logging/diagnostics.

Exit criteria:
- clean PC installation works;
- existing-user import works;
- core parity checklist passes.

## Rollback strategy

Until Electron rewrite is stable:
- never mutate the original Python database during import;
- allow both applications to exist independently;
- clearly warn if both point at the same game files and destructive operations are used;
- keep migration backup.

## Cleanup phase

Only after stable Electron release:
- archive Python implementation in a tag/branch;
- update README/setup docs;
- remove Python packaging from main branch if desired.

