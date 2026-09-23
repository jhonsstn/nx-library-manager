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
import { displayImageUrl } from '../platform/catalog-image';
import { detectVersion } from '../scanner/filename-parser';
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
import { contentsForGame, type ContainedTitle } from '../repositories/title-catalog.repository';

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
   * then paging, with update availability applied after the
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
    const contents = contentsForGame(this.db, gameId);
    const titleId = verifiedBaseTitleId(contents);
    const localVersions = verifiedPatchVersions(contents,titleId);
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

    const localDlcRows = (titleId ? this.db.prepare(`SELECT DISTINCT t.title_id FROM titles t
      JOIN file_titles ft ON ft.title_id=t.id WHERE t.type='dlc' AND t.base_title_id=?`)
      .all(titleId) : []) as Array<{ title_id: string }>;
    const localDlcIds = new Set(localDlcRows.map((row) => row.title_id));
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
      versionStatus: this.verifiedVersionStatus(titleId, contents),
      containedTitles: contents,
      knownDlc: titleId ? this.versions.dlcIndex.forBase(titleId).map((entry) => ({
        titleId: entry.titleId, name: entry.name ?? entry.titleId,
        filePresent: localDlcIds.has(entry.titleId),
      })) : [],
      knownDlcRefreshedAt: this.versions.dlcIndex.refreshedAt,
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

  /** Moves a game row out of the catalog and reclassifies its file as unmatched update/DLC. */
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

  /** Copies the SQLite database to a chosen backup path. */
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
    const contents = contentsForGame(this.db, record.id);
    const titleId = verifiedBaseTitleId(contents);
    const status = this.verifiedVersionStatus(titleId, contents);
    const updatePaths = new Set(contents.filter((item) => item.type === 'update').map((item) => item.filePath));
    for (const update of updates) {
      if (!contents.some((item) => item.filePath === update.filePath)
        && updateFileGroup(update.fileName) === 'Updates') updatePaths.add(update.filePath);
    }
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
      updateCount: updatePaths.size,
      hasNewerUpdate: Boolean(status.missingUpdate),
      titleId: titleId || null,
    };
  }

  private verifiedVersionStatus(titleId: string, contents: ContainedTitle[]) {
    const patches = contents.filter((item) => item.type === 'update'
      && (!item.baseTitleId || item.baseTitleId === titleId));
    const base = contents.find((item) => item.type === 'base' && !item.provisional);
    const uncertain = !this.versions.dlcIndex.patchIds
      ? 'TitleDB title-type index is unavailable.'
      : !titleId || !base || base.source !== 'cnmt'
      ? 'Base title has not been verified from CNMT.'
      : patches.some((item) => item.provisional || item.rawVersion === null)
        ? 'A local patch version could not be verified.' : null;
    const localVersions = verifiedPatchVersions(contents,titleId);
    const status = this.versions.statusForTitleId(titleId, localVersions);
    if (uncertain || !status.latest) return { ...status, kind: 'unknown' as const,
      newer: [], missingUpdate: null, uncertainty: uncertain ?? 'TitleDB has no release data.' };
    return { ...status, missingUpdate: status.newer[0] ?? null, uncertainty: null };
  }
}

function verifiedBaseTitleId(contents: ContainedTitle[]): string {
  return contents.find((item) => item.type === 'base' && !item.provisional)?.titleId ?? '';
}

function verifiedPatchVersions(contents: ContainedTitle[], titleId: string): number[] {
  return contents.filter((item) => item.type === 'update' && item.baseTitleId === titleId
      && !item.provisional && item.rawVersion !== null)
    .map((item) => item.rawVersion as number);
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
