import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import type { AppDatabase } from '../db/database';
import { withTransaction } from '../db/database';
import { cleanTitle, detectVersion, isUpdateOrDlcFilename } from './filename-parser';
import { applyMatchThreshold, matchUpdate, type MatchCandidateGame } from './match-update';
import type { LibraryFileEntry } from './walk-library';
import { deleteGames, listGames, upsertGameByCleanedTitle } from '../repositories/games.repository';
import {
  baseFileNamesByGame,
  deleteGameFile,
  listGameFiles,
  upsertBaseGameFile,
} from '../repositories/game-files.repository';
import {
  deleteUpdateByPath,
  deleteUpdates,
  knownUpdatePaths,
  listAllUpdates,
  upsertUpdate,
} from '../repositories/updates.repository';

/**
 * Port of `switch_catalog.scanner.scan_library` / `_scan_mixed_folder`.
 *
 * Deviations from the Python build, both required by spec 05's reconciliation
 * invariants ("every tracked base game file exists", "every tracked update path
 * exists"):
 * - a final prune pass drops rows whose `file_path` disappeared from disk. Rows
 *   outside the scanned roots are kept as long as their file still exists, so a
 *   rescan of one root never drops another root's catalog entries;
 * - every pass runs inside its own transaction, so a failure cannot half-apply a
 *   phase.
 */

export type ReconcileMode = 'split' | 'mixed';

export type ReconcileStage = 'base' | 'matching' | 'updates' | 'prune';

export interface ReconcileProgress {
  stage: ReconcileStage;
  gamesFound: number;
  updatesFound: number;
  matchedUpdates: number;
  unmatchedUpdates: number;
}

export interface ReconcileSummary {
  gamesFound: number;
  updatesFound: number;
  matchedUpdates: number;
  unmatchedUpdates: number;
}

export interface ReconcileInput {
  /** Entries discovered under the base root (or every entry in mixed mode). */
  baseEntries: LibraryFileEntry[];
  /** Entries discovered under the updates root; empty in mixed mode. */
  updateEntries: LibraryFileEntry[];
  mode: ReconcileMode;
  threshold: number;
  /**
   * Returns true when the caller asked to stop: the passes that have not begun
   * yet are skipped, and a pass already running finishes its transaction.
   */
  updateSignal?: () => boolean;
  onProgress?: (progress: ReconcileProgress) => void;
}

/** Entries processed between progress reports inside a pass. */
const PROGRESS_STEP = 16;

interface UpdateDecision {
  entry: LibraryFileEntry;
  gameId: number | null;
  confidence: number;
}

export function reconcileLibrary(db: AppDatabase, input: ReconcileInput): ReconcileSummary {
  const summary: ReconcileSummary = { gamesFound: 0, updatesFound: 0, matchedUpdates: 0, unmatchedUpdates: 0 };
  const report = (stage: ReconcileStage): void => {
    input.onProgress?.({ stage, ...summary });
  };
  const stopped = (): boolean => input.updateSignal?.() === true;

  let baseEntries = input.baseEntries;
  let updateEntries = input.updateEntries;
  if (input.mode === 'mixed') {
    // One root holds everything, so the file name decides which pass an entry
    // belongs to (`_scan_mixed_folder`).
    const base: LibraryFileEntry[] = [];
    const updates: LibraryFileEntry[] = [];
    for (const list of [input.baseEntries, input.updateEntries]) {
      for (const entry of list) {
        if (isUpdateOrDlcFilename(entry.fileName)) updates.push(entry);
        else base.push(entry);
      }
    }
    baseEntries = base;
    updateEntries = updates;
  }

  // Pass 1 — base games. A path the catalog already tracks as an update is left
  // alone in split mode (`scan_library`) and promoted back to a base file in
  // mixed mode (`_remove_update_for_path`), so a file already classified as an
  // update is never silently re-added as a base game.
  if (baseEntries.length > 0 && !stopped()) {
    withTransaction(db, () => {
      const trackedUpdates = knownUpdatePaths(db);
      let processed = 0;
      for (const entry of baseEntries) {
        if (trackedUpdates.has(entry.path)) {
          if (input.mode !== 'mixed') continue;
          deleteUpdateByPath(db, entry.path);
          trackedUpdates.delete(entry.path);
        }
        upsertBaseEntry(db, entry);
        summary.gamesFound += 1;
        processed += 1;
        if (processed % PROGRESS_STEP === 0) report('base');
      }
      report('base');
    });
  }

  // Pass 2 — match every update candidate against the catalog. Read-only, so it
  // is safe to abandon on cancellation.
  const games = buildMatchCandidates(db);
  const existingUpdatesByPath = new Map(listAllUpdates(db).map((update) => [update.filePath, update]));
  const decisions: UpdateDecision[] = [];
  let decisionsComplete = !stopped();
  report('matching');
  for (const entry of updateEntries) {
    if (stopped()) {
      decisionsComplete = false;
      break;
    }
    const existing = existingUpdatesByPath.get(entry.path);
    if (existing?.manualMatch) {
      // A manual match is never overridden by an automatic rescan.
      decisions.push({ entry, gameId: existing.gameId, confidence: existing.matchConfidence });
      continue;
    }
    const match = applyMatchThreshold(matchUpdate(entry.fileName, games), input.threshold);
    decisions.push({ entry, gameId: match.gameId, confidence: match.confidence });
    if (decisions.length % PROGRESS_STEP === 0) report('matching');
  }
  report('matching');

  // Pass 3 — store the update rows.
  if (decisionsComplete && !stopped()) {
    withTransaction(db, () => {
      for (const decision of decisions) {
        upsertUpdate(db, {
          gameId: decision.gameId,
          filePath: decision.entry.path,
          fileName: decision.entry.fileName,
          detectedVersion: detectVersion(decision.entry.fileName),
          fileSize: decision.entry.sizeBytes,
          modifiedTime: decision.entry.modifiedTime,
          matchConfidence: decision.confidence,
        });
        summary.updatesFound += 1;
        if (decision.gameId === null) summary.unmatchedUpdates += 1;
        else summary.matchedUpdates += 1;
        if (summary.updatesFound % PROGRESS_STEP === 0) report('updates');
      }
      report('updates');
    });
  }

  // Pass 4 — prune catalog rows whose files are gone.
  if (decisionsComplete && !stopped()) {
    withTransaction(db, () => {
      pruneMissingFiles(db);
      report('prune');
    });
  }

  return summary;
}

/** `_upsert_base_game`: game row keyed by cleaned title, then its base file row. */
function upsertBaseEntry(db: AppDatabase, entry: LibraryFileEntry): void {
  const cleaned = cleanTitle(entry.fileName);
  const displayTitle = cleaned || stemOf(entry.fileName);
  const gameId = upsertGameByCleanedTitle(db, { displayTitle, cleanedTitle: cleaned || displayTitle });
  upsertBaseGameFile(db, {
    gameId,
    filePath: entry.path,
    fileName: entry.fileName,
    // `path.suffix.lower()` / `path.suffix[1:].upper()` in the Python build.
    fileExtension: `.${entry.extension}`,
    fileSize: entry.sizeBytes,
    modifiedTime: entry.modifiedTime,
    fileType: entry.extension.toUpperCase(),
  });
}

/** `pathlib.Path(name).stem` for a name produced by the walk. */
function stemOf(fileName: string): string {
  const extension = extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

/** The `games LEFT JOIN game_files` rows `_match_update` receives. */
function buildMatchCandidates(db: AppDatabase): MatchCandidateGame[] {
  const baseFileNames = baseFileNamesByGame(db);
  return listGames(db).map((game) => ({
    id: game.id,
    displayTitle: game.displayTitle,
    cleanedTitle: game.cleanedTitle,
    fileName: baseFileNames.get(game.id) ?? null,
  }));
}

/**
 * Removes rows for files that no longer exist. Only missing paths are eligible:
 * a row whose file is merely outside the scanned roots survives.
 */
function pruneMissingFiles(db: AppDatabase): void {
  const emptyGameIds: number[] = [];
  for (const game of listGames(db)) {
    for (const file of listGameFiles(db, game.id)) {
      if (!existsSync(file.filePath)) deleteGameFile(db, file.id);
    }
    if (listGameFiles(db, game.id).length === 0) emptyGameIds.push(game.id);
  }
  deleteGames(db, emptyGameIds);

  const missingUpdates = listAllUpdates(db)
    .filter((update) => !existsSync(update.filePath))
    .map((update) => update.id);
  deleteUpdates(db, missingUpdates);
}
