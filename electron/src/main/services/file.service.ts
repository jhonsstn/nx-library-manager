import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { DeleteFileResultDto } from '../../shared/contracts/results';
import { appError } from '../../shared/errors/app-error';
import { isShellPath } from '../../shared/format/install';
import type { FileOperationResultDto } from '../../shared/types/domain';
import { withTransaction, type AppDatabase } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import {
  deleteGameFilesForGame,
  getBaseFile,
  listGameFiles,
  updateGameFilePath,
} from '../repositories/game-files.repository';
import { deleteGame, getGame } from '../repositories/games.repository';
import { clearGameIdForUpdates, deleteUpdate, getUpdate, updateUpdatePath } from '../repositories/updates.repository';

/** Ports `unique_destination`: `Game.nsp`, `Game (1).nsp`, `Game (2).nsp`, ... */
export function uniqueDestinationPath(folder: string, fileName: string): string {
  const candidate = join(folder, fileName);
  if (!existsSync(candidate)) return candidate;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const suffix = dot > 0 ? fileName.slice(dot) : '';
  for (let index = 1; ; index += 1) {
    const next = join(folder, `${stem} (${index})${suffix}`);
    if (!existsSync(next)) return next;
  }
}

/**
 * Ports `move_file_to_folder` for local folders: creates the destination, keeps
 * the source untouched when it already lives there, and resolves collisions with
 * a numbered name. Shell/MTP destinations are handled by the MTP adapter.
 */
export async function moveFileToFolder(sourcePath: string, folder: string): Promise<string> {
  const targetRoot = resolve(folder);
  mkdirSync(targetRoot, { recursive: true });
  const source = resolve(sourcePath);
  if (dirname(source) === targetRoot) return sourcePath;
  const destination = uniqueDestinationPath(targetRoot, basename(source));
  try {
    renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(source, destination);
    unlinkSync(source);
  }
  return destination;
}

/** Ports `delete_file_if_present`. */
export async function deleteFileIfPresent(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

function prepareDestinationFolder(folder: string): string {
  const value = String(folder ?? '').trim();
  if (!value || !isAbsolute(value) || isShellPath(value)) {
    throw appError('PATH_NOT_ALLOWED', `The destination folder must be an absolute path: ${value}`, {
      details: { path: value },
    });
  }
  try {
    mkdirSync(value, { recursive: true });
  } catch (error) {
    throw appError('PATH_NOT_ALLOWED', `The destination folder could not be created: ${value}`, {
      details: { path: value },
      cause: error,
    });
  }
  return value;
}

export interface FileServiceOptions {
  db: AppDatabase;
  logger?: Logger;
  /** Overrides removal (e.g. recycle bin); defaults to a plain unlink. */
  trash?: (filePath: string) => Promise<void>;
}

/**
 * Local filesystem operations from `file_ops`. Every destructive operation
 * resolves its target from the catalog, never from a renderer-supplied path
 * (spec 08), and file/database changes are compensated explicitly because the
 * two cannot share a transaction (spec 10).
 */
export class FileService {
  private readonly db: AppDatabase;
  private readonly logger: Logger | undefined;
  private readonly trash: ((filePath: string) => Promise<void>) | undefined;

  constructor(options: FileServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.trash = options.trash;
  }

  async deleteTrackedFile(input: { kind: 'game' | 'update'; id: number }): Promise<DeleteFileResultDto> {
    return input.kind === 'update' ? this.deleteUpdate(input.id) : this.deleteGame(input.id);
  }

  async moveTrackedFile(input: {
    kind: 'game' | 'update';
    id: number;
    destinationFolder: string;
  }): Promise<FileOperationResultDto> {
    if (input.kind === 'update') {
      const update = getUpdate(this.db, input.id);
      if (!update) throw appError('NOT_FOUND', `No update or DLC file with id ${input.id}.`);
      return this.moveTrackedRow({
        id: input.id,
        sourcePath: update.filePath,
        destinationFolder: input.destinationFolder,
        persist: (filePath, fileName, modifiedTime) =>
          updateUpdatePath(this.db, update.id, { filePath, fileName, modifiedTime }),
      });
    }

    const game = getGame(this.db, input.id);
    if (!game) throw appError('NOT_FOUND', `No game with id ${input.id}.`);
    const baseFile = getBaseFile(this.db, game.id);
    if (!baseFile) throw appError('NOT_FOUND', `No base game file recorded for game ${game.id}.`);
    return this.moveTrackedRow({
      id: input.id,
      sourcePath: baseFile.filePath,
      destinationFolder: input.destinationFolder,
      persist: (filePath, fileName, modifiedTime) =>
        updateGameFilePath(this.db, baseFile.id, {
          filePath,
          fileName,
          fileExtension: extname(fileName).toLowerCase(),
          modifiedTime,
        }),
    });
  }

  private async deleteUpdate(updateId: number): Promise<DeleteFileResultDto> {
    const update = getUpdate(this.db, updateId);
    if (!update) throw appError('NOT_FOUND', `No update or DLC file with id ${updateId}.`);
    const deletedFromDisk = await this.removeFromDisk(update.filePath);
    withTransaction(this.db, () => {
      deleteUpdate(this.db, updateId);
    });
    this.logger?.info('files.deleted', { updateId, kind: 'update', deletedFromDisk });
    return { id: updateId, kind: 'update', deletedFromDisk, cascaded: false };
  }

  private async deleteGame(gameId: number): Promise<DeleteFileResultDto> {
    const game = getGame(this.db, gameId);
    if (!game) throw appError('NOT_FOUND', `No game with id ${gameId}.`);
    let deletedFromDisk = false;
    // Only base game files live on disk for a catalog entry; the Qt build
    // removed exactly those and left update/DLC files alone.
    for (const file of listGameFiles(this.db, gameId)) {
      if (!file.isBaseGame) continue;
      if (await this.removeFromDisk(file.filePath)) deletedFromDisk = true;
    }
    withTransaction(this.db, () => {
      // Update and DLC rows stay in the catalog but lose their association;
      // `game_files` and `screenshots` rows cascade with the game row.
      clearGameIdForUpdates(this.db, gameId);
      deleteGameFilesForGame(this.db, gameId);
      deleteGame(this.db, gameId);
    });
    this.logger?.info('files.deleted', { gameId, kind: 'game', deletedFromDisk });
    return { id: gameId, kind: 'game', deletedFromDisk, cascaded: true };
  }

  private async moveTrackedRow(input: {
    id: number;
    sourcePath: string;
    destinationFolder: string;
    persist: (filePath: string, fileName: string, modifiedTime: number) => void;
  }): Promise<FileOperationResultDto> {
    const folder = prepareDestinationFolder(input.destinationFolder);
    const sourcePath = input.sourcePath;
    const destinationPath = await moveFileToFolder(sourcePath, folder);
    const modifiedTime = statSync(destinationPath).mtimeMs;
    try {
      withTransaction(this.db, () => {
        input.persist(destinationPath, basename(destinationPath), modifiedTime);
      });
    } catch (error) {
      await this.compensateMove(destinationPath, sourcePath);
      throw error;
    }
    this.logger?.info('files.moved', { id: input.id, sourcePath, destinationPath });
    return { id: input.id, sourcePath, destinationPath };
  }

  private async compensateMove(destinationPath: string, originalPath: string): Promise<void> {
    try {
      await moveFileToFolder(destinationPath, dirname(originalPath));
    } catch (error) {
      this.logger?.error('files.move.compensation_failed', {
        sourcePath: originalPath,
        destinationPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async removeFromDisk(filePath: string): Promise<boolean> {
    if (!filePath || !existsSync(filePath)) return false;
    if (this.trash) await this.trash(filePath);
    else await deleteFileIfPresent(filePath);
    return true;
  }
}
