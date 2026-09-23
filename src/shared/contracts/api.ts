import type {
  AppUpdateStatusDto,
  FileOperationResultDto,
  GameDetailsDto,
  GameSummaryDto,
  HttpServerStatusDto,
  InstallJobDto,
  JobStartedDto,
  MetadataBulkProgressDto,
  MetadataCandidateDto,
  MtpStatusDto,
  PagedResult,
  ScanCompletedDto,
  ScanProgressDto,
  ScanStatusDto,
  ShutdownStatusDto,
  UpdateCleanupPreviewDto,
  UpdateCleanupResultDto,
} from '../types/domain';
import type { PublicSettingsDto, SettingsUpdateInput } from '../types/settings';
import type { DeleteFileResultDto } from './results';

export interface ListGamesInput {
  search?: string;
  genre?: string | null;
  favoritesOnly?: boolean;
  needsReview?: boolean;
  needsUpdate?: boolean;
  hiddenOnly?: boolean;
  sort?: 'title-asc' | 'title-desc' | 'added-desc';
  limit?: number;
  offset?: number;
}

export interface ScanInput {
  baseFolder?: string;
  updatesFolder?: string;
  recursive?: boolean;
  threshold?: number;
  /** Wipes catalog rows before scanning. Defaults to false. */
  resetLibrary?: boolean;
}

export interface ChooseDirectoryInput {
  title?: string;
  defaultPath?: string;
  /** When true the dialog browses the Windows Shell namespace for MTP folders. */
  mtp?: boolean;
}

export type InstallDestination =
  | { type: 'folder'; path: string }
  | { type: 'mtp'; storage: 'sd' | 'nand' };

export interface CreateInstallInput {
  gameId?: number | null;
  updateIds?: number[];
  /** Defaults to true when `gameId` is provided. */
  includeBaseFile?: boolean;
  destination: InstallDestination;
}

export type DeleteFileInput = { kind: 'game'; gameId: number } | { kind: 'update'; updateId: number };

export type MoveFileInput =
  | { kind: 'game'; gameId: number; destinationFolder: string }
  | { kind: 'update'; updateId: number; destinationFolder: string };

export interface AssignUpdatesInput {
  gameId: number;
  updateIds: number[];
}

export interface ListUpdatesInput {
  unmatchedOnly?: boolean;
}

/** The API surface exposed to the renderer as `window.switchCatalog`. */
export interface SwitchCatalogApi {
  catalog: {
    listGames(input?: ListGamesInput): Promise<PagedResult<GameSummaryDto>>;
    getGame(gameId: number): Promise<GameDetailsDto>;
    getGenres(): Promise<string[]>;
    setFavorite(gameId: number, favorite: boolean): Promise<void>;
    setNeedsReview(gameId: number, value: boolean): Promise<void>;
    setHidden(gameId: number, hidden: boolean): Promise<void>;
    markAsUpdate(gameId: number): Promise<void>;
    assignUpdates(input: AssignUpdatesInput): Promise<void>;
    unmatchUpdates(updateIds: number[]): Promise<void>;
    listUpdates(input?: ListUpdatesInput): Promise<InstallableUpdateDto[]>;
    exportBackup(): Promise<string | null>;
    resetLibrary(): Promise<void>;
  };

  scan: {
    start(input?: ScanInput): Promise<JobStartedDto>;
    cancel(jobId: string): Promise<void>;
    getStatus(jobId: string): Promise<ScanStatusDto>;
    onProgress(listener: (event: ScanProgressDto) => void): Promise<() => void>;
    onCompleted(listener: (event: ScanCompletedDto) => void): Promise<() => void>;
  };

  metadata: {
    refresh(gameId: number): Promise<JobStartedDto>;
    bulkRefresh(input?: { force?: boolean; limit?: number }): Promise<JobStartedDto>;
    cancel(jobId: string): Promise<void>;
    search(gameId: number, query?: string): Promise<MetadataCandidateDto[]>;
    apply(gameId: number, candidate: MetadataCandidateDto): Promise<GameDetailsDto>;
    onBulkProgress(listener: (event: MetadataBulkProgressDto) => void): Promise<() => void>;
  };

  files: {
    chooseDirectory(input?: ChooseDirectoryInput): Promise<string | null>;
    deleteFile(input: DeleteFileInput): Promise<DeleteFileResultDto>;
    cleanOldUpdates(gameId: number, preview: UpdateCleanupPreviewDto): Promise<UpdateCleanupResultDto>;
    moveFile(input: MoveFileInput): Promise<FileOperationResultDto>;
  };

  install: {
    create(input: CreateInstallInput): Promise<InstallJobDto[]>;
    cancel(jobId: number): Promise<void>;
    retryFailed(): Promise<InstallJobDto[]>;
    list(): Promise<InstallJobDto[]>;
    onChanged(listener: (event: InstallJobDto) => void): Promise<() => void>;
  };

  mtp: {
    getStatus(): Promise<MtpStatusDto>;
    refresh(): Promise<MtpStatusDto>;
    onStatusChanged(listener: (event: MtpStatusDto) => void): Promise<() => void>;
  };

  httpServer: {
    getStatus(): Promise<HttpServerStatusDto>;
    start(): Promise<HttpServerStatusDto>;
    stop(): Promise<HttpServerStatusDto>;
    onStatusChanged(listener: (event: HttpServerStatusDto) => void): Promise<() => void>;
  };

  settings: {
    get(): Promise<PublicSettingsDto>;
    update(input: SettingsUpdateInput): Promise<PublicSettingsDto>;
    importProdKeys(): Promise<boolean>;
    removeProdKeys(): Promise<void>;
  };

  app: {
    getVersion(): Promise<string>;
    getPlatform(): Promise<string>;
    checkForUpdates(): Promise<AppUpdateStatusDto>;
    openExternal(url: string): Promise<void>;
    onVersionsChanged(listener: () => void): Promise<() => void>;
    onShutdownStatus(listener: (event: ShutdownStatusDto) => void): Promise<() => void>;
  };
}

/** Row shape used by the Unmatched Updates list. */
export interface InstallableUpdateDto {
  id: number;
  gameId: number | null;
  fileName: string;
  filePath: string;
  detectedVersion: string;
  fileSize: number;
  group: 'Updates' | 'DLC';
  gameTitle: string | null;
}
