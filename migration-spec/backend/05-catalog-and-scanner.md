# 05 — Catalog and Scanner

## Scope

Port the behavior currently represented by `scanner.py`, related DB code, and scan-related UI logic into a background-capable service.

## Configured roots

Initial parity supports:
- one base-games folder;
- one updates/DLC folder.

Architecture should allow future multiple roots.

## Supported extensions

Case-insensitive:
- `.nsp`
- `.nsz`
- `.xci`

## Scan phases

### Phase 1 — Discovery

Recursively enumerate configured roots.

For each entry capture:
- canonical absolute path;
- filename;
- extension;
- size;
- modified time;
- root/source type.

Do not read complete multi-gigabyte game files.

### Phase 2 — Classification

Derive:
- normalized title;
- title ID if present;
- version if present;
- likely base/update/DLC classification;
- candidate matching keys.

### Phase 3 — Matching

Associate update/DLC candidates using the matching rules in `06-filename-matching-and-versions.md`.

### Phase 4 — Reconciliation

Use one transaction or bounded transactions to reconcile the current filesystem state with SQLite.

Rules:
- unchanged file paths should not create duplicate rows;
- moved/renamed files may initially be treated as remove + add unless a reliable identity exists;
- missing files should be removed or marked stale according to current parity behavior;
- metadata/favorite/manual match state belonging to a game should survive rescans.

## Job model

```ts
interface ScanJob {
  id: string;
  startedAt: number;
  cancelled: boolean;
  phase: ScanPhase;
}
```

Only one full scan at a time.

## Cancellation

Cancellation is cooperative.

Check cancellation:
- between directory batches;
- between classification batches;
- before matching batches;
- before write transactions.

Cancellation must never leave a partially corrupted DB.

If reconciliation has begun, finish the active atomic transaction before reporting cancelled.

## Progress reporting

Throttle renderer events to avoid IPC flooding.

Recommended maximum frequency: 5–10 progress events/second.

Fields:
- phase;
- checked files;
- candidate files;
- games found;
- updates found;
- current folder/path where useful.

## Scanner performance

Do not load the entire contents of large game files.

Use directory entry APIs that provide type metadata efficiently.

Potential Node implementation:
- `fs.promises.opendir` for controlled recursion;
- batched DB operations;
- worker thread if parsing/matching becomes CPU-heavy.

## Reconciliation invariants

After successful scan:
- every tracked base game file exists;
- every tracked update path exists;
- no duplicate `file_path` values;
- manually matched updates retain their match unless source file disappeared;
- favorite state persists;
- metadata lock state persists;
- unmatched updates have nullable `game_id`.

## Query behavior

Catalog list queries should support:
- text search;
- genre filter;
- favorite only;
- needs review;
- needs update;
- sort order;
- future pagination.

The first renderer may request all records if library sizes are modest, but repository APIs should still support pagination/filtering server-side.

