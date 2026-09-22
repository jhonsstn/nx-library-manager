import { existsSync, statfsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import { MTP_TRANSFER_TIMEOUT_SECONDS } from '../../shared/constants';
import type { CreateInstallInput, InstallDestination } from '../../shared/contracts/api';
import { SwitchCatalogError, appError, toAppErrorDto } from '../../shared/errors/app-error';
import type { AppErrorDto } from '../../shared/errors/codes';
import { formatBytes } from '../../shared/format/bytes';
import { isShellPath } from '../../shared/format/install';
import { rawVersionFromVersionText } from '../../shared/format/versions';
import { CreateInstallInputSchema } from '../../shared/schemas/inputs';
import type { GameFileKind, InstallDestinationType, InstallJobDto } from '../../shared/types/domain';
import type { AppSettings } from '../../shared/types/settings';
import type { AppDatabase } from '../db/database';
import { withTransaction } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { MtpAdapter, MtpStorageDestination, MtpTransferState } from '../mtp/mtp.adapter';
import { findGameFileByPath, getBaseFile, updateGameFilePath } from '../repositories/game-files.repository';
import {
  getInstallJob,
  insertInstallJob,
  listInstallJobs,
  listJobsByStatus,
  markInterruptedJobsFailed,
  updateInstallJob,
  type InstallJobUpdate,
} from '../repositories/install-jobs.repository';
import { getUpdate, listAllUpdates, updateUpdatePath, type UpdateRecord } from '../repositories/updates.repository';
import { detectVersion, isDlcGroupFilename } from '../scanner/filename-parser';
import { moveFileToFolder } from './file.service';

export interface ResolvedInstallDestination {
  folder: string;
  label: string | null;
  type: InstallDestinationType;
  storage: MtpStorageDestination | null;
}

export interface InstallServiceOptions {
  db: AppDatabase;
  mtp: MtpAdapter;
  settings: { getFull(): AppSettings };
  logger?: Logger;
  /** Live queue updates for the renderer (`install:changed`). */
  onJobChanged?: (job: InstallJobDto) => void;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
  /** Test seam for destination free space; `null` means "could not be verified". */
  freeSpace?: (folder: string) => Promise<number | null>;
}

/** One file scheduled for transfer, before it becomes an `install_jobs` row. */
interface QueueItem {
  gameId: number | null;
  sourcePath: string;
  fileName: string;
  fileSize: number;
  fileKind: GameFileKind;
  detectedVersion: string;
  rawVersion: number;
}

/**
 * Persistent install queue for local-folder and MTP destinations.
 *
 * At most one transfer is active at a time, so ordering and progress stay
 * truthful: folder moves report real byte counts, while MTP transfers report
 * state transitions only (`MtpTransferState`) because the PowerShell mechanism
 * cannot measure bytes.
 */
export class InstallService {
  private readonly db: AppDatabase;
  private readonly mtp: MtpAdapter;
  private readonly settings: { getFull(): AppSettings };
  private readonly logger: Logger | undefined;
  private readonly onJobChanged: ((job: InstallJobDto) => void) | undefined;
  private readonly now: () => number;
  private readonly freeSpace: ((folder: string) => Promise<number | null>) | undefined;

  private activePump: Promise<void> | null = null;
  private activeLocalTransfer: { jobId: number; controller: AbortController } | null = null;
  private cancelRequestedJobId: number | null = null;
  /** Stops the queue after the active operation settles or is cancelled. */
  private stopQueue = false;
  /** Set by `shutdown`: no new jobs, and the pump stops after the running transfer. */
  private shuttingDown = false;

  constructor(options: InstallServiceOptions) {
    this.db = options.db;
    this.mtp = options.mtp;
    this.settings = options.settings;
    this.logger = options.logger;
    this.onJobChanged = options.onJobChanged;
    this.now = options.now ?? Date.now;
    this.freeSpace = options.freeSpace;
  }

  /**
   * Startup recovery (spec 08): rows left `running` by a crash become `failed`.
   * Pending rows stay queued; the next pump drops the ones whose source is gone
   * and never resumes an MTP write on its own.
   */
  recoverInterrupted(): number {
    const interrupted = markInterruptedJobsFailed(this.db);
    if (interrupted > 0) {
      this.logger?.warn('install.recoveredInterruptedJobs', { count: interrupted });
    } else {
      this.logger?.debug('install.recoveryClean');
    }
    return interrupted;
  }

  /** Resolves a renderer destination request against the live MTP storage list. */
  async resolveDestination(destination: InstallDestination): Promise<ResolvedInstallDestination> {
    if (destination.type === 'folder') {
      const path = destination.path;
      if (!isAbsolute(path)) {
        throw appError('PATH_NOT_ALLOWED', `The install folder must be an absolute path: ${path}`, {
          details: { path },
        });
      }
      this.logger?.info('install.destinationResolved', {
        destinationType: 'folder',
        folder: path,
        defaultDestination: this.settings.getFull().defaultInstallDestination,
      });
      return { folder: path, label: null, type: 'folder', storage: null };
    }

    const storages = await this.listStorages();
    if (storages.length === 0) {
      throw appError('MTP_NOT_CONNECTED', 'No MTP install destination is available. Connect the console and refresh.');
    }
    const storage = storages.find((candidate) => candidate.id === destination.storage);
    if (!storage) {
      throw appError(
        'MTP_DESTINATION_NOT_FOUND',
        `The requested MTP storage (${destination.storage.toUpperCase()}) is not available.`,
        { details: { storage: destination.storage, available: storages.map((candidate) => candidate.id) } },
      );
    }
    const type: InstallDestinationType = storage.id === 'sd' ? 'mtp-sd' : 'mtp-nand';
    this.logger?.info('install.destinationResolved', {
      destinationType: type,
      folder: storage.shellPath,
      defaultDestination: this.settings.getFull().defaultInstallDestination,
    });
    return { folder: storage.shellPath, label: storage.label, type, storage };
  }

  /**
   * Builds the ordered queue for a request, validates it, persists one `pending`
   * job per file and starts the pump. Order is base game → updates (oldest
   * version first, then file name) → DLC (spec 08).
   */
  async create(input: CreateInstallInput): Promise<InstallJobDto[]> {
    this.assertAcceptingJobs();
    const parsed = CreateInstallInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw appError('VALIDATION_ERROR', `Invalid install request: ${issues[0]?.message ?? 'unknown problem'}`, {
        details: { issues },
      });
    }

    const gameId = parsed.data.gameId ?? null;
    const destination = await this.resolveDestination(parsed.data.destination);
    const items = this.buildItems({
      gameId,
      updateIds: parsed.data.updateIds,
      includeBaseFile: parsed.data.includeBaseFile !== false,
    });

    this.assertSourcesExist(items);
    await this.assertFreeSpace(destination, items.reduce((total, item) => total + item.fileSize, 0));

    const jobIds = withTransaction(this.db, () =>
      items.map((item) =>
        insertInstallJob(this.db, {
          gameId: item.gameId,
          sourcePath: item.sourcePath,
          destinationFolder: destination.folder,
          destinationLabel: destination.label,
          destinationType: destination.type,
          fileName: item.fileName,
          fileSize: item.fileSize,
          fileKind: item.fileKind,
          detectedVersion: item.detectedVersion,
          rawVersion: item.rawVersion,
        }),
      ),
    );

    const jobs = jobIds.map((jobId) => this.readJob(jobId));
    for (const job of jobs) this.emit(job);
    this.logger?.info('install.queueCreated', {
      jobs: jobs.length,
      gameId: gameId ?? undefined,
      destinationType: destination.type,
    });
    this.startPump();
    return jobs;
  }

  getJobs(): InstallJobDto[] {
    return listInstallJobs(this.db);
  }

  /**
   * Re-queues failed jobs whose source file still exists. The original rows are
   * kept as history; each retry is a fresh job (spec 08: retry the failed
   * portion).
   */
  async retryFailed(): Promise<InstallJobDto[]> {
    this.assertAcceptingJobs();
    const retryable: InstallJobDto[] = [];
    let skipped = 0;
    for (const job of listJobsByStatus(this.db, ['failed'])) {
      if (this.sourceExists(job.sourcePath)) retryable.push(job);
      else skipped += 1;
    }
    if (retryable.length === 0) {
      this.logger?.info('install.retryNothingToDo', { skipped });
      return [];
    }

    const jobIds = withTransaction(this.db, () =>
      retryable.map((job) =>
        insertInstallJob(this.db, {
          gameId: job.gameId,
          sourcePath: job.sourcePath,
          destinationFolder: job.destinationFolder,
          destinationLabel: job.destinationLabel,
          destinationType: job.destinationType,
          fileName: job.displayName,
          fileSize: job.sizeBytes,
          fileKind: job.fileKind,
          detectedVersion: job.detectedVersion,
          rawVersion: job.rawVersion,
        }),
      ),
    );

    const jobs = jobIds.map((jobId) => this.readJob(jobId));
    for (const job of jobs) this.emit(job);
    this.logger?.info('install.retryQueued', { jobs: jobs.length, skipped });
    this.startPump();
    return jobs;
  }

  /**
   * Cancels a queued job, or aborts a running folder transfer safely.
   * A running MTP transfer is never marked cancelled: the PowerShell copy cannot
   * be safely interrupted (spec 14).
   */
  async cancel(jobId: number): Promise<void> {
    const job = getInstallJob(this.db, jobId);
    if (!job) throw appError('NOT_FOUND', `No install job with id ${jobId}.`);

    if (job.status === 'pending') {
      this.updateStatus(jobId, { status: 'cancelled' });
      this.logger?.info('install.jobCancelled', { installJobId: jobId });
      return;
    }
    if (job.status === 'running') {
      if (job.destinationType !== 'folder') {
        this.logger?.warn('install.cancelUnsupported', {
          installJobId: jobId,
          destinationType: job.destinationType,
          reason: 'the MTP transfer cannot be safely interrupted',
        });
        return;
      }
      this.stopQueue = true;
      this.cancelRequestedJobId = jobId;
      if (this.activeLocalTransfer?.jobId === jobId) this.activeLocalTransfer.controller.abort();
      this.logger?.info('install.localCancelRequested', { installJobId: jobId });
      return;
    }
    this.logger?.debug('install.cancelIgnored', { installJobId: jobId, status: job.status });
  }

  /** Waits for the in-flight queue work; used by shutdown and tests. */
  async whenIdle(): Promise<void> {
    while (this.activePump) {
      await this.activePump;
    }
  }

  get isBusy(): boolean {
    return this.activePump !== null;
  }

  /**
   * Application shutdown (spec 01): reject new work and let the queue stop once
   * the transfer already running settles. Nothing is aborted mid-write and
   * pending rows are left untouched for the next launch.
   */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopQueue = true;
    this.logger?.info('install.shutdown', { pumpActive: this.activePump !== null });
  }

  /** Ordered queue for one request: base game, then updates, then DLC. */
  private buildItems(input: { gameId: number | null; updateIds: number[]; includeBaseFile: boolean }): QueueItem[] {
    const items: QueueItem[] = [];
    if (input.gameId !== null && input.includeBaseFile) {
      const base = getBaseFile(this.db, input.gameId);
      if (!base) throw appError('NOT_FOUND', `No base game file is recorded for game ${input.gameId}.`);
      items.push({
        gameId: input.gameId,
        sourcePath: base.filePath,
        fileName: base.fileName,
        fileSize: base.fileSize,
        fileKind: 'base',
        detectedVersion: '',
        rawVersion: rawVersionFromVersionText(detectVersion(base.fileName)),
      });
    }
    items.push(...this.updateItems(input.gameId, input.updateIds));
    return items;
  }

  private updateItems(gameId: number | null, updateIds: number[]): QueueItem[] {
    const pending: Array<{ item: QueueItem; dlc: boolean }> = [];
    const seen = new Set<number>();
    for (const updateId of updateIds) {
      if (seen.has(updateId)) continue;
      seen.add(updateId);
      const update = this.requireUpdate(updateId, gameId);
      const dlc = isDlcGroupFilename(update.fileName);
      pending.push({
        dlc,
        item: {
          gameId: gameId ?? update.gameId,
          sourcePath: update.filePath,
          fileName: update.fileName,
          fileSize: update.fileSize,
          fileKind: dlc ? 'dlc' : 'update',
          detectedVersion: update.detectedVersion,
          rawVersion: rawVersionFromVersionText(detectVersion(update.fileName)),
        },
      });
    }
    const sorted = pending.slice().sort((a, b) => {
      const byVersion = a.item.rawVersion - b.item.rawVersion;
      if (byVersion !== 0) return byVersion;
      // Keep ordering byte-wise and independent of the host locale.
      if (a.item.fileName === b.item.fileName) return 0;
      return a.item.fileName < b.item.fileName ? -1 : 1;
    });
    return [...sorted.filter((entry) => !entry.dlc), ...sorted.filter((entry) => entry.dlc)].map(
      (entry) => entry.item,
    );
  }

  private requireUpdate(updateId: number, gameId: number | null): UpdateRecord {
    const update = getUpdate(this.db, updateId);
    if (!update) throw appError('NOT_FOUND', `No update or DLC file with id ${updateId}.`);
    if (gameId !== null && update.gameId !== null && update.gameId !== gameId) {
      throw appError('NOT_FOUND', `${update.fileName} belongs to another game.`, {
        details: { updateId, gameId: update.gameId, requestedGameId: gameId },
      });
    }
    return update;
  }

  private assertSourcesExist(items: QueueItem[]): void {
    for (const item of items) {
      if (this.sourceExists(item.sourcePath)) continue;
      throw appError('FILE_MISSING', `Missing source file: ${item.fileName} (${item.sourcePath})`, {
        details: { sourcePath: item.sourcePath, fileName: item.fileName },
      });
    }
  }

  private async assertFreeSpace(destination: ResolvedInstallDestination, totalBytes: number): Promise<void> {
    if (totalBytes <= 0) return;
    const availableBytes = await this.availableBytes(destination);
    if (availableBytes === null) return;
    if (totalBytes <= availableBytes) return;
    const where = destination.label ?? destination.folder;
    throw appError(
      'VALIDATION_ERROR',
      `Not enough free space in ${where}: needed ${formatBytes(totalBytes)}, available ${formatBytes(availableBytes)}.`,
      { details: { neededBytes: totalBytes, availableBytes } },
    );
  }

  /** `null` means free space could not be determined; the install may proceed. */
  private async availableBytes(destination: ResolvedInstallDestination): Promise<number | null> {
    if (destination.type !== 'folder') {
      const storage = destination.storage;
      if (!storage || !Number.isFinite(storage.freeBytes) || storage.freeBytes <= 0) {
        this.logger?.warn('install.freeSpaceUnknown', {
          destinationType: destination.type,
          storageId: storage?.id ?? null,
        });
        return null;
      }
      return storage.freeBytes;
    }

    try {
      const measured = this.freeSpace
        ? await this.freeSpace(destination.folder)
        : folderFreeBytes(destination.folder);
      if (measured === null || !Number.isFinite(measured)) {
        this.logger?.warn('install.freeSpaceUnknown', { folder: destination.folder });
        return null;
      }
      return measured;
    } catch (error) {
      this.logger?.warn('install.freeSpaceUnavailable', {
        folder: destination.folder,
        error: describeError(error),
      });
      return null;
    }
  }

  private sourceExists(sourcePath: string): boolean {
    if (isShellPath(sourcePath)) return true;
    return existsSync(sourcePath);
  }

  private assertAcceptingJobs(): void {
    if (this.shuttingDown) {
      throw appError('JOB_CANCELLED', 'The application is shutting down; no new install jobs were queued.');
    }
  }

  private startPump(): void {
    if (this.activePump) return;
    const pump = this.runPump();
    this.activePump = pump;
    void pump.then(() => {
      if (this.activePump === pump) this.activePump = null;
    });
  }

  /** Drains pending jobs in id order, one transfer at a time. Never rejects. */
  private async runPump(): Promise<void> {
    try {
      for (;;) {
        if (this.stopQueue || this.shuttingDown) break;
        const job = this.nextPendingJob();
        if (!job) break;
        if (!this.sourceExists(job.sourcePath)) {
          this.failJob(
            job,
            appError('FILE_MISSING', `Missing source file: ${job.displayName} (${job.sourcePath})`),
          );
          continue;
        }
        try {
          await this.executeJob(job);
        } catch (error) {
          const dto = toAppErrorDto(error);
          if (dto.code === 'JOB_CANCELLED') this.cancelJob(job, dto);
          else this.failJob(job, dto);
          break; // spec 08: a failed transfer stops the rest of the queue
        }
        if (this.stopQueue || this.shuttingDown) break;
      }
    } catch (error) {
      this.logger?.error('install.queueFailed', { error: describeError(error) });
    } finally {
      if (!this.shuttingDown) this.stopQueue = false;
    }
  }

  private nextPendingJob(): InstallJobDto | null {
    return listJobsByStatus(this.db, ['pending'])[0] ?? null;
  }

  private async executeJob(job: InstallJobDto): Promise<void> {
    this.updateStatus(job.id, { status: 'running' });
    this.logger?.info('install.itemStarted', {
      installJobId: job.id,
      fileName: job.displayName,
      destinationType: job.destinationType,
      sizeBytes: job.sizeBytes,
    });
    if (job.destinationType === 'folder') await this.moveToFolder(job);
    else await this.copyToMtp(job);
  }

  /** Folder install: real move, then the catalog rows follow the file. */
  private async moveToFolder(job: InstallJobDto): Promise<void> {
    const controller = new AbortController();
    this.activeLocalTransfer = { jobId: job.id, controller };
    if (this.cancelRequestedJobId === job.id) controller.abort();
    let lastProgressAt = 0;
    try {
      const destinationPath = await moveFileToFolder(job.sourcePath, job.destinationFolder, {
        signal: controller.signal,
        onProgress: (transferredBytes) => {
          const now = this.now();
          if (transferredBytes < job.sizeBytes && now - lastProgressAt < 200) return;
          lastProgressAt = now;
          this.updateStatus(job.id, { status: 'running', transferredBytes });
        },
      });
      this.applyFolderDestination(job, destinationPath);
      this.finishJob(job, destinationPath, job.sizeBytes);
    } finally {
      if (this.activeLocalTransfer?.jobId === job.id) this.activeLocalTransfer = null;
      if (this.cancelRequestedJobId === job.id) this.cancelRequestedJobId = null;
    }
  }

  private async copyToMtp(job: InstallJobDto): Promise<void> {
    const storage = await this.requireMtpStorage(job);
    const onStateChange = (state: MtpTransferState): void => {
      this.logger?.debug('install.mtpState', { installJobId: job.id, fileName: job.displayName, state });
    };
    try {
      await this.mtp.copyFile({
        sourcePath: job.sourcePath,
        destination: storage,
        fileName: job.displayName,
        totalBytes: job.sizeBytes,
        timeoutSeconds: MTP_TRANSFER_TIMEOUT_SECONDS,
        onStateChange,
      });
    } catch (error) {
      throw appError('MTP_COPY_FAILED', `${job.displayName}: ${describeError(error)}`, {
        retryable: true,
        cause: error,
      });
    }
    // The PowerShell handoff cannot report bytes; the completed size is the
    // only honest figure and the source file stays where it is.
    this.finishJob(job, null, job.sizeBytes);
  }

  /**
   * Ports `ui.apply_install_destination`: the base file updates `game_files`,
   * updates and DLC update `updates`; the name is only rewritten when the
   * conflict-free destination actually renamed the file.
   */
  private applyFolderDestination(job: InstallJobDto, destinationPath: string): void {
    const fileName = basename(destinationPath) || job.displayName;
    const modifiedTime = this.modifiedTimeFor(destinationPath);

    if (job.fileKind === 'base') {
      const file = findGameFileByPath(this.db, job.sourcePath);
      if (!file) {
        this.logger?.warn('install.catalogRowMissing', { installJobId: job.id, sourcePath: job.sourcePath });
        return;
      }
      updateGameFilePath(this.db, file.id, {
        filePath: destinationPath,
        fileName,
        fileExtension: extname(fileName).toLowerCase(),
        modifiedTime,
      });
      return;
    }

    const update = listAllUpdates(this.db).find((row) => row.filePath === job.sourcePath);
    if (!update) {
      this.logger?.warn('install.catalogRowMissing', { installJobId: job.id, sourcePath: job.sourcePath });
      return;
    }
    updateUpdatePath(this.db, update.id, { filePath: destinationPath, fileName, modifiedTime });
  }

  private async requireMtpStorage(job: InstallJobDto): Promise<MtpStorageDestination> {
    const storages = await this.listStorages();
    const wanted = job.destinationType === 'mtp-sd' ? 'sd' : 'nand';
    const storage =
      storages.find((candidate) => candidate.shellPath === job.destinationFolder) ??
      storages.find((candidate) => candidate.id === wanted);
    if (!storage) {
      throw appError(
        'MTP_DESTINATION_NOT_FOUND',
        `The install destination is no longer available: ${job.destinationLabel ?? job.destinationFolder}`,
        { retryable: true, details: { destinationFolder: job.destinationFolder } },
      );
    }
    return storage;
  }

  private async listStorages(): Promise<MtpStorageDestination[]> {
    try {
      return await this.mtp.listInstallDestinations();
    } catch (error) {
      if (error instanceof SwitchCatalogError) throw error;
      throw appError('MTP_NOT_CONNECTED', 'Could not read the MTP install destinations.', { cause: error });
    }
  }

  private finishJob(job: InstallJobDto, destinationPath: string | null, transferredBytes: number): void {
    this.updateStatus(job.id, { status: 'completed', destinationPath, transferredBytes });
    this.logger?.info('install.itemCompleted', {
      installJobId: job.id,
      fileName: job.displayName,
      destinationPath,
      transferredBytes,
      sizeBytes: job.sizeBytes,
    });
  }

  private failJob(job: InstallJobDto, error: AppErrorDto): void {
    this.updateStatus(job.id, { status: 'failed', error });
    this.logger?.error('install.itemFailed', {
      installJobId: job.id,
      fileName: job.displayName,
      code: error.code,
      message: error.message,
    });
  }

  private cancelJob(job: InstallJobDto, error: AppErrorDto): void {
    this.updateStatus(job.id, { status: 'cancelled', error });
    this.logger?.info('install.itemCancelled', { installJobId: job.id, fileName: job.displayName });
  }

  private updateStatus(jobId: number, update: InstallJobUpdate): InstallJobDto {
    updateInstallJob(this.db, jobId, update);
    const job = this.readJob(jobId);
    this.emit(job);
    return job;
  }

  private readJob(jobId: number): InstallJobDto {
    const job = getInstallJob(this.db, jobId);
    if (!job) throw appError('DATABASE_ERROR', `Install job ${jobId} disappeared.`);
    return job;
  }

  private emit(job: InstallJobDto): void {
    if (!this.onJobChanged) return;
    try {
      this.onJobChanged(job);
    } catch (error) {
      this.logger?.warn('install.listenerFailed', { installJobId: job.id, error: describeError(error) });
    }
  }

  /** Mirrors `ui._installed_file_metadata`'s timestamp fallback. */
  private modifiedTimeFor(destinationPath: string): number {
    try {
      return statSync(destinationPath).mtimeMs;
    } catch {
      return this.now();
    }
  }
}

/** `shutil.disk_usage(folder).free` equivalent; `null` when it cannot be read. */
function folderFreeBytes(folder: string): number {
  const stats = statfsSync(folder);
  return Number(stats.bavail) * Number(stats.bsize);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
