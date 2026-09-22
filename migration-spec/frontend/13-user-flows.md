# 13 — Primary User Flows

## Flow A — First launch with existing Python data

1. App starts.
2. New user-data folder is initialized.
3. App detects old database/settings.
4. Migration screen shows counts if readable.
5. User chooses Import Existing Data.
6. App copies old DB/settings.
7. Migrations run on the copy.
8. Library opens with favorites/metadata intact.
9. Old Python files remain untouched.

Acceptance:
- no rescan required to see existing library;
- favorites preserved;
- manual matches preserved;
- import failure leaves original untouched.

## Flow B — Fresh setup

1. Open Settings.
2. Choose Base Games folder.
3. Choose Updates folder.
4. Optionally enter IGDB credentials.
5. Save settings.
6. Run Rescan.
7. Scan progress appears without freezing UI.
8. Library populates.

## Flow C — Browse/search

1. Open Library.
2. Enter text into search.
3. List updates interactively.
4. Select a game.
5. Details load.
6. Toggle Favorite.
7. Favorite state updates everywhere.

Acceptance:
- selection remains stable during minor query refreshes;
- search on several thousand records feels immediate.

## Flow D — Resolve unmatched update

1. Open Unmatched Updates.
2. Select file.
3. App shows likely candidate matches and scores.
4. User chooses a game.
5. Confirmation records manual match.
6. File disappears from unmatched list.
7. Game details now show update.

## Flow E — Metadata rematch

1. Context menu > Rematch Metadata.
2. App searches IGDB.
3. Candidate dialog displays cover/title/release date.
4. User chooses candidate.
5. Metadata and images update.
6. Manual metadata choice becomes locked from automated overwrite.

## Flow F — USB install

1. Switch is connected in expected DBI/MTP mode.
2. MTP status reports SD/NAND and available space.
3. User selects base game + update(s).
4. Click Install.
5. Choose SD or NAND.
6. App validates source files and free space.
7. Queue is created.
8. Transfer occurs in correct order.
9. Status updates throughout.
10. Completion notification appears.

Failure cases:
- device disconnects;
- destination disappears;
- insufficient space;
- source file disappears.

All failures produce a durable job status and useful error.

## Flow G — DBI Wi-Fi install

1. Settings > Enable HTTP server.
2. Main process starts server.
3. Settings shows exact `/dir/` URL.
4. User adds URL to DBI.
5. DBI lists catalog files.
6. DBI downloads full or ranged data.
7. Server remains responsive to large-file streaming.

## Flow H — Delete obsolete update

1. Right-click update.
2. Select Delete.
3. Confirmation shows filename/path.
4. User confirms.
5. Main process resolves row -> canonical path.
6. File is deleted.
7. DB row is removed/reconciled.
8. Game details refresh.

Acceptance:
- renderer cannot substitute another arbitrary path.

