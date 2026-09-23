import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScanInput } from '../../shared/contracts/api';
import { DEFAULT_FUZZY_MATCH_THRESHOLD } from '../../shared/constants';
import { appError, toAppErrorDto } from '../../shared/errors/app-error';
import type { AppErrorDto } from '../../shared/errors/codes';
import type { JobStartedDto, ScanCompletedDto, ScanProgressDto, ScanStatusDto } from '../../shared/types/domain';
import type { AppDatabase } from '../db/database';
import { withTransaction } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import { resetLibrary } from '../repositories/games.repository';
import { isUpdateOrDlcFilename } from '../scanner/filename-parser';
import { reconcileLibrary } from '../scanner/reconcile';
import { ProgressFlusher, ScanJob } from '../scanner/scan-job';
import { walkLibrary, type LibraryFileEntry } from '../scanner/walk-library';
import { INSPECTOR_VERSION, type InspectedTitle } from '../scanner/package-inspector';
import { inspectInWorker } from '../scanner/inspect-worker';
import { cachedInspection, cachedHasBaseTitle, recordInspection, pruneMissingLocalFiles, resolveTitleParents } from '../repositories/title-catalog.repository';
import type { ProdKeysStore } from '../settings/prod-keys';
import { existsSync } from 'node:fs';

/**
 * Scan orchestration (spec 05): discovery, classification, matching and
 * reconciliation run off the IPC path while the renderer only sees throttled
 * progress events and the final summary.
 */

export interface ScannerServiceOptions {
  db: AppDatabase;
  prodKeys?: ProdKeysStore;
  logger?: Logger;
  /** Clock seam; defaults to `Date.now`. */
  now?: () => number;
  onProgress?: (event: ScanProgressDto) => void;
  onCompleted?: (event: ScanCompletedDto) => void;
}

interface ResolvedScanScope {
  baseFolder: string;
  /** `null` when the library is scanned as one mixed folder. */
  updatesFolder: string | null;
  recursive: boolean;
  threshold: number;
  mode: 'split' | 'mixed';
  key: string;
}

interface ActiveScan {
  job: ScanJob;
  scopeKey: string;
  controller: AbortController;
  /** The background run this service tracks; `null` until it is started. */
  runPromise: Promise<void> | null;
  finished: boolean;
  summary: ScanCompletedDto | null;
}

/** Finished jobs stay queryable this long; the oldest entries are dropped first. */
const JOB_HISTORY_LIMIT = 20;

/** Entries classified between cancellation checks. */
const CLASSIFY_BATCH_SIZE = 256;

export class ScannerService {
  private readonly db: AppDatabase;
  private readonly prodKeys: ProdKeysStore | undefined;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly onProgress: ((event: ScanProgressDto) => void) | undefined;
  private readonly onCompleted: ((event: ScanCompletedDto) => void) | undefined;

  private readonly jobs = new Map<string, ActiveScan>();
  private active: ActiveScan | null = null;
  private shuttingDown = false;

  constructor(options: ScannerServiceOptions) {
    this.db = options.db;
    this.prodKeys = options.prodKeys;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.onProgress = options.onProgress;
    this.onCompleted = options.onCompleted;
  }

  /** Registers a scan and returns immediately; the run continues in the background. */
  async start(input: ScanInput): Promise<JobStartedDto> {
    if (this.shuttingDown) {
      throw appError('JOB_CANCELLED', 'The scanner is shutting down and cannot start new scans');
    }
    const scope = resolveScanScope(input);

    const active = this.active;
    if (active && !active.finished) {
      if (active.scopeKey === scope.key) return { jobId: active.job.id };
      throw appError('JOB_ALREADY_RUNNING', `A scan is already running (${active.job.id})`, {
        details: { jobId: active.job.id },
      });
    }

    // An explicit reset discards favourites, metadata and manual matches.
    if (input.resetLibrary === true) {
      withTransaction(this.db, () => resetLibrary(this.db));
    }

    const job = new ScanJob({ id: randomUUID(), startedAt: this.now() });
    const entry: ActiveScan = {
      job,
      scopeKey: scope.key,
      controller: new AbortController(),
      runPromise: null,
      finished: false,
      summary: null,
    };
    this.jobs.set(job.id, entry);
    this.active = entry;
    this.trimHistory();
    entry.runPromise = this.run(entry, scope);

    this.logger?.info('scan.started', {
      jobId: job.id,
      baseFolder: scope.baseFolder,
      updatesFolder: scope.updatesFolder,
      recursive: scope.recursive,
      threshold: scope.threshold,
      resetLibrary: input.resetLibrary === true,
    });
    return { jobId: job.id };
  }

  /** Cooperative cancellation: unknown and finished jobs are silently ignored. */
  async cancel(jobId: string): Promise<void> {
    const entry = this.jobs.get(jobId);
    if (!entry || entry.finished) return;
    entry.job.requestCancel();
    entry.controller.abort();
  }

  async getStatus(jobId: string): Promise<ScanStatusDto> {
    const entry = this.jobs.get(jobId);
    if (!entry) throw appError('NOT_FOUND', `Unknown scan job ${jobId}`, { details: { jobId } });
    return {
      jobId: entry.job.id,
      running: !entry.finished,
      cancelled: entry.job.cancelled,
      phase: entry.job.phase,
      progress: entry.job.progress,
      summary: entry.summary,
    };
  }

  get isBusy(): boolean {
    return this.active !== null && !this.active.finished;
  }

  async whenIdle(): Promise<void> {
    const run = this.active?.runPromise;
    if (run) await run;
  }

  /**
   * App shutdown hook: cancels the active scan and blocks further ones. The
   * transaction already running is allowed to finish, so the catalog stays
   * consistent.
   */
  shutdown(): void {
    this.shuttingDown = true;
    const entry = this.active;
    if (!entry || entry.finished) return;
    entry.job.requestCancel();
    entry.controller.abort();
  }

  private async run(entry: ActiveScan, scope: ResolvedScanScope): Promise<void> {
    const { job } = entry;
    const flusher = new ProgressFlusher((event) => this.onProgress?.(event), this.now);
    const tick = (): void => flusher.tick(job.progress);
    let unmatchedUpdates = 0;

    try {
      job.setPhase('discovering');
      tick();

      const signal = entry.controller.signal;
      const onBatch = (count: number): void => {
        job.record({ checkedFiles: count });
        tick();
      };
      job.record({ currentPath: scope.baseFolder });
      const baseEntries = await walkLibrary({
        root: scope.baseFolder,
        recursive: scope.recursive,
        excludeRoots: scope.updatesFolder === null ? [] : [scope.updatesFolder],
        signal,
        onBatch,
      });
      let updateEntries: LibraryFileEntry[] = [];
      if (scope.updatesFolder !== null) {
        job.record({ currentPath: scope.updatesFolder });
        updateEntries = await walkLibrary({
          root: scope.updatesFolder,
          recursive: scope.recursive,
          signal,
          onBatch,
        });
      }
      job.record({ candidateFiles: baseEntries.length + updateEntries.length });

      if (job.isCancelled) return this.complete(entry, flusher, unmatchedUpdates, null);

      job.setPhase('classifying');
      tick();
      const classified = classifyEntries(baseEntries, updateEntries, scope.mode, job);
      if (job.isCancelled) return this.complete(entry, flusher, unmatchedUpdates, null);

      // The container inspection runs off the renderer/main event loop. Cache
      // keys include the parser and encrypted-key revision so replacing keys
      // reevaluates every package without rewriting unchanged records.
      const keys = this.prodKeys?.read() ?? null;
      const keysRevision = this.prodKeys?.revision ?? 0;
      const inspections = new Map<string, { entry: LibraryFileEntry; titles: InspectedTitle[]; error: string | null }>();
      for (const item of [...baseEntries, ...updateEntries]) {
        if (job.isCancelled) break;
        job.record({ currentPath: item.path });
        tick();
        if (cachedInspection(this.db, item.path, item.sizeBytes, item.modifiedTime,
          INSPECTOR_VERSION, keysRevision)) {
          const hasBase = cachedHasBaseTitle(this.db, item.path);
          if (hasBase !== null) reclassify(classified,item,hasBase);
          continue;
        }
        try {
          const titles = await inspectInWorker(item.path, keys, signal);
          inspections.set(item.path, { entry: item, titles,
            error: titles.length ? null : keys ? 'No readable CNMT metadata' : 'Import prod.keys to inspect encrypted package metadata' });
          if (titles.length) {
            reclassify(classified,item,titles.some((title) => title.type === 'base'));
          }
        } catch (error) {
          if (job.isCancelled) break;
          inspections.set(item.path, { entry: item, titles: [],
            error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (job.isCancelled) return this.complete(entry, flusher, unmatchedUpdates, null);

      job.setPhase('matching');
      tick();
      if (job.isCancelled) return this.complete(entry, flusher, unmatchedUpdates, null);

      let reportedGames = 0;
      let reportedUpdates = 0;
      const summary = reconcileLibrary(this.db, {
        baseEntries: classified.base,
        updateEntries: classified.updates,
        mode: scope.mode,
        threshold: scope.threshold,
        updateSignal: () => job.isCancelled,
        onProgress: (progress) => {
          // Reconcile's base pass assembles the match candidates, so it belongs
          // to the matching phase; the update and prune passes are the writes
          // that reconcile the filesystem with SQLite.
          if (progress.stage === 'updates' || progress.stage === 'prune') job.setPhase('reconciling');
          job.record({
            gamesFound: progress.gamesFound - reportedGames,
            updatesFound: progress.updatesFound - reportedUpdates,
          });
          reportedGames = progress.gamesFound;
          reportedUpdates = progress.updatesFound;
          tick();
        },
      });
      if (!job.isCancelled) withTransaction(this.db, () => {
        for (const { entry: item, titles, error } of inspections.values()) recordInspection(this.db, {
          path: item.path, size: item.sizeBytes, mtime: item.modifiedTime,
          parserVersion: INSPECTOR_VERSION, keysRevision, titles, error,
        });
        resolveTitleParents(this.db);
        pruneMissingLocalFiles(this.db, existsSync);
      });
      job.record({
        gamesFound: summary.gamesFound - reportedGames,
        updatesFound: summary.updatesFound - reportedUpdates,
        currentPath: scope.updatesFolder ?? scope.baseFolder,
      });
      unmatchedUpdates = summary.unmatchedUpdates;
      return this.complete(entry, flusher, unmatchedUpdates, null);
    } catch (error) {
      const failure = toAppErrorDto(error);
      if (job.isCancelled && failure.code === 'JOB_CANCELLED') {
        return this.complete(entry, flusher, unmatchedUpdates, null);
      }
      this.logger?.error('scan.failed', {
        jobId: job.id,
        code: failure.code,
        reason: failure.message,
      });
      return this.complete(entry, flusher, unmatchedUpdates, failure);
    }
  }

  private complete(
    entry: ActiveScan,
    flusher: ProgressFlusher,
    unmatchedUpdates: number,
    error: AppErrorDto | null,
  ): void {
    if (entry.finished) return;
    const { job } = entry;
    const summary = job.finish({
      cancelled: job.isCancelled,
      unmatchedUpdates,
      elapsedMs: Math.max(0, this.now() - job.startedAt),
      error,
    });
    entry.finished = true;
    entry.summary = summary;

    flusher.flush(job.progress);
    this.onCompleted?.(summary);

    const fields = {
      jobId: job.id,
      checkedFiles: summary.checkedFiles,
      gamesFound: summary.gamesFound,
      updatesFound: summary.updatesFound,
      unmatchedUpdates: summary.unmatchedUpdates,
      elapsedMs: summary.elapsedMs,
    };
    if (summary.error) this.logger?.error('scan.completedWithError', { ...fields, error: summary.error });
    else if (summary.cancelled) this.logger?.info('scan.cancelled', fields);
    else this.logger?.info('scan.completed', fields);
  }

  private trimHistory(): void {
    for (const [id, entry] of this.jobs) {
      if (this.jobs.size <= JOB_HISTORY_LIMIT) break;
      if (entry.finished && entry !== this.active) this.jobs.delete(id);
    }
  }
}

function reclassify(classified: { base: LibraryFileEntry[]; updates: LibraryFileEntry[] },
  item: LibraryFileEntry, hasBase: boolean): void {
  const inBase = classified.base.findIndex((entry) => entry.path === item.path);
  const inUpdates = classified.updates.findIndex((entry) => entry.path === item.path);
  if (hasBase && inUpdates >= 0) {
    classified.updates.splice(inUpdates,1);
    classified.base.push(item);
  } else if (!hasBase && inBase >= 0) {
    classified.base.splice(inBase,1);
    classified.updates.push(item);
  }
}

/** Split mode trusts the roots; mixed mode reads the kind from the file name. */
function classifyEntries(
  baseEntries: LibraryFileEntry[],
  updateEntries: LibraryFileEntry[],
  mode: 'split' | 'mixed',
  job: ScanJob,
): { base: LibraryFileEntry[]; updates: LibraryFileEntry[] } {
  if (mode === 'split') return { base: baseEntries, updates: updateEntries };

  const base: LibraryFileEntry[] = [];
  const updates: LibraryFileEntry[] = [];
  for (const entry of baseEntries) {
    if (isUpdateOrDlcFilename(entry.fileName)) updates.push(entry);
    else base.push(entry);
    if ((base.length + updates.length) % CLASSIFY_BATCH_SIZE === 0 && job.isCancelled) break;
  }
  return { base, updates };
}

function resolveScanScope(input: ScanInput): ResolvedScanScope {
  const baseFolder = input.baseFolder?.trim() ?? '';
  if (!baseFolder) throw appError('VALIDATION_ERROR', 'baseFolder is required to scan the library');
  const basePath = assertFolder(baseFolder, 'baseFolder');

  const updatesFolder = input.updatesFolder?.trim() ?? '';
  let updatesPath: string | null = null;
  // `scanner._same_folder`: an empty or identical updates folder means the whole
  // library is scanned as one mixed folder.
  if (updatesFolder && resolve(basePath) !== resolve(updatesFolder)) {
    updatesPath = assertFolder(updatesFolder, 'updatesFolder');
  }

  const threshold = input.threshold ?? DEFAULT_FUZZY_MATCH_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw appError('VALIDATION_ERROR', 'threshold must be a number between 0 and 1', {
      details: { threshold: input.threshold },
    });
  }
  const recursive = input.recursive ?? true;

  return {
    baseFolder: basePath,
    updatesFolder: updatesPath,
    recursive,
    threshold,
    mode: updatesPath === null ? 'mixed' : 'split',
    key: JSON.stringify({ base: basePath, updates: updatesPath, recursive, threshold }),
  };
}

function assertFolder(folder: string, label: 'baseFolder' | 'updatesFolder'): string {
  const path = resolve(folder);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw appError('VALIDATION_ERROR', `${label} does not exist or is not a folder`, { details: { folder } });
  }
  return path;
}
