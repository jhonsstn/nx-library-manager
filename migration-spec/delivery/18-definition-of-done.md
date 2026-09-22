# 18 — Definition of Done and Parity Checklist

## Product acceptance

The Electron rewrite is ready to replace the Python app when all critical items below pass.

## Library

- [ ] Existing SQLite library imports safely.
- [ ] Existing favorites survive migration.
- [ ] Existing metadata survives migration.
- [ ] Existing manual update matches survive migration.
- [ ] Search works.
- [ ] Genre filtering works.
- [ ] Needs Review works.
- [ ] Needs Update works.
- [ ] Favorites view works.
- [ ] Grid view works.
- [ ] Adjustable cover size works.

## Scanner

- [ ] `.nsp` discovered recursively.
- [ ] `.nsz` discovered recursively.
- [ ] `.xci` discovered recursively.
- [ ] Base games classified.
- [ ] Updates classified.
- [ ] DLC behavior matches current app.
- [ ] Title IDs extracted.
- [ ] Versions extracted.
- [ ] Fuzzy matching behaves equivalently.
- [ ] Manual matches are preserved.
- [ ] Unmatched files are shown.
- [ ] UI remains responsive during scan.
- [ ] Scan cancellation is safe.

## Metadata

- [ ] IGDB credentials configurable.
- [ ] Token caching works.
- [ ] Switch-first search works.
- [ ] Cover art works.
- [ ] Description/developer/publisher/genres work.
- [ ] Screenshots work.
- [ ] Trailer link works.
- [ ] Manual rematch works.
- [ ] Cached metadata remains usable offline.

## Versions

- [ ] TitleDB data loads from cache.
- [ ] Stale data refreshes.
- [ ] Refresh failure preserves old cache.
- [ ] Current/update-available status matches expected output.

## File operations

- [ ] Delete base/update operation validates tracked path.
- [ ] Move operation handles name conflicts.
- [ ] DB state updates after filesystem operation.
- [ ] Destructive actions require confirmation.

## MTP/install

- [ ] Switch connection detected.
- [ ] SD destination detected.
- [ ] NAND destination detected.
- [ ] Free space displayed when available.
- [ ] Base game install succeeds.
- [ ] Update install succeeds.
- [ ] DLC install succeeds where supported.
- [ ] Combined install ordering matches existing app.
- [ ] Disconnect is reported cleanly.
- [ ] Renderer does not freeze during transfer.

## DBI HTTP server

- [ ] Server starts/stops from Settings.
- [ ] Correct LAN `/dir/` URL displayed.
- [ ] Directory listing works in DBI.
- [ ] Full file download works.
- [ ] HTTP Range works.
- [ ] Resume works where DBI uses it.
- [ ] Basic Auth works.
- [ ] Arbitrary filesystem traversal is impossible.

## Desktop application

- [ ] Windows installer works on clean machine.
- [ ] Application starts without Python installed.
- [ ] Application data survives upgrade/uninstall according to policy.
- [ ] Secure preload bridge is used.
- [ ] `nodeIntegration` disabled in renderer.
- [ ] App logs actionable errors.
- [ ] Update check works.

## Tests

- [ ] Filename parser tests pass.
- [ ] Matching tests pass.
- [ ] Version tests pass.
- [ ] DB migration tests pass.
- [ ] Scanner integration tests pass.
- [ ] HTTP Range/server tests pass.
- [ ] Renderer smoke tests pass.
- [ ] Playwright Electron smoke flow passes.
- [ ] Manual Windows MTP test matrix passes.

## Release gate

No release intended to replace the Python version if any of these critical failures remain:
- data-loss risk;
- database import corruption;
- arbitrary-path delete/move vulnerability;
- nonfunctional MTP install;
- nonfunctional DBI HTTP server;
- renderer lockup during normal scan/install;
- broken existing-user migration.

