# 08 — File and Install Service

## FileService scope

Handles local filesystem operations:
- move one file;
- move several files;
- delete a tracked file;
- generate conflict-free destination names;
- validate source existence;
- validate destination folder.

## Path safety

Destructive operations should normally identify files by database ID.

Example:

```ts
files.delete({ kind: 'update', id: 391 })
```

The main process resolves the stored path and confirms the row still points to the same canonical path before deleting.

## Move collision behavior

Preserve current unique-name behavior:

```text
Game.nsp
Game (1).nsp
Game (2).nsp
```

## Install service

The install service transforms user intent into a queue of concrete file-transfer jobs.

Input example:

```ts
interface CreateInstallInput {
  gameId: number;
  updateIds: number[];
  destination: InstallDestination;
}
```

## Install ordering

When installing a base plus extras:
1. base game;
2. selected update(s), oldest-to-newest only if meaningful and required;
3. DLC files.

Only explicitly selected update/DLC files enter the queue.

## Destination types

```ts
type InstallDestination =
  | { type: 'folder'; path: string }
  | { type: 'mtp'; storage: 'sd' | 'nand' };
```

## Queue model

Persist install jobs in SQLite.

Statuses:
- pending;
- running;
- completed;
- failed;
- cancelled.

Only one transfer is active at a time.

## Queue recovery

On application startup:
- jobs left in `running` due to crash become `failed` or `interrupted`;
- pending jobs may remain queued only if their source files still exist;
- do not automatically resume MTP writes unless explicitly supported.

## Progress

For destinations that provide byte progress, emit:
- transferred bytes;
- total bytes;
- instantaneous or smoothed speed optionally;
- current file index / total queue length.

If the PowerShell MTP mechanism cannot provide byte progress reliably, use state-level progress:
- preparing;
- copying;
- completed.

Do not fake precise percentages.

## Free-space validation

Before starting, compare expected size against known destination free space when available.

If storage data is unavailable, allow the user to proceed but report that free space could not be verified.

## Failure behavior

On individual failure:
- mark current job failed;
- stop subsequent queue items by default;
- let user retry failed/pending portion;
- do not delete source files unless the current installation workflow explicitly requires moving rather than copying.
