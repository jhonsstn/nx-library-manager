# Switch Game Catalog

Switch Game Catalog is a standalone Electron desktop app for cataloging personal Nintendo Switch package files, enriching entries with IGDB metadata, tracking available versions, and moving or serving files for installation.

It is a new application with its own database, settings, caches, and user-data directory. It does **not** import, migrate, read, or share data with the earlier Python application.

## Requirements and setup

- Node.js 22
- pnpm 12 (the exact version is declared in `package.json`)
- Windows for MTP/NAND/SD integration; catalog, scanning, local installs, and development also run on macOS/Linux

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

Useful commands:

```sh
pnpm run typecheck   # renderer/preload/main TypeScript
pnpm test            # unit and integration tests
pnpm run test:e2e    # build and run Playwright against Electron
pnpm run build       # production main, preload, and renderer bundles
pnpm run verify      # type-check, tests, and production build
pnpm run package:dir # unpacked packaging smoke test
pnpm run package:win # Windows NSIS and portable packages
```

## User data

Electron chooses the platform user-data root. A fresh installation normally uses:

- Windows: `%APPDATA%\Switch Game Catalog`
- macOS: `~/Library/Application Support/Switch Game Catalog`
- Linux: `~/.config/Switch Game Catalog`

The directory contains `library.sqlite3`, `settings.json`, version caches, image caches, logs, and migration backups. Database migrations apply only to databases created by this Electron app.

## Catalog scanning

Set the base-games folder and, optionally, a separate updates/DLC folder in Settings. Scanning reads `.nsp`, `.nsz`, and `.xci` file names and metadata without moving files. Repeated scans reconcile changed and removed files while preserving favorites, metadata, and manual matches unless an explicit library reset is requested.

Scans run in the background, report progress, can be cancelled, and surface failures in the UI.

## IGDB metadata

Create Twitch/IGDB API credentials and enter the client ID and secret in Settings. The secret is encrypted with Electron `safeStorage` and is never sent to the renderer. Metadata can be searched per game or refreshed in bulk; optional image caching keeps artwork available offline.

## Installing files

Local-folder installs are moves. A same-volume move uses an atomic rename. A cross-volume move streams to a unique partial destination, reports byte progress, verifies the result, finalizes it, and deletes the source. Cancelling a local transfer removes the partial output and preserves the source.

On Windows, the MTP adapter discovers DBI's NAND and SD install locations through PowerShell and the Shell namespace. MTP transfers are serialized and cannot be safely cancelled after the platform copy starts. Quitting waits for the active transfer to finish.

## DBI HTTP server and security

The optional DBI server exposes only files already tracked by the catalog. It supports directory listings, full downloads, byte ranges, and optional Basic Authentication. Paths are resolved from catalog IDs/names rather than arbitrary renderer input, and traversal attempts are rejected.

Basic Authentication over plain HTTP does not encrypt credentials or traffic. Use it only on a trusted LAN, preferably behind a private network such as Tailscale or WireGuard. Do not expose the server directly to the internet.

## Packaging and releases

`electron-builder.yml` defines Windows x64 NSIS and portable targets. The manual/tag release workflow builds both, generates SHA-256 checksums, and attaches artifacts to tagged GitHub releases. Pull requests and `main` use a separate Windows workflow for frozen dependency installation, type-checking, tests, and the production build.

See [docs/README.md](docs/README.md) for architecture details and [docs/release-checklist.md](docs/release-checklist.md) for release gates and the Windows manual test matrix.
