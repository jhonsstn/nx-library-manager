# 01 — System Architecture

## Objective

Define a maintainable desktop architecture that isolates the React UI from filesystem, database, shell, HTTP server, MTP, and secret-bearing operations.

## Process model

```text
┌─────────────────────────────────────────────────────────┐
│ Electron Renderer                                       │
│ React + TypeScript                                      │
│                                                         │
│ - Views/components                                      │
│ - Search/filter state                                   │
│ - TanStack Query cache                                  │
│ - Presentation-only state                               │
└───────────────────────┬─────────────────────────────────┘
                        │ window.switchCatalog
                        │ contextBridge
┌───────────────────────▼─────────────────────────────────┐
│ Preload                                                  │
│                                                         │
│ - Typed, narrow API                                     │
│ - Request validation                                    │
│ - Event subscription wrappers                           │
└───────────────────────┬─────────────────────────────────┘
                        │ ipcRenderer.invoke / events
┌───────────────────────▼─────────────────────────────────┐
│ Electron Main Process                                   │
│                                                         │
│ - IPC handlers                                          │
│ - DB repositories                                       │
│ - Settings                                              │
│ - Local file operations                                 │
│ - HTTP server lifecycle                                 │
│ - App/update lifecycle                                  │
│ - Windows adapters                                      │
└───────────────────┬──────────────────┬──────────────────┘
                    │                  │
       ┌────────────▼───────┐  ┌──────▼──────────────────┐
       │ Worker/utility proc│  │ PowerShell / Windows COM│
       │                    │  │                         │
       │ - deep scanning    │  │ - MTP discovery        │
       │ - expensive parse  │  │ - shell destinations   │
       │ - optional hashing │  │ - MTP copy/install     │
       └────────────────────┘  └─────────────────────────┘
```

## Layer rules

### Renderer

May:
- request catalog data;
- submit validated commands;
- subscribe to progress/events;
- open external URLs through a dedicated API;
- hold presentation state.

Must not:
- import `fs`, `path`, `child_process`, `better-sqlite3`, `http`, or PowerShell helpers;
- receive IGDB client secrets unless explicitly required for editing settings;
- execute arbitrary shell commands;
- receive arbitrary file-system capabilities.

### Preload

Responsibilities:
- expose `window.switchCatalog`;
- map a fixed set of renderer methods to IPC channel names;
- expose event subscription/unsubscription helpers;
- avoid exposing raw `ipcRenderer`.

### Main process

Responsibilities:
- enforce path and payload validation;
- own database connections;
- own settings and secrets;
- orchestrate background work;
- emit normalized domain events;
- start/stop the DBI HTTP server;
- invoke Windows-specific helpers.

### Workers / utility processes

Use for operations that can take long enough to block main-process responsiveness:
- recursive scans of very large libraries;
- expensive title matching across many files;
- optional future archive inspection/hash calculation.

The first implementation may perform lightweight database queries and short filesystem calls in the main process.

## Main domain services

### CatalogService

Coordinates game listings, detail fetches, favorites, review flags, and library reconciliation.

### ScannerService

Discovers configured files, classifies them, extracts structured filename data, and writes reconciled records.

### MetadataService

Handles IGDB token management, search, matching, caching, and metadata persistence.

### VersionService

Loads cached TitleDB version data, refreshes stale data, and calculates local-vs-latest state.

### FileService

Handles local move/delete operations using validated paths.

### InstallService

Creates and executes install jobs against local folders or MTP destinations.

### MtpService

Provides a platform-neutral interface implemented initially by a Windows PowerShell adapter.

### DbiHttpServer

Serves only catalog-indexed files and supports DBI directory listing / Range downloads.

### SettingsService

Owns settings loading, validation, migration, and persistence.

## State ownership

Persistent truth lives in:
- SQLite: catalog, metadata, favorites, matches, install history;
- settings file: configured source folders, HTTP server configuration, UI preferences, integration credentials;
- cached assets directory: covers, screenshots, version lists, logs.

The React Query cache is never authoritative.

## Concurrency

### Scan

Only one full scan may run at a time.

Subsequent scan request behavior:
- if same scope: return existing job ID;
- if incompatible scope: reject with `JOB_ALREADY_RUNNING`.

### Install

Initial release supports one active transfer at a time, but queue representation must support multiple pending jobs.

### Metadata

Allow several concurrent network requests with a small concurrency cap, e.g. 3–5.

## Application shutdown

On quit:
1. reject new background jobs;
2. stop HTTP server;
3. cancel/finish non-destructive scanner work;
4. do not interrupt an MTP write without explicit policy;
5. close SQLite handles;
6. flush logs.

