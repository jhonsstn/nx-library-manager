import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEMP_ROOT } from '../../setup/vitest.setup';
import { closeDatabase, openDatabase, type AppDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import type {
  MtpAdapter,
  MtpCopyInput,
  MtpStatus,
  MtpStorageDestination,
  MtpTransferState,
  ShellFolderSelection,
} from '@main/mtp/mtp.adapter';
import { getBaseFile, upsertBaseGameFile } from '@main/repositories/game-files.repository';
import { upsertGameByCleanedTitle } from '@main/repositories/games.repository';
import { getInstallJob, insertInstallJob, listJobsByStatus, updateInstallJob } from '@main/repositories/install-jobs.repository';
import { getUpdate, listAllUpdates, upsertUpdate } from '@main/repositories/updates.repository';
import { detectVersion } from '@main/scanner/filename-parser';
import { InstallService } from '@main/services/install.service';
import { defaultAppSettings } from '@shared/schemas/settings';
import type { InstallJobDto } from '@shared/types/domain';
import type { AppSettings } from '@shared/types/settings';

const BASE_NAME = 'Hades.nsp';
const EARLY_UPDATE_NAME = 'Hades [v131072].nsp';
const LATE_UPDATE_NAME = 'Hades [v262144].nsp';
/** Alphabetically first *and* the lowest version: only the DLC rule can place it last. */
const DLC_NAME = 'AAA Hades DLC [v65536].nsp';

const SD_STORAGE: MtpStorageDestination = {
  id: 'sd',
  name: 'SD install',
  label: 'SD Card install',
  shellPath: 'shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\Switch\\SD install',
  freeBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
};

const NAND_STORAGE: MtpStorageDestination = {
  id: 'nand',
  name: 'NAND Install',
  label: 'NAND install',
  shellPath: 'shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\Switch\\NAND Install',
  freeBytes: 16 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
};

/** Records call order and overlap so queue serialization is observable. */
class FakeMtpAdapter implements MtpAdapter {
  storages: MtpStorageDestination[] = [];
  started: string[] = [];
  completed: string[] = [];
  states: MtpTransferState[] = [];
  failOn: string | null = null;
  /** When true every copy blocks until `release()` is called. */
  hold = false;
  active = 0;
  maxActive = 0;

  private readonly gates: Array<() => void> = [];

  private notify(input: MtpCopyInput, state: MtpTransferState): void {
    this.states.push(state);
    input.onStateChange?.(state);
  }

  async isAvailable(): Promise<boolean> {
    return this.storages.length > 0;
  }

  async listInstallDestinations(): Promise<MtpStorageDestination[]> {
    return this.storages.map((storage) => ({ ...storage }));
  }

  async getStatus(): Promise<MtpStatus> {
    return {
      available: this.storages.length > 0,
      adapter: 'powershell',
      storages: await this.listInstallDestinations(),
      checkedAt: new Date(0).toISOString(),
      error: null,
    };
  }

  async copyFile(input: MtpCopyInput): Promise<void> {
    this.started.push(input.fileName);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.notify(input, 'preparing');
    try {
      if (this.hold) await new Promise<void>((resolve) => this.gates.push(resolve));
      // Yielding lets a non-serialized pump show up in `maxActive`.
      else await Promise.resolve();
      this.notify(input, 'copying');
      if (this.failOn === input.fileName) throw new Error(`copy failed: ${input.fileName}`);
      this.notify(input, 'completed');
      this.completed.push(input.fileName);
    } finally {
      this.active -= 1;
    }
  }

  async pickShellFolder(): Promise<ShellFolderSelection | null> {
    return null;
  }

  release(): void {
    for (const gate of this.gates.splice(0)) gate();
  }
}

let directory: string;
let sourceDir: string;
let installDir: string;
let db: AppDatabase;
let adapter: FakeMtpAdapter;
let settings: AppSettings;

beforeEach(() => {
  directory = mkdtempSync(join(TEMP_ROOT, 'install-'));
  sourceDir = join(directory, 'library');
  installDir = join(directory, 'install');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  const databaseFile = join(directory, 'catalog.db');
  db = openDatabase(databaseFile);
  runMigrations(db, databaseFile);
  adapter = new FakeMtpAdapter();
  settings = defaultAppSettings();
});

afterEach(() => {
  adapter.release();
  closeDatabase(db);
  rmSync(directory, { recursive: true, force: true });
});

function createService(
  options: {
    freeSpace?: (folder: string) => Promise<number | null>;
    onJobChanged?: (job: InstallJobDto) => void;
  } = {},
): InstallService {
  return new InstallService({
    db,
    mtp: adapter,
    settings: { getFull: () => settings },
    onJobChanged: options.onJobChanged,
    freeSpace: options.freeSpace,
  });
}

function writeSource(name: string, sizeBytes: number): string {
  const path = join(sourceDir, name);
  writeFileSync(path, Buffer.alloc(sizeBytes, 7));
  return path;
}

function seedGame(title: string): number {
  return upsertGameByCleanedTitle(db, { displayTitle: title, cleanedTitle: title });
}

function seedBase(gameId: number, name: string, sizeBytes: number): { id: number; path: string } {
  const path = writeSource(name, sizeBytes);
  const id = upsertBaseGameFile(db, {
    gameId,
    filePath: path,
    fileName: name,
    fileExtension: '.nsp',
    fileSize: sizeBytes,
    modifiedTime: Date.now(),
    fileType: 'nsp',
  });
  return { id, path };
}

function seedUpdate(gameId: number | null, name: string, sizeBytes: number): { id: number; path: string } {
  const path = writeSource(name, sizeBytes);
  upsertUpdate(db, {
    gameId,
    filePath: path,
    fileName: name,
    detectedVersion: detectVersion(name),
    fileSize: sizeBytes,
    modifiedTime: Date.now(),
    matchConfidence: 1,
  });
  const row = listAllUpdates(db).find((update) => update.filePath === path);
  if (!row) throw new Error(`update ${name} was not stored`);
  return { id: row.id, path };
}

/** Builds the base + two updates + one DLC library used by most cases. */
function seedLibrary(): {
  gameId: number;
  base: { id: number; path: string };
  early: { id: number; path: string };
  late: { id: number; path: string };
  dlc: { id: number; path: string };
} {
  const gameId = seedGame('Hades');
  const base = seedBase(gameId, BASE_NAME, 1000);
  const early = seedUpdate(gameId, EARLY_UPDATE_NAME, 2000);
  const late = seedUpdate(gameId, LATE_UPDATE_NAME, 3000);
  const dlc = seedUpdate(gameId, DLC_NAME, 4000);
  return { gameId, base, early, late, dlc };
}

const FOLDER_DESTINATION = (): { type: 'folder'; path: string } => ({ type: 'folder', path: installDir });
const MTP_DESTINATION = (storage: 'sd' | 'nand' = 'sd'): { type: 'mtp'; storage: 'sd' | 'nand' } => ({
  type: 'mtp',
  storage,
});

describe('install queue ordering', () => {
  it('queues base, then updates oldest-first, then DLC regardless of name', async () => {
    const { gameId, late, early, dlc } = seedLibrary();
    const runningOrder: string[] = [];
    const service = createService({
      onJobChanged: (job) => {
        if (job.status === 'running') runningOrder.push(job.displayName);
      },
    });

    const jobs = await service.create({
      gameId,
      // Deliberately scrambled input order.
      updateIds: [late.id, dlc.id, early.id],
      destination: FOLDER_DESTINATION(),
    });

    expect(jobs.map((job) => job.displayName)).toEqual([
      BASE_NAME,
      EARLY_UPDATE_NAME,
      LATE_UPDATE_NAME,
      DLC_NAME,
    ]);
    expect(jobs.map((job) => job.fileKind)).toEqual(['base', 'update', 'update', 'dlc']);
    expect(jobs.map((job) => job.rawVersion)).toEqual([0, 131072, 262144, 65536]);
    expect(jobs.every((job) => job.status === 'pending')).toBe(true);

    await service.whenIdle();
    expect(runningOrder).toEqual([BASE_NAME, EARLY_UPDATE_NAME, LATE_UPDATE_NAME, DLC_NAME]);
    expect(listJobsByStatus(db, ['completed'])).toHaveLength(4);
  });

  it('queues updates only when the base file is excluded', async () => {
    const { gameId, base, early, late, dlc } = seedLibrary();
    const service = createService();

    const jobs = await service.create({
      gameId,
      updateIds: [early.id, late.id, dlc.id],
      includeBaseFile: false,
      destination: FOLDER_DESTINATION(),
    });

    expect(jobs.map((job) => job.displayName)).toEqual([EARLY_UPDATE_NAME, LATE_UPDATE_NAME, DLC_NAME]);
    expect(jobs.some((job) => job.fileKind === 'base')).toBe(false);

    await service.whenIdle();
    expect(existsSync(base.path)).toBe(true);
    expect(existsSync(join(installDir, BASE_NAME))).toBe(false);
  });

  it('rejects an update that belongs to another game', async () => {
    const { gameId, early } = seedLibrary();
    const otherGame = seedGame('Other Game');
    const foreign = seedUpdate(otherGame, 'Other [v131072].nsp', 500);
    const service = createService();

    await expect(
      service.create({ gameId, updateIds: [early.id, foreign.id], destination: FOLDER_DESTINATION() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await service.whenIdle();
    expect(listJobsByStatus(db, ['pending'])).toHaveLength(0);
  });
});

describe('install destination resolution', () => {
  it('reports MTP_NOT_CONNECTED when no storage is available', async () => {
    const { gameId } = seedLibrary();
    const service = createService();

    await expect(
      service.create({ gameId, updateIds: [], destination: MTP_DESTINATION('sd') }),
    ).rejects.toMatchObject({ code: 'MTP_NOT_CONNECTED' });
    expect(service.getJobs()).toHaveLength(0);
  });

  it('reports MTP_DESTINATION_NOT_FOUND when the requested storage is absent', async () => {
    const { gameId } = seedLibrary();
    adapter.storages = [NAND_STORAGE];
    const service = createService();

    await expect(
      service.create({ gameId, updateIds: [], destination: MTP_DESTINATION('sd') }),
    ).rejects.toMatchObject({ code: 'MTP_DESTINATION_NOT_FOUND' });
  });

  it('resolves each storage to its shell path and destination type', async () => {
    adapter.storages = [SD_STORAGE, NAND_STORAGE];
    const service = createService();

    await expect(
      service.resolveDestination(MTP_DESTINATION('sd')),
    ).resolves.toEqual({
      folder: SD_STORAGE.shellPath,
      label: 'SD Card install',
      type: 'mtp-sd',
      storage: SD_STORAGE,
    });
    await expect(
      service.resolveDestination(MTP_DESTINATION('nand')),
    ).resolves.toMatchObject({
      folder: NAND_STORAGE.shellPath,
      label: 'NAND install',
      type: 'mtp-nand',
    });
    await expect(service.resolveDestination(FOLDER_DESTINATION())).resolves.toEqual({
      folder: installDir,
      label: null,
      type: 'folder',
      storage: null,
    });
  });

  it('rejects a relative install folder', async () => {
    const { gameId } = seedLibrary();
    const service = createService();

    await expect(
      service.create({ gameId, updateIds: [], destination: { type: 'folder', path: 'relative/install' } }),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
  });
});

describe('install validation', () => {
  it('reports FILE_MISSING when a source disappears before create', async () => {
    const { gameId, early } = seedLibrary();
    unlinkSync(early.path);
    const service = createService();

    await expect(
      service.create({ gameId, updateIds: [early.id], destination: FOLDER_DESTINATION() }),
    ).rejects.toMatchObject({
      code: 'FILE_MISSING',
      message: expect.stringContaining(EARLY_UPDATE_NAME),
    });
    expect(service.getJobs()).toHaveLength(0);
  });

  it('rejects an install that does not fit the destination', async () => {
    const { gameId, early } = seedLibrary();
    const service = createService({ freeSpace: async () => 2500 });

    await expect(
      service.create({ gameId, updateIds: [early.id], destination: FOLDER_DESTINATION() }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { neededBytes: 3000, availableBytes: 2500 },
    });
    expect(service.getJobs()).toHaveLength(0);
  });

  it('allows the install when free space cannot be determined', async () => {
    const { gameId, early } = seedLibrary();
    const service = createService({ freeSpace: async () => null });

    const jobs = await service.create({ gameId, updateIds: [early.id], destination: FOLDER_DESTINATION() });
    expect(jobs).toHaveLength(2);

    await service.whenIdle();
    expect(listJobsByStatus(db, ['completed'])).toHaveLength(2);
  });
});

describe('install queue execution', () => {
  it('runs MTP transfers one at a time and reports bytes only on completion', async () => {
    const { gameId, base, early, late } = seedLibrary();
    adapter.storages = [SD_STORAGE];
    const service = createService();

    const jobs = await service.create({
      gameId,
      updateIds: [late.id, early.id],
      destination: MTP_DESTINATION('sd'),
    });
    await service.whenIdle();

    expect(adapter.started).toEqual([BASE_NAME, EARLY_UPDATE_NAME, LATE_UPDATE_NAME]);
    expect(adapter.maxActive).toBe(1);
    expect(adapter.completed).toEqual(adapter.started);
    expect(adapter.states.slice(0, 3)).toEqual(['preparing', 'copying', 'completed']);

    const completed = jobs.map((job) => getInstallJob(db, job.id)!);
    expect(completed.map((job) => job.status)).toEqual(['completed', 'completed', 'completed']);
    expect(completed.map((job) => job.transferredBytes)).toEqual([1000, 2000, 3000]);
    expect(completed.every((job) => job.destinationPath === null)).toBe(true);
    // MTP copies never consume the local source.
    expect(existsSync(base.path)).toBe(true);
    expect(existsSync(early.path)).toBe(true);
  });

  it('marks a failed transfer failed and leaves the rest of the queue pending', async () => {
    const { gameId, base, early, late } = seedLibrary();
    adapter.storages = [SD_STORAGE];
    adapter.failOn = EARLY_UPDATE_NAME;
    const service = createService();

    const jobs = await service.create({
      gameId,
      updateIds: [early.id, late.id],
      destination: MTP_DESTINATION('sd'),
    });
    await service.whenIdle();

    expect(adapter.started).toEqual([BASE_NAME, EARLY_UPDATE_NAME]);
    expect(getInstallJob(db, jobs[0].id)!.status).toBe('completed');
    const failed = getInstallJob(db, jobs[1].id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'MTP_COPY_FAILED', retryable: true });
    expect(getInstallJob(db, jobs[2].id)!.status).toBe('pending');
    // MTP copies never consume the local source, even on failure.
    expect(existsSync(base.path)).toBe(true);
  });

  it('moves folder installs and repoints the catalog rows', async () => {
    const { gameId, base, early } = seedLibrary();
    const service = createService();

    const jobs = await service.create({ gameId, updateIds: [early.id], destination: FOLDER_DESTINATION() });
    await service.whenIdle();

    const baseDestination = join(installDir, BASE_NAME);
    const updateDestination = join(installDir, EARLY_UPDATE_NAME);
    expect(jobs.map((job) => getInstallJob(db, job.id)!.status)).toEqual(['completed', 'completed']);
    expect(existsSync(base.path)).toBe(false);
    expect(existsSync(baseDestination)).toBe(true);
    expect(existsSync(early.path)).toBe(false);

    const baseFile = getBaseFile(db, gameId)!;
    expect(baseFile.filePath).toBe(baseDestination);
    expect(baseFile.fileName).toBe(BASE_NAME);
    expect(baseFile.fileExtension).toBe('.nsp');

    const update = getUpdate(db, early.id)!;
    expect(update.filePath).toBe(updateDestination);
    expect(update.fileName).toBe(EARLY_UPDATE_NAME);
    expect(update.modifiedTime).toBeGreaterThan(0);

    expect(getInstallJob(db, jobs[0].id)!.destinationPath).toBe(baseDestination);
    expect(getInstallJob(db, jobs[0].id)!.transferredBytes).toBe(1000);
  });
});

describe('install queue recovery', () => {
  it('does nothing on an empty job table', () => {
    const service = createService();
    expect(service.recoverInterrupted()).toBe(0);
  });

  it('fails interrupted rows but leaves pending rows queued', () => {
    const interrupted = insertInstallJob(db, {
      gameId: null,
      sourcePath: writeSource('interrupted.nsp', 10),
      destinationFolder: installDir,
      destinationLabel: null,
      destinationType: 'folder',
      fileName: 'interrupted.nsp',
      fileSize: 10,
      fileKind: 'base',
      detectedVersion: '',
      rawVersion: 0,
    });
    updateInstallJob(db, interrupted, { status: 'running', transferredBytes: 4 });
    const queued = insertInstallJob(db, {
      gameId: null,
      sourcePath: writeSource('queued.nsp', 10),
      destinationFolder: installDir,
      destinationLabel: null,
      destinationType: 'folder',
      fileName: 'queued.nsp',
      fileSize: 10,
      fileKind: 'base',
      detectedVersion: '',
      rawVersion: 0,
    });

    const service = createService();
    expect(service.recoverInterrupted()).toBe(1);

    const recovered = getInstallJob(db, interrupted)!;
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toMatchObject({ code: 'UNKNOWN_ERROR', retryable: true });
    expect(recovered.transferredBytes).toBe(4);
    expect(getInstallJob(db, queued)!.status).toBe('pending');
    // Recovery never touches the sources.
    expect(existsSync(join(sourceDir, 'interrupted.nsp'))).toBe(true);
    expect(existsSync(join(sourceDir, 'queued.nsp'))).toBe(true);
  });

  it('drops queued rows whose source is gone on the next pump', async () => {
    const { gameId } = seedLibrary();
    const stale = insertInstallJob(db, {
      gameId,
      sourcePath: join(sourceDir, 'vanished.nsp'),
      destinationFolder: installDir,
      destinationLabel: null,
      destinationType: 'folder',
      fileName: 'vanished.nsp',
      fileSize: 10,
      fileKind: 'base',
      detectedVersion: '',
      rawVersion: 0,
    });
    const service = createService();

    await service.create({ gameId, updateIds: [], destination: FOLDER_DESTINATION() });
    await service.whenIdle();

    const staleJob = getInstallJob(db, stale)!;
    expect(staleJob.status).toBe('failed');
    expect(staleJob.error).toMatchObject({ code: 'FILE_MISSING' });
  });

  it('re-queues failed jobs whose source still exists', async () => {
    const { gameId, early } = seedLibrary();
    const failed = insertInstallJob(db, {
      gameId,
      sourcePath: early.path,
      destinationFolder: installDir,
      destinationLabel: null,
      destinationType: 'folder',
      fileName: EARLY_UPDATE_NAME,
      fileSize: 2000,
      fileKind: 'update',
      detectedVersion: '131072',
      rawVersion: 131072,
    });
    updateInstallJob(db, failed, { status: 'failed', error: { code: 'UNKNOWN_ERROR', message: 'disk hiccup' } });
    const gonePath = early.path.replace('library', 'library-gone');
    const orphan = insertInstallJob(db, {
      gameId,
      sourcePath: gonePath,
      destinationFolder: installDir,
      destinationLabel: null,
      destinationType: 'folder',
      fileName: 'gone.nsp',
      fileSize: 10,
      fileKind: 'update',
      detectedVersion: '',
      rawVersion: 0,
    });
    updateInstallJob(db, orphan, { status: 'failed', error: { code: 'UNKNOWN_ERROR', message: 'disk hiccup' } });
    const service = createService();

    const created = await service.retryFailed();

    expect(created).toHaveLength(1);
    expect(created[0].id).toBeGreaterThan(failed);
    expect(created[0]).toMatchObject({
      status: 'pending',
      sourcePath: early.path,
      displayName: EARLY_UPDATE_NAME,
      fileKind: 'update',
      rawVersion: 131072,
      destinationType: 'folder',
    });

    await service.whenIdle();
    expect(getInstallJob(db, created[0].id)!.status).toBe('completed');
    expect(getInstallJob(db, failed)!.status).toBe('failed');
    expect(getInstallJob(db, orphan)!.status).toBe('failed');
    expect(service.getJobs().filter((job) => job.sourcePath === gonePath)).toHaveLength(1);
  });

  it('cancels a queued job but never a running MTP transfer', async () => {
    const { gameId, early, late } = seedLibrary();
    adapter.storages = [SD_STORAGE];
    adapter.hold = true;
    const service = createService();

    const jobs = await service.create({
      gameId,
      updateIds: [early.id, late.id],
      destination: MTP_DESTINATION('sd'),
    });
    await vi.waitFor(() => expect(adapter.started).toEqual([BASE_NAME]));

    await service.cancel(jobs[2].id);
    expect(getInstallJob(db, jobs[2].id)!.status).toBe('cancelled');

    await service.cancel(jobs[0].id);
    expect(getInstallJob(db, jobs[0].id)!.status).toBe('running');

    adapter.hold = false;
    adapter.release();
    await service.whenIdle();

    expect(getInstallJob(db, jobs[0].id)!.status).toBe('completed');
    expect(getInstallJob(db, jobs[1].id)!.status).toBe('completed');
    expect(getInstallJob(db, jobs[2].id)!.status).toBe('cancelled');
    expect(adapter.started).toEqual([BASE_NAME, EARLY_UPDATE_NAME]);

    await expect(service.cancel(99_999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops the queue behind a running folder transfer when cancelled', async () => {
    const { gameId, early, late } = seedLibrary();
    const service = createService({
      onJobChanged: (job) => {
        if (job.status === 'running' && job.displayName === BASE_NAME) void service.cancel(job.id);
      },
    });

    const jobs = await service.create({
      gameId,
      updateIds: [early.id, late.id],
      destination: FOLDER_DESTINATION(),
    });
    await service.whenIdle();

    expect(getInstallJob(db, jobs[0].id)!.status).toBe('cancelled');
    expect(getInstallJob(db, jobs[1].id)!.status).toBe('pending');
    expect(getInstallJob(db, jobs[2].id)!.status).toBe('pending');
    expect(existsSync(early.path)).toBe(true);
  });
});

describe('install service shutdown', () => {
  it('rejects new work and leaves queued rows untouched', async () => {
    const { gameId, early } = seedLibrary();
    const service = createService();
    expect(() => service.shutdown()).not.toThrow();
    service.shutdown();

    const queued = insertInstallJob(db, {
      gameId,
      sourcePath: early.path,
      destinationFolder: installDir,
      destinationLabel: null,
      destinationType: 'folder',
      fileName: EARLY_UPDATE_NAME,
      fileSize: 2000,
      fileKind: 'update',
      detectedVersion: '131072',
      rawVersion: 131072,
    });

    await expect(
      service.create({ gameId, updateIds: [early.id], destination: FOLDER_DESTINATION() }),
    ).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    await expect(service.retryFailed()).rejects.toMatchObject({ code: 'JOB_CANCELLED' });

    expect(service.getJobs()).toHaveLength(1);
    expect(getInstallJob(db, queued)!.status).toBe('pending');
    expect(existsSync(early.path)).toBe(true);
  });

  it('lets a running transfer finish and stops the rest of the queue', async () => {
    const { gameId, early, late } = seedLibrary();
    adapter.storages = [SD_STORAGE];
    adapter.hold = true;
    const service = createService();

    const jobs = await service.create({
      gameId,
      updateIds: [early.id, late.id],
      destination: MTP_DESTINATION('sd'),
    });
    await vi.waitFor(() => expect(adapter.started).toEqual([BASE_NAME]));

    service.shutdown();
    expect(getInstallJob(db, jobs[0].id)!.status).toBe('running');

    adapter.hold = false;
    adapter.release();
    await service.whenIdle();

    expect(getInstallJob(db, jobs[0].id)!.status).toBe('completed');
    expect(getInstallJob(db, jobs[1].id)!.status).toBe('pending');
    expect(getInstallJob(db, jobs[2].id)!.status).toBe('pending');
    expect(adapter.started).toEqual([BASE_NAME]);
  });
});
