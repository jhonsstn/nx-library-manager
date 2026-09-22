# 02 — Project Structure

## Repository layout

```text
SwitchGameCatalog/
├── package.json
├── electron-builder.yml
├── vite.config.ts
├── tsconfig.json
├── tsconfig.main.json
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── lifecycle/
│   │   ├── ipc/
│   │   ├── db/
│   │   ├── repositories/
│   │   ├── services/
│   │   ├── scanner/
│   │   ├── metadata/
│   │   ├── versions/
│   │   ├── install/
│   │   ├── mtp/
│   │   ├── server/
│   │   ├── settings/
│   │   └── platform/
│   ├── preload/
│   │   ├── index.ts
│   │   └── api.ts
│   ├── renderer/
│   │   ├── main.tsx
│   │   ├── app/
│   │   ├── pages/
│   │   ├── components/
│   │   ├── features/
│   │   ├── hooks/
│   │   ├── query/
│   │   └── styles/
│   └── shared/
│       ├── contracts/
│       ├── schemas/
│       ├── types/
│       ├── constants/
│       └── errors/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
└── resources/
    ├── icon.ico
    └── scripts/
```

## Module ownership

### `src/shared`

Contains data structures safe to import from main, preload, and renderer.

Allowed:
- TypeScript types;
- Zod schemas;
- IPC request/response contracts;
- domain enums;
- error codes;
- pure utility functions.

Not allowed:
- Electron imports;
- Node filesystem imports;
- database code;
- secrets.

### `src/main/db`

Owns:
- database opening;
- SQLite pragmas;
- migrations;
- transaction helpers.

Only the main process and main-side workers may open the application DB.

### `src/main/repositories`

Repositories encapsulate SQL and return domain DTOs.

Examples:
- `games.repository.ts`
- `game-files.repository.ts`
- `updates.repository.ts`
- `screenshots.repository.ts`
- `metadata-cache.repository.ts`
- `install-jobs.repository.ts`

Repositories should not perform UI formatting.

### `src/main/services`

Services coordinate repositories and external resources.

Examples:
- `catalog.service.ts`
- `settings.service.ts`
- `app-update.service.ts`

### `src/main/scanner`

Pure classification logic should be separable from filesystem traversal so it can be unit tested without Electron.

Suggested files:
- `scan-job.ts`
- `walk-library.ts`
- `classify-file.ts`
- `filename-parser.ts`
- `match-update.ts`
- `reconcile.ts`

### `src/main/mtp`

Expose an interface such as:

```ts
export interface MtpAdapter {
  listInstallDestinations(): Promise<MtpStorageInfo[]>;
  copyFile(source: string, destination: MtpDestination, onProgress?: ProgressFn): Promise<void>;
  isAvailable(): Promise<boolean>;
}
```

Initial implementation:
- `powershell-mtp.adapter.ts`

Future implementation:
- `windows-wpd.adapter.ts`

The rest of the app must not know which adapter is active.

### `src/renderer/features`

Prefer feature folders over one giant components directory.

Example:

```text
features/
├── library/
├── game-details/
├── grid/
├── metadata/
├── install/
├── unmatched/
├── settings/
└── server-status/
```

Each feature may own:
- components;
- hooks;
- query keys;
- view models;
- test files.

## Naming conventions

- IPC channels: `domain:action`, e.g. `catalog:listGames`.
- Event channels: `event:domain:eventName`, e.g. `event:scan:progress`.
- Zod schemas: `SomethingSchema`.
- DTOs: `SomethingDto`.
- database rows: internal repository types, never exposed directly.
- domain services: `*.service.ts`.
- adapters: `*.adapter.ts`.
