# 16 — Testing Strategy

The suite is organized around independent Electron behavior rather than output captured from another implementation.

- Unit tests cover parsing, matching, validation, version logic, file operations, settings, lifecycle coordination, and renderer interactions.
- Integration tests use temporary SQLite databases, filesystem trees, and HTTP servers for repositories, scanning, catalog behavior, migrations, and DBI range requests.
- Playwright launches the built Electron app with a fresh user-data directory and verifies clean startup, scanning, favorites, settings, and restart persistence.
- Windows CI runs a frozen install, type-check, unit/integration tests, and the production build on pull requests and `main`.
- The release workflow packages NSIS and portable artifacts on demand and for version tags.

Every test must isolate user data in a temporary directory. Network clients use injected fetch implementations. Destructive filesystem tests operate only inside their test directory.

Before release run `pnpm run verify`, `pnpm run test:e2e`, `pnpm run package:dir`, and `git diff --check`. Windows manual checks cover both packages, real MTP installs, cross-drive moves and cancellation, quit during transfer, and DBI ranged downloads.
