# Switch Game Catalog documentation

These documents describe the standalone Electron application: its process boundaries, catalog scanner, metadata integration, install queue, DBI server, Windows MTP support, packaging, and tests.

The app owns its SQLite database beside the executable and stores settings and caches in the adjacent `data/` directory. It does not import, migrate, read, or share data with the earlier Python application.

Start with the root [README](../README.md), then use the numbered documents for implementation detail. The [release checklist](release-checklist.md) is the final shipping gate.
