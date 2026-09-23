# 13 — Primary User Flows

## First launch

1. Electron creates `library.sqlite3` and `data/` beside the executable.
2. The initial schema is applied.
3. Cached TitleDB data, if any, is loaded before the window opens.
4. The library opens empty and the user configures scan folders in Settings.

## Scan and review

The user selects local base/update folders, starts a scan, observes progress, and reviews matched or unmatched updates. Scan cancellation is cooperative. Background failures finish with a structured error and visible notification.

## Metadata

The user configures IGDB credentials, searches or refreshes metadata, reviews candidates, and may cache images locally.

## Local installation

Selected files enter a persistent queue. Same-volume moves use rename. Cross-volume moves stream into a unique partial file, report progress, verify size, finalize atomically, and then remove the source. Cancellation preserves the source and removes partial output.

## MTP installation

The user selects NAND or SD storage exposed by the Windows MTP adapter. Active MTP transfers cannot be cancelled because the platform handoff has no safe abort mechanism.

## Shutdown

Close and quit requests reject new work, cancel and await scanning, wait for the active install, stop services, checkpoint SQLite, and then quit once. The status bar explains any wait.
