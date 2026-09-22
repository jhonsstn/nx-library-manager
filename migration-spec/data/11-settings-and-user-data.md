# 11 — Settings and User Data

## User-data root

Use Electron `app.getPath('userData')` for the new application.

Suggested contents:

```text
userData/
├── library.sqlite3
├── settings.json
├── cache/
│   ├── covers/
│   ├── screenshots/
│   └── versions/
└── logs/
```

## Settings schema

```ts
interface AppSettings {
  schemaVersion: number;

  baseGamesFolder: string;
  updatesFolder: string;

  autoRescanOnStartup: boolean;
  autoCheckUpdatesOnStartup: boolean;

  igdbClientId: string;
  igdbClientSecret?: string;

  httpServerEnabled: boolean;
  httpServerPort: number;
  httpServerUsername: string;
  httpServerPassword?: string;

  defaultInstallDestination: 'mtp-sd' | 'mtp-nand' | 'folder';
  defaultInstallFolder?: string;

  gridCoverSize: number;
}
```

## Validation

Load through Zod.

Invalid/missing properties receive safe defaults.

A malformed settings file should be backed up and replaced with valid defaults rather than crashing the app.

## Secret storage

Parity implementation may retain secrets in application settings if that matches the existing product, but architecture should support upgrading to Electron `safeStorage` for Windows-encrypted secret values.

Recommended target:
- store encrypted IGDB secret;
- store encrypted HTTP server password.

## Folder chooser

Renderer requests folder chooser through preload.

The main process returns a selected canonical path.

The renderer does not need arbitrary filesystem enumeration permission.

## Existing settings import

Detect old:

```text
~/.switch_library_catalog/settings.json
```

Import known compatible keys.

Unknown keys are ignored but old file remains untouched.

## Import UX

First run if old installation found:

```text
Existing Switch Game Catalog data found

Games: 327
Updates/DLC: 811
Favorites: 56

[Import Existing Data]
[Start Fresh]
```

Import performs a copy and migration, not a move.

## Cache migration

Cached covers/screenshots may be reused if paths are portable and valid; otherwise metadata URLs can redownload them.

Do not fail DB import just because image cache migration fails.

