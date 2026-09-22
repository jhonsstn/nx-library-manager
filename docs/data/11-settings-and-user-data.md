# 11 — Settings and User Data

Electron's `app.getPath('userData')` is the root for application-owned state. The paths module creates:

- `library.sqlite3` and its migration backups;
- `settings.json`;
- TitleDB version cache files;
- cover and screenshot caches;
- application and DBI server logs.

Settings are schema-validated and written through a temporary file plus atomic rename. Malformed settings are backed up and repaired field by field. IGDB and HTTP passwords use Electron `safeStorage`; secrets never cross into the renderer.

HTTP-related changes are transactional. The store snapshots its encrypted state, writes the new values, and attempts to reconfigure the server. If startup fails, the old settings are restored and the previous server configuration is restarted before the error is returned.

This directory is exclusive to the Electron product. The app does not detect, import, or share settings, databases, or caches from the Python application.
