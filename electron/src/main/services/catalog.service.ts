import type { AppDatabase } from '../db/database';
import { withTransaction } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { AppSettings } from '../../shared/types/settings';
import type {
  GameDetailsDto,
  GameFileDto,
  GameSummaryDto,
  PagedResult,
  ScreenshotDto,
  UpdateFileDto,
} from '../../shared/types/domain';
import type {
  AssignUpdatesInput,
  InstallableUpdateDto,
  ListGamesInput,
  ListUpdatesInput,
} from '../../shared/contracts/api';
import { appError } from '../../shared/errors/app-error';
import { rawVersionFromVersionText } from '../../shared/format/versions';
import { displayImageUrl } from '../platform/catalog-image';
import { detectVersion, extractTitleId } from '../scanner/filename-parser';
import { updateFileGroup } from '../scanner/classify-file';
import {
  allGameTitles,
  deleteGame,
  getGame,
  listGames as listGameRows,
  listGenres,
  resetLibrary,
  setFavorite,
  setNeedsReview,
  type GameRecord,
} from '../repositories/games.repository';
import { baseFilesByGame, getBaseFile, listGameFiles, type GameFileRecord } from '../repositories/game-files.repository';
import {
  assignManualMatch,
  getUpdate,
  listAllUpdates,
  listUnmatchedUpdates,
  listUpdatesForGame,
  unmatchUpdates,
  upsertUnmatchedUpdate,
  type UpdateRecord,
} from '../repositories/updates.repository';
import { listScreenshots } from '../repositories/screenshots.repository';
import type { VersionService } from './version.service';

export interface CatalogServiceOptions {
  db: AppDatabase;
  versions: VersionService;
  settings: () => AppSettings;
  logger?: Logger;
}

/**
 * Read model and small mutations for the library views. Repositories own the
 * SQL; this service owns DTO assembly, so the renderer never sees a raw row.
 */
export class CatalogService {
  private readonly db: AppDatabase;
  private readonly versions: VersionService;
  private readonly settings: () => AppSettings;
  private readonly logger: Logger | undefined;

  constructor(options: CatalogServiceOptions) {
    this.db = options.db;
    this.versions = options.versions;
    this.settings = options.settings;
    this.logger = options.logger;
  }

  /**
   * Applies the SQL filters, then the version-dependent `needsUpdate` filter,
   * then paging — matching the Qt build, where the update check ran after the
   * query instead of inside it.
   */
  listGames(input: ListGamesInput = {}): PagedResult<GameSummaryDto> {
    const rows = listGameRows(this.db, {
      search: input.search,
      genre: input.genre ?? undefined,
      favoritesOnly: input.favoritesOnly,
      needsReview: input.needsReview,
      sort: input.sort,
    });
    const baseFiles = baseFilesByGame(this.db);
    const updateGroups = groupUpdates(this.db);
    let summaries = rows.map((row) =>
      this.toSummary(row, baseFiles.get(row.id) ?? null, updateGroups.get(row.id) ?? []),
    );
    if (input.needsUpdate) summaries = summaries.filter((summary) => summary.hasNewerUpdate);
    const total = summaries.length;
    const offset = input.offset ?? 0;
    const items = input.limit === undefined ? summaries.slice(offset) : summaries.slice(offset, offset + input.limit);
    return { items, total };
  }

  getGame(gameId: number): GameDetailsDto {
    const record = getGame(this.db, gameId);
    if (!record) throw appError('NOT_FOUND', `No game with id ${gameId}.`);

    const baseFile = getBaseFile(this.db, gameId);
    const updates = listUpdatesForGame(this.db, gameId);
    const summary = this.toSummary(record, baseFile, updates);
    const localVersions = localVersionsFor(baseFile, updates);
    const titleId = baseFile ? extractTitleId(baseFile.fileName) : '';
    const screenshots = listScreenshots(this.db, gameId, 8).map(
      (row): ScreenshotDto => ({
        id: row.id,
        gameId: row.game_id,
        imageUrl: row.image_url,
        localPath: row.local_path,
        displayUrl: displayImageUrl(row.local_path, row.image_url, 'screenshots') ?? row.image_url,
        sortOrder: row.sort_order,
      }),
    );

    return {
      ...summary,
      description: record.description,
      developer: record.developer,
      publisher: record.publisher,
      trailerUrl: record.trailerUrl,
      dateAdded: record.dateAdded,
      lastScanned: record.lastScanned,
      files: listGameFiles(this.db, gameId),
      updates: updates.map((update) => toUpdateDto(update)),
      screenshots,
      versionStatus: this.versions.statusForTitleId(titleId, localVersions),
      installed: this.versions.installedStatus({
        gameId,
        baseFilePath: baseFile ? baseFile.filePath : null,
        localVersions,
        installFolder: this.settings().defaultInstallFolder,
        installFolderLabel: this.settings().installFolderLabel,
      }),
    };
  }

  getGenres(): string[] {
    return listGenres(this.db);
  }

  setFavorite(gameId: number, favorite: boolean): void {
    this.requireGame(gameId);
    setFavorite(this.db, gameId, favorite);
  }

  setNeedsReview(gameId: number, value: boolean): void {
    this.requireGame(gameId);
    setNeedsReview(this.db, gameId, value);
  }

  /** Ports the Qt "Mark as DLC/update" action: game row out, unmatched update in. */
  markAsUpdate(gameId: number): void {
    const baseFile = getBaseFile(this.db, gameId);
    if (!baseFile) throw appError('NOT_FOUND', `No base game file recorded for game ${gameId}.`);
    withTransaction(this.db, () => {
      upsertUnmatchedUpdate(this.db, {
        gameId: null,
        filePath: baseFile.filePath,
        fileName: baseFile.fileName,
        detectedVersion: detectVersion(baseFile.fileName),
        fileSize: baseFile.fileSize,
        modifiedTime: baseFile.modifiedTime,
        matchConfidence: 0,
      });
      deleteGame(this.db, gameId);
    });
    this.logger?.info('catalog.markedAsUpdate', { gameId, file: baseFile.fileName });
  }

  assignUpdates(input: AssignUpdatesInput): void {
    this.requireGame(input.gameId);
    for (const updateId of input.updateIds) {
      if (!getUpdate(this.db, updateId)) throw appError('NOT_FOUND', `No update with id ${updateId}.`);
    }
    assignManualMatch(this.db, input.updateIds, input.gameId);
    this.logger?.info('catalog.updatesAssigned', { gameId: input.gameId, count: input.updateIds.length });
  }

  unmatchUpdates(updateIds: number[]): void {
    unmatchUpdates(this.db, updateIds);
  }

  listUpdates(input: ListUpdatesInput = {}): InstallableUpdateDto[] {
    const rows = input.unmatchedOnly ? listUnmatchedUpdates(this.db) : listAllUpdates(this.db);
    const titles = allGameTitles(this.db);
    return rows.map((update) => ({
      id: update.id,
      gameId: update.gameId,
      fileName: update.fileName,
      filePath: update.filePath,
      detectedVersion: update.detectedVersion,
      fileSize: update.fileSize,
      group: updateFileGroup(update.fileName),
      gameTitle: update.gameId === null ? null : titles.get(update.gameId) ?? null,
    }));
  }

  /** Copy of the SQLite database to a chosen path (Qt "Export catalog backup"). */
  async backupTo(targetPath: string): Promise<void> {
    try {
      await this.db.backup(targetPath);
    } catch (error) {
      throw appError('DATABASE_ERROR', `Could not write the catalog backup to ${targetPath}.`, { cause: error });
    }
    this.logger?.info('catalog.backupWritten', { targetPath });
  }

  resetLibrary(): void {
    withTransaction(this.db, () => resetLibrary(this.db));
    this.logger?.warn('catalog.libraryReset');
  }

  private requireGame(gameId: number): void {
    if (!getGame(this.db, gameId)) throw appError('NOT_FOUND', `No game with id ${gameId}.`);
  }

  private toSummary(record: GameRecord, baseFile: GameFileRecord | null, updates: UpdateRecord[]): GameSummaryDto {
    const localVersions = localVersionsFor(baseFile, updates);
    const titleId = baseFile ? extractTitleId(baseFile.fileName) : '';
    return {
      id: record.id,
      displayTitle: record.displayTitle,
      cleanedTitle: record.cleanedTitle,
      favorite: record.favorite,
      needsReview: record.needsReview,
      metadataLocked: record.metadataLocked,
      metadataProvider: record.metadataProvider,
      genres: record.genres,
      releaseDate: record.releaseDate,
      coverImageUrl: record.coverImageUrl,
      coverDisplayUrl: displayImageUrl(record.coverImagePath, record.coverImageUrl, 'covers'),
      baseFile: baseFile as GameFileDto | null,
      updateCount: updates.length,
      hasNewerUpdate: titleId !== '' && this.versions.hasNewerUpdate(titleId, localVersions),
    };
  }
}

function groupUpdates(db: AppDatabase): Map<number, UpdateRecord[]> {
  const grouped = new Map<number, UpdateRecord[]>();
  for (const row of listAllUpdates(db)) {
    if (row.gameId === null) continue;
    const list = grouped.get(row.gameId);
    if (list) list.push(row);
    else grouped.set(row.gameId, [row]);
  }
  return grouped;
}

/** Ports `file_version_number` over the base file plus every update file name. */
function localVersionsFor(baseFile: GameFileRecord | null, updates: UpdateRecord[]): number[] {
  const versions = [baseFile ? rawVersionFromVersionText(detectVersion(baseFile.fileName)) : 0];
  for (const update of updates) versions.push(rawVersionFromVersionText(detectVersion(update.fileName)));
  return versions;
}

function toUpdateDto(update: UpdateRecord): UpdateFileDto {
  return {
    id: update.id,
    gameId: update.gameId,
    filePath: update.filePath,
    fileName: update.fileName,
    detectedVersion: update.detectedVersion,
    fileSize: update.fileSize,
    modifiedTime: update.modifiedTime,
    matchConfidence: update.matchConfidence,
    manualMatch: update.manualMatch,
    group: updateFileGroup(update.fileName),
  };
}
