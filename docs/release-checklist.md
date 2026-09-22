# Standalone Electron Release Checklist

## Automated gates

- [ ] `pnpm install --frozen-lockfile` succeeds.
- [ ] `pnpm run verify` succeeds.
- [ ] `pnpm run test:e2e` succeeds from a clean user-data directory.
- [ ] `pnpm run package:dir` produces a launchable unpacked app.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] Windows pull-request/main verification is green.

## Product behavior

- [ ] Fresh launch creates only Electron-owned data.
- [ ] The app never detects, imports, or shares Python application data.
- [ ] Scans report progress, cancellation, and visible structured failures.
- [ ] Cached TitleDB data is available at startup and invalid refreshes preserve it.
- [ ] IGDB secrets never cross to the renderer or appear in logs.
- [ ] Local same-drive and cross-drive installs move files safely.
- [ ] Local cancellation preserves the source and removes partial files.
- [ ] An active MTP install remains non-cancellable.
- [ ] HTTP setting failures restore the prior settings and running server.
- [ ] Quit waits for active scan/install work, reports status, and completes once.

## Windows release matrix

- [ ] NSIS install, launch, update, and uninstall.
- [ ] Portable launch with a fresh profile.
- [ ] Cross-drive progress, cancellation, and cleanup.
- [ ] Real NAND and SD MTP installs.
- [ ] Quit during local and MTP transfers.
- [ ] DBI full and ranged downloads, authentication, and traversal rejection.
- [ ] Release artifacts and SHA-256 checksums are attached to the tag.
