import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { getGameFile, listGameFiles, upsertBaseGameFile } from '@main/repositories/game-files.repository';
import { getGame, upsertGameByCleanedTitle } from '@main/repositories/games.repository';
import { listScreenshots, replaceScreenshots } from '@main/repositories/screenshots.repository';
import { getUpdate, listAllUpdates, upsertUpdate } from '@main/repositories/updates.repository';
import { FileService, deleteFileIfPresent, moveFileToFolder, uniqueDestinationPath } from '@main/services/file.service';
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
  it('deletes an update file from disk and drops its row', async () => {
    const harness = createHarness();
    const { updateId, filePath } = seedUpdate(harness.db, harness.libraryDir);

    const result = await harness.service.deleteTrackedFile({ kind: 'update', id: updateId });

    expect(result).toEqual({ id: updateId, kind: 'update', deletedFromDisk: true, cascaded: false });
    expect(existsSync(filePath)).toBe(false);
    expect(getUpdate(harness.db, updateId)).toBeNull();
  });

  it('cascades a game delete to its files and screenshots, unmatched updates survive', async () => {
    const harness = createHarness();
    const game = seedGame(harness.db, harness.libraryDir);
    const update = seedUpdate(harness.db, harness.libraryDir, game.gameId);
    replaceScreenshots(harness.db, game.gameId, ['https://images.example/1.jpg', 'https://images.example/2.jpg']);

    const result = await harness.service.deleteTrackedFile({ kind: 'game', id: game.gameId });

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

    const result = await harness.service.deleteTrackedFile({ kind: 'update', id: updateId });

    expect(result.deletedFromDisk).toBe(false);
    expect(getUpdate(harness.db, updateId)).toBeNull();
  });

  it('rejects unknown rows', async () => {
    const harness = createHarness();
    await expectAppError(harness.service.deleteTrackedFile({ kind: 'game', id: 4242 }), 'NOT_FOUND');
    await expectAppError(harness.service.deleteTrackedFile({ kind: 'update', id: 4242 }), 'NOT_FOUND');
  });
});

describe('FileService.moveTrackedFile', () => {
  it('moves an update to a conflict-free name and stores the new path', async () => {
    const harness = createHarness();
    const { updateId, filePath } = seedUpdate(harness.db, harness.libraryDir);
    writeFile(join(harness.destinationDir, 'Game [v65536].nsp'), 'existing');

    const result = await harness.service.moveTrackedFile({
      kind: 'update',
      id: updateId,
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
      id: game.gameId,
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
      .moveTrackedFile({ kind: 'update', id: updateId, destinationFolder: harness.destinationDir })
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
      harness.service.moveTrackedFile({ kind: 'update', id: updateId, destinationFolder: 'relative/folder' }),
      'PATH_NOT_ALLOWED',
    );
    await expectAppError(
      harness.service.moveTrackedFile({
        kind: 'update',
        id: updateId,
        destinationFolder: 'shell:::{20D0-1}\\SD install',
      }),
      'PATH_NOT_ALLOWED',
    );
  });
});
