import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { BrowserWindow, dialog, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/contracts/ipc';
import {
  AssignUpdatesInputSchema,
  ChooseDirectoryInputSchema,
  DeleteFileInputSchema,
  GameIdSchema,
  ListGamesInputSchema,
  ListUpdatesInputSchema,
  MoveFileInputSchema,
  UpdateCleanupPreviewSchema,
  UnmatchUpdatesInputSchema,
} from '../../shared/schemas/inputs';
import { appError } from '../../shared/errors/app-error';
import { getBaseFile } from '../repositories/game-files.repository';
import { handle } from './handle';
import type { IpcDeps } from './deps';

export function registerCatalogIpc(deps: IpcDeps): void {
  handle(IPC.catalog.listGames, z.tuple([ListGamesInputSchema.default({})]), (input) =>
    deps.catalog.listGames(input),
  );
  handle(IPC.catalog.getGame, z.tuple([GameIdSchema]), (gameId) => deps.catalog.getGame(gameId));
  handle(IPC.catalog.getGenres, z.tuple([]), () => deps.catalog.getGenres());
  handle(IPC.catalog.setFavorite, z.tuple([GameIdSchema, z.boolean()]), (gameId, favorite) =>
    deps.catalog.setFavorite(gameId, favorite),
  );
  handle(IPC.catalog.setNeedsReview, z.tuple([GameIdSchema, z.boolean()]), (gameId, value) =>
    deps.catalog.setNeedsReview(gameId, value),
  );
  handle(IPC.catalog.setHidden, z.tuple([GameIdSchema, z.boolean()]), (gameId, hidden) =>
    deps.catalog.setHidden(gameId, hidden),
  );
  handle(IPC.catalog.markAsUpdate, z.tuple([GameIdSchema]), (gameId) => deps.catalog.markAsUpdate(gameId));
  handle(IPC.catalog.assignUpdates, z.tuple([AssignUpdatesInputSchema]), (input) => deps.catalog.assignUpdates(input));
  handle(IPC.catalog.unmatchUpdates, z.tuple([UnmatchUpdatesInputSchema]), (updateIds) =>
    deps.catalog.unmatchUpdates(updateIds),
  );
  handle(IPC.catalog.listUpdates, z.tuple([ListUpdatesInputSchema.default({})]), (input) =>
    deps.catalog.listUpdates(input),
  );
  handle(IPC.catalog.resetLibrary, z.tuple([]), () => deps.catalog.resetLibrary());
  handle(IPC.catalog.exportBackup, z.tuple([]), () => exportBackup(deps));
}

/** Ports the Qt "Export catalog backup" save dialog. */
async function exportBackup(deps: IpcDeps): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1_$2');
  const result = await dialog.showSaveDialog(parent ?? undefined!, {
    title: 'Export catalog backup',
    defaultPath: `switch_catalog_backup_${stamp}.sqlite`,
    filters: [
      { name: 'SQLite database', extensions: ['sqlite', 'db'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  await deps.catalog.backupTo(result.filePath);
  return result.filePath;
}

export function registerFilesIpc(deps: IpcDeps): void {
  handle(IPC.files.chooseDirectory, z.tuple([ChooseDirectoryInputSchema.default({})]), (input) =>
    chooseDirectory(deps, input),
  );
  handle(IPC.files.openBaseGameFolder, z.tuple([GameIdSchema]), async (gameId) => {
    const baseFile = getBaseFile(deps.db, gameId);
    if (!baseFile) throw appError('NOT_FOUND', `No base game file is recorded for game ${gameId}.`);
    const folder = dirname(baseFile.filePath);
    if (!existsSync(folder)) throw appError('FILE_MISSING', `Base game folder is missing: ${folder}`);
    const error = await shell.openPath(folder);
    if (error) throw appError('UNKNOWN_ERROR', `Could not open the base game folder: ${error}`);
  });
  handle(IPC.files.deleteFile, z.tuple([DeleteFileInputSchema]), (input) => deps.files.deleteTrackedFile(input));
  handle(IPC.files.cleanOldUpdates, z.tuple([GameIdSchema, UpdateCleanupPreviewSchema]),
    (gameId, preview) => deps.files.cleanOldUpdates(gameId, preview));
  handle(IPC.files.moveFile, z.tuple([MoveFileInputSchema]), (input) => deps.files.moveTrackedFile(input));
}

/**
 * Folder chooser. Local folders use the Electron dialog; MTP destinations use the
 * Windows Shell picker so the returned path is a shell namespace path, which is
 * then validated by the install service before any write.
 */
async function chooseDirectory(
  deps: IpcDeps,
  input: { title?: string; defaultPath?: string; mtp?: boolean },
): Promise<string | null> {
  const title = input.title ?? 'Choose folder';
  if (input.mtp) {
    const selection = await deps.mtp.pickShellFolder(title);
    return selection ? selection.path : null;
  }
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!parent) throw appError('UNKNOWN_ERROR', 'No application window is available for the folder picker.');
  const result = await dialog.showOpenDialog(parent, {
    title,
    defaultPath: input.defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  const [first] = result.filePaths;
  return first ?? null;
}
