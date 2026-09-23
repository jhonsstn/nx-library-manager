import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rename as renameAsync } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { getGameFile, listGameFiles, upsertBaseGameFile } from '@main/repositories/game-files.repository';
import { getGame, upsertGameByCleanedTitle } from '@main/repositories/games.repository';
import { listScreenshots, replaceScreenshots } from '@main/repositories/screenshots.repository';
import { getUpdate, listAllUpdates, upsertUpdate } from '@main/repositories/updates.repository';
import { FileService, deleteFileIfPresent, moveFileToFolder, uniqueDestinationPath } from '@main/services/file.service';
import { recordInspection } from '@main/repositories/title-catalog.repository';
import { previewOldUpdates } from '@main/repositories/update-cleanup.repository';
import { SwitchCatalogError } from '@shared/errors/app-error';
import type { AppErrorCode } from '@shared/errors/codes';

import { TEMP_ROOT } from '../../setup/vitest.setup';

const openDatabases: AppDatabase[] = [];

afterEach(() => {
  while (openDatabases.length > 0) closeDatabase(openDatabases.pop() ?? null);
});

interface Harness {
  dir: string;
  db: AppDatabase;
  service: FileService;
  libraryDir: string;
  destinationDir: string;
}

function createHarness(options: { wrapDb?: (db: AppDatabase) => AppDatabase } = {}): Harness {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  const dbFile = join(dir, 'library.sqlite3');
  const db = openDatabase(dbFile);
  openDatabases.push(db);
  runMigrations(db, dbFile);
  const libraryDir = join(dir, 'library');
  const destinationDir = join(dir, 'destination');
  mkdirSync(libraryDir, { recursive: true });
  mkdirSync(destinationDir, { recursive: true });
  const serviceDb = options.wrapDb ? options.wrapDb(db) : db;
  return { dir, db, service: new FileService({ db: serviceDb }), libraryDir, destinationDir };
}

function writeFile(filePath: string, content = 'data'): string {
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function seedGame(db: AppDatabase, libraryDir: string): { gameId: number; fileId: number; filePath: string } {
  const filePath = writeFile(join(libraryDir, 'Game.nsp'), 'game-bytes');
  const gameId = upsertGameByCleanedTitle(db, { displayTitle: 'Game', cleanedTitle: 'game' });
  const fileId = upsertBaseGameFile(db, {
    gameId,
    filePath,
    fileName: 'Game.nsp',
    fileExtension: '.nsp',
    fileSize: 10,
    modifiedTime: 1,
    fileType: 'nsp',
  });
  return { gameId, fileId, filePath };
}

function seedUpdate(
  db: AppDatabase,
  libraryDir: string,
  gameId: number | null = null,
): { updateId: number; filePath: string } {
  const fileName = 'Game [v65536].nsp';
  const filePath = writeFile(join(libraryDir, fileName), 'update-bytes');
  upsertUpdate(db, {
    gameId,
    filePath,
    fileName,
    detectedVersion: '65536',
    fileSize: 12,
    modifiedTime: 1,
    matchConfidence: 0.9,
  });
  const row = listAllUpdates(db).find((candidate) => candidate.filePath === filePath);
  if (!row) throw new Error('seedUpdate failed');
  return { updateId: row.id, filePath };
}

async function expectAppError(promise: Promise<unknown>, code: AppErrorCode): Promise<void> {
  const error = await promise.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(SwitchCatalogError);
  expect((error as SwitchCatalogError).code).toBe(code);
}

/** Fails only the path-writing UPDATE, which is how the compensation path is reached. */
function databaseThatRejectsPathWrites(db: AppDatabase): AppDatabase {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (/^UPDATE (updates|game_files)/i.test(sql.trim())) throw new Error('disk I/O error');
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('uniqueDestinationPath', () => {
  it('numbers colliding names the way the Qt build did', () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
    expect(uniqueDestinationPath(dir, 'Game.nsp')).toBe(join(dir, 'Game.nsp'));
    writeFile(join(dir, 'Game.nsp'));
    expect(uniqueDestinationPath(dir, 'Game.nsp')).toBe(join(dir, 'Game (1).nsp'));
    writeFile(join(dir, 'Game (1).nsp'));
    expect(uniqueDestinationPath(dir, 'Game.nsp')).toBe(join(dir, 'Game (2).nsp'));
    writeFile(join(dir, 'Game (2).nsp'));
    expect(uniqueDestinationPath(dir, 'Game.nsp')).toBe(join(dir, 'Game (3).nsp'));
    expect(uniqueDestinationPath(dir, 'README')).toBe(join(dir, 'README'));
  });
});

describe('combined physical files', () => {
  it('moves and deletes one package while updating every linked row', async () => {
    const { db, service, libraryDir, destinationDir } = createHarness();
    const { gameId, filePath } = seedGame(db,libraryDir);
    upsertUpdate(db,{ gameId,filePath,fileName:'Game.nsp',detectedVersion:'65536',
      fileSize:10,modifiedTime:1,matchConfidence:1 });
    recordInspection(db,{ path:filePath,size:10,mtime:1,parserVersion:1,keysRevision:1,error:null,
      titles:[
        { titleId:'0100AABBCCDD0000',baseTitleId:'0100AABBCCDD0000',type:'base',
          rawVersion:0,name:'Game',publisher:null,source:'cnmt' },
        { titleId:'0100AABBCCDD0800',baseTitleId:'0100AABBCCDD0000',type:'update',
          rawVersion:65536,name:null,publisher:null,source:'cnmt' },
      ] });
    const update = listAllUpdates(db)[0];
    const moved = await service.moveTrackedFile({ kind:'game',gameId,destinationFolder:destinationDir });
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(moved.destinationPath)).toBe(true);
    expect(db.prepare('SELECT file_path FROM local_files').get()).toMatchObject({ file_path:moved.destinationPath });
    expect(getUpdate(db,update.id)?.filePath).toBe(moved.destinationPath);
    await service.deleteTrackedFile({ kind:'update',updateId:update.id });
    expect(existsSync(moved.destinationPath)).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM local_files').get()).toMatchObject({ n:0 });
    expect(db.prepare('SELECT count(*) AS n FROM file_titles').get()).toMatchObject({ n:0 });
    expect(listGameFiles(db,gameId)).toHaveLength(0);
  });
});

describe('older update cleaner', () => {
  const baseId = '0100AABBCCDD0000';
  const patchId = '0100AABBCCDD0800';

  function inspectedFile(db: AppDatabase, filePath: string, titles: Parameters<typeof recordInspection>[1]['titles']) {
    const info = statSync(filePath);
    recordInspection(db, {
      path: filePath, size: info.size, mtime: info.mtimeMs,
      parserVersion: 1, keysRevision: 1, titles, error: null,
    });
  }

  function patch(version: number): Parameters<typeof recordInspection>[1]['titles'][number] {
    return { titleId: patchId, baseTitleId: baseId, type: 'update', rawVersion: version,
      name: null, publisher: null, source: 'cnmt' };
  }

  function trackedUpdate(db: AppDatabase, libraryDir: string, gameId: number, name: string,
    version: number, extraTitles: Parameters<typeof recordInspection>[1]['titles'] = []) {
    const filePath = writeFile(join(libraryDir, name), name);
    const info = statSync(filePath);
    upsertUpdate(db, { gameId, filePath, fileName: name, detectedVersion: String(version),
      fileSize: info.size, modifiedTime: info.mtimeMs, matchConfidence: 1 });
    inspectedFile(db, filePath, [patch(version), ...extraTitles]);
    return filePath;
  }

  it('removes only older verified matched update-only packages', async () => {
    const { db, service, libraryDir } = createHarness();
    const { gameId, filePath: basePath } = seedGame(db, libraryDir);
    inspectedFile(db, basePath, [{ titleId: baseId, baseTitleId: baseId, type: 'base',
      rawVersion: 0, name: 'Game', publisher: null, source: 'cnmt' }]);
    const old = trackedUpdate(db, libraryDir, gameId, 'old.nsp', 65536);
    const latest = trackedUpdate(db, libraryDir, gameId, 'latest.nsp', 131072);
    const dlc = trackedUpdate(db, libraryDir, gameId, 'update-with-dlc.nsp', 32768, [
      { titleId: '0100AABBCCDD1001', baseTitleId: baseId, type: 'dlc', rawVersion: 0,
        name: null, publisher: null, source: 'cnmt' },
    ]);
    const unmatched = writeFile(join(libraryDir, 'unmatched.nsp'), 'unmatched');
    inspectedFile(db, unmatched, [patch(262144)]);

    const preview = previewOldUpdates(db, gameId);
    expect(preview.latestLocalVersion).toBe(131072);
    expect(preview.deleteFiles.map((file) => file.filePath)).toEqual([old]);
    expect(preview.keepFiles.map((file) => file.filePath)).toEqual([latest]);
    const result = await service.cleanOldUpdates(gameId, preview);
    expect(result.deletedFiles).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(latest)).toBe(true);
    expect(existsSync(dlc)).toBe(true);
    expect(existsSync(unmatched)).toBe(true);
    expect(existsSync(basePath)).toBe(true);
    expect(db.prepare('SELECT id FROM local_files WHERE file_path=?').get(old)).toBeUndefined();
  });

  it('keeps a combined package with the latest patch and rejects a stale preview', async () => {
    const { db, service, libraryDir } = createHarness();
    const { gameId, filePath: basePath } = seedGame(db, libraryDir);
    inspectedFile(db, basePath, [
      { titleId: baseId, baseTitleId: baseId, type: 'base', rawVersion: 0,
        name: 'Game', publisher: null, source: 'cnmt' },
      patch(131072),
    ]);
    const old = trackedUpdate(db, libraryDir, gameId, 'old.nsp', 65536);
    const preview = previewOldUpdates(db, gameId);
    expect(preview.keepFiles.map((file) => file.filePath)).toEqual([basePath]);
    expect(preview.deleteFiles.map((file) => file.filePath)).toEqual([old]);
    writeFile(old, 'replacement');
    await expectAppError(service.cleanOldUpdates(gameId, preview), 'VALIDATION_ERROR');
    expect(existsSync(old)).toBe(true);
    expect(existsSync(basePath)).toBe(true);
  });

  it('does not remove an older patch if the kept newest package disappears', async () => {
    const { db, service, libraryDir } = createHarness();
    const { gameId, filePath: basePath } = seedGame(db, libraryDir);
    inspectedFile(db, basePath, [{ titleId: baseId, baseTitleId: baseId, type: 'base',
      rawVersion: 0, name: 'Game', publisher: null, source: 'cnmt' }]);
    const old = trackedUpdate(db, libraryDir, gameId, 'old.nsp', 65536);
    const latest = trackedUpdate(db, libraryDir, gameId, 'latest.nsp', 131072);
    const preview = previewOldUpdates(db, gameId);
    unlinkSync(latest);
    await expectAppError(service.cleanOldUpdates(gameId, preview), 'FILE_MISSING');
    expect(existsSync(old)).toBe(true);
  });
});

describe('moveFileToFolder', () => {
  it('creates the folder, keeps the source when it is already there and resolves collisions', async () => {
    const harness = createHarness();
    const source = writeFile(join(harness.libraryDir, 'Game.nsp'), 'payload');
    writeFile(join(harness.destinationDir, 'Game.nsp'), 'existing');

    const moved = await moveFileToFolder(source, harness.destinationDir);
    expect(moved).toBe(join(harness.destinationDir, 'Game (1).nsp'));
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(moved, 'utf8')).toBe('payload');

    expect(await moveFileToFolder(moved, harness.destinationDir)).toBe(moved);
    expect(readFileSync(moved, 'utf8')).toBe('payload');

    const nested = join(harness.dir, 'created', 'nested');
    expect(await moveFileToFolder(moved, nested)).toBe(join(nested, 'Game (1).nsp'));
  });

  it('streams a simulated cross-volume move and reports byte progress', async () => {
    const harness = createHarness();
    const payload = Buffer.alloc(512 * 1024, 7);
    const source = join(harness.libraryDir, 'Large.nsp');
    writeFileSync(source, payload);
    const progress: number[] = [];
    const crossDeviceRename = async () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    };

    const moved = await moveFileToFolder(source, harness.destinationDir, {
      renameFile: crossDeviceRename,
      onProgress: (bytes) => progress.push(bytes),
    });

    expect(readFileSync(moved)).toEqual(payload);
    expect(existsSync(source)).toBe(false);
    expect(progress.at(-1)).toBe(payload.length);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1])).toBe(true);
  });

  it('cancels a streamed move without deleting the source or leaving a partial file', async () => {
    const harness = createHarness();
    const source = join(harness.libraryDir, 'Cancel.nsp');
    writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 3));
    const controller = new AbortController();
    const crossDeviceRename = async () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    };

    await expect(
      moveFileToFolder(source, harness.destinationDir, {
        renameFile: crossDeviceRename,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(existsSync(source)).toBe(true);
    expect(readdirSync(harness.destinationDir)).toEqual([]);
  });

  it('rolls a same-volume rename back when cancellation wins the completion race', async () => {
    const harness = createHarness();
    const source = writeFile(join(harness.libraryDir, 'Rename.nsp'), 'payload');
    const controller = new AbortController();

    await expect(
      moveFileToFolder(source, harness.destinationDir, {
        signal: controller.signal,
        renameFile: async (from, to) => {
          await renameAsync(from, to);
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(existsSync(source)).toBe(true);
    expect(readdirSync(harness.destinationDir)).toEqual([]);
  });

  it('removes the finalized destination when source deletion fails', async () => {
    const harness = createHarness();
    const source = writeFile(join(harness.libraryDir, 'Compensate.nsp'), 'payload');
    const crossDeviceRename = async () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    };

    await expect(
      moveFileToFolder(source, harness.destinationDir, {
        renameFile: crossDeviceRename,
        unlinkSource: async () => {
          throw new Error('source locked');
        },
      }),
    ).rejects.toThrow('source locked');

    expect(existsSync(source)).toBe(true);
    expect(readdirSync(harness.destinationDir)).toEqual([]);
  });

  it('reports both paths when source deletion and compensation fail', async () => {
    const harness = createHarness();
    const source = writeFile(join(harness.libraryDir, 'Stranded.nsp'), 'payload');
    const destination = join(harness.destinationDir, 'Stranded.nsp');
    const crossDeviceRename = async () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException;
      error.code = 'EXDEV';
      throw error;
    };

    let failure: unknown;
    try {
      await moveFileToFolder(source, harness.destinationDir, {
        renameFile: crossDeviceRename,
        unlinkSource: async () => {
          throw new Error('source locked');
        },
        removeDestination: async () => {
          throw new Error('destination locked');
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SwitchCatalogError);
    expect((failure as SwitchCatalogError).details).toMatchObject({
      sourcePath: source,
      destinationPath: destination,
    });
    expect(existsSync(source)).toBe(true);
    expect(existsSync(destination)).toBe(true);
  });
});

describe('deleteFileIfPresent', () => {
  it('reports whether a file was removed', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
    const filePath = writeFile(join(dir, 'gone.nsp'));
    expect(await deleteFileIfPresent(filePath)).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(await deleteFileIfPresent(filePath)).toBe(false);
  });
});

describe('FileService.deleteTrackedFile', () => {
  it('deletes by game id when the base-file id differs', async () => {
    const harness = createHarness();
    upsertGameByCleanedTitle(harness.db, { displayTitle: 'Other', cleanedTitle: 'other' });
    const game = seedGame(harness.db, harness.libraryDir);
    expect(game.gameId).not.toBe(game.fileId);

    await harness.service.deleteTrackedFile({ kind: 'game', gameId: game.gameId });

    expect(getGame(harness.db, game.gameId)).toBeNull();
    expect(existsSync(game.filePath)).toBe(false);
  });
  it('deletes an update file from disk and drops its row', async () => {
    const harness = createHarness();
    const { updateId, filePath } = seedUpdate(harness.db, harness.libraryDir);

    const result = await harness.service.deleteTrackedFile({ kind: 'update', updateId });

    expect(result).toEqual({ id: updateId, kind: 'update', deletedFromDisk: true, cascaded: false });
    expect(existsSync(filePath)).toBe(false);
    expect(getUpdate(harness.db, updateId)).toBeNull();
  });

  it('cascades a game delete to its files and screenshots, unmatched updates survive', async () => {
    const harness = createHarness();
    const game = seedGame(harness.db, harness.libraryDir);
    const update = seedUpdate(harness.db, harness.libraryDir, game.gameId);
    replaceScreenshots(harness.db, game.gameId, ['https://images.example/1.jpg', 'https://images.example/2.jpg']);

    const result = await harness.service.deleteTrackedFile({ kind: 'game', gameId: game.gameId });

    expect(result).toEqual({ id: game.gameId, kind: 'game', deletedFromDisk: true, cascaded: true });
    expect(existsSync(game.filePath)).toBe(false);
    expect(getGame(harness.db, game.gameId)).toBeNull();
    expect(listGameFiles(harness.db, game.gameId)).toEqual([]);
    expect(listScreenshots(harness.db, game.gameId)).toEqual([]);
    expect(getUpdate(harness.db, update.updateId)?.gameId).toBeNull();
    expect(existsSync(update.filePath)).toBe(true);
  });

  it('removes the row anyway when the file is already gone', async () => {
    const harness = createHarness();
    const { updateId, filePath } = seedUpdate(harness.db, harness.libraryDir);
    unlinkSync(filePath);

    const result = await harness.service.deleteTrackedFile({ kind: 'update', updateId });

    expect(result.deletedFromDisk).toBe(false);
    expect(getUpdate(harness.db, updateId)).toBeNull();
  });

  it('rejects unknown rows', async () => {
    const harness = createHarness();
    await expectAppError(harness.service.deleteTrackedFile({ kind: 'game', gameId: 4242 }), 'NOT_FOUND');
    await expectAppError(harness.service.deleteTrackedFile({ kind: 'update', updateId: 4242 }), 'NOT_FOUND');
  });
});

describe('FileService.moveTrackedFile', () => {
  it('moves an update to a conflict-free name and stores the new path', async () => {
    const harness = createHarness();
    const { updateId, filePath } = seedUpdate(harness.db, harness.libraryDir);
    writeFile(join(harness.destinationDir, 'Game [v65536].nsp'), 'existing');

    const result = await harness.service.moveTrackedFile({
      kind: 'update',
      updateId,
      destinationFolder: harness.destinationDir,
    });

    const destination = join(harness.destinationDir, 'Game [v65536] (1).nsp');
    expect(result).toEqual({ id: updateId, sourcePath: filePath, destinationPath: destination });
    expect(existsSync(filePath)).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('update-bytes');
    const stored = getUpdate(harness.db, updateId);
    expect(stored?.filePath).toBe(destination);
    expect(stored?.fileName).toBe('Game [v65536] (1).nsp');
    expect(stored?.modifiedTime).toBe(statSync(destination).mtimeMs);
  });

  it('moves the base file of a game and keeps its extension', async () => {
    const harness = createHarness();
    const game = seedGame(harness.db, harness.libraryDir);

    const result = await harness.service.moveTrackedFile({
      kind: 'game',
      gameId: game.gameId,
      destinationFolder: harness.destinationDir,
    });

    const destination = join(harness.destinationDir, 'Game.nsp');
    expect(result).toEqual({ id: game.gameId, sourcePath: game.filePath, destinationPath: destination });
    expect(existsSync(game.filePath)).toBe(false);
    const stored = getGameFile(harness.db, game.fileId);
    expect(stored?.filePath).toBe(destination);
    expect(stored?.fileExtension).toBe('.nsp');
  });

  it('moves the file back when the catalog update fails', async () => {
    const harness = createHarness({ wrapDb: databaseThatRejectsPathWrites });
    const { updateId, filePath } = seedUpdate(harness.db, harness.libraryDir);

    const error = await harness.service
      .moveTrackedFile({ kind: 'update', updateId, destinationFolder: harness.destinationDir })
      .catch((value: unknown) => value);

    expect((error as Error).message).toMatch(/disk I\/O error/);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('update-bytes');
    expect(existsSync(join(harness.destinationDir, 'Game [v65536].nsp'))).toBe(false);
    expect(getUpdate(harness.db, updateId)?.filePath).toBe(filePath);
  });

  it('rejects destinations that are not absolute local folders', async () => {
    const harness = createHarness();
    const { updateId } = seedUpdate(harness.db, harness.libraryDir);

    await expectAppError(
      harness.service.moveTrackedFile({ kind: 'update', updateId, destinationFolder: 'relative/folder' }),
      'PATH_NOT_ALLOWED',
    );
    await expectAppError(
      harness.service.moveTrackedFile({
        kind: 'update',
        updateId,
        destinationFolder: 'shell:::{20D0-1}\\SD install',
      }),
      'PATH_NOT_ALLOWED',
    );
  });
});
