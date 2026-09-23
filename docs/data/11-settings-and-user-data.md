# 11 — Settings and User Data

The app sets Electron's `userData` and `sessionData` paths inside `data/` beside the executable before Electron is ready. The paths module creates:

- `library.sqlite3` and its migration backups beside the executable;
- `data/settings.json` and `data/prod-keys.enc`;
- TitleDB version cache files under `data/cache/versions/`;
- cover and screenshot caches under `data/cache/`;
- application and DBI server logs under `data/logs/`;
- Chromium session data under `data/session/`.

Settings are schema-validated and written through a temporary file plus atomic rename. Malformed settings are backed up and repaired field by field. IGDB and HTTP passwords use Electron `safeStorage`; secrets never cross into the renderer.

HTTP-related changes are transactional. The store snapshots its encrypted state, writes the new values, and attempts to reconfigure the server. If startup fails, the old settings are restored and the previous server configuration is restarted before the error is returned.

These files are exclusive to the Electron product. The app does not detect, import, or share settings, databases, or caches from the Python application. `safeStorage` ciphertext may not decrypt under a different OS account or machine.
