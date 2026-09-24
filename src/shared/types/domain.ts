import type { AppErrorDto } from '../errors/codes';

export type Unsubscribe = () => void;

export type GameFileKind = 'base' | 'update' | 'dlc';

export type ScanPhase = 'discovering' | 'classifying' | 'matching' | 'reconciling';

export type UpdateStatusKind =
  | 'loading'
  | 'unknown'
  | 'current'
  | 'update-available'
  | 'local-newer'
  | 'missing-local-version';

export type InstallJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type InstallDestinationType = 'folder' | 'mtp-sd' | 'mtp-nand';

export type UpdateGroupName = 'Updates' | 'DLC';

export interface PagedResult<T> {
  items: T[];
  total: number;
}

export interface JobStartedDto {
  jobId: string;
}

export interface GameFileDto {
  id: number;
  gameId: number;
  filePath: string;
  fileName: string;
  fileExtension: string;
  fileSize: number;
  modifiedTime: number;
  fileType: string;
  isBaseGame: boolean;
}

export interface UpdateFileDto {
  id: number;
  gameId: number | null;
  filePath: string;
  fileName: string;
  detectedVersion: string;
  fileSize: number;
  modifiedTime: number;
  matchConfidence: number;
  manualMatch: boolean;
  group: UpdateGroupName;
}

export interface ScreenshotDto {
  id: number;
  gameId: number;
  imageUrl: string;
  localPath: string | null;
  /** `catalog-image://` URL when cached locally, otherwise the origin URL. */
  displayUrl: string;
  sortOrder: number;
}

export interface VersionInfoDto {
  version: number;
  releaseDate: string;
}

export interface VersionStatusDto {
  kind: UpdateStatusKind;
  localVersion: number;
  latest: VersionInfoDto | null;
  newer: VersionInfoDto[];
  /** Only populated when a verified patch version can be compared with TitleDB. */
  missingUpdate?: VersionInfoDto | null;
  uncertainty?: string | null;
}

export interface UpdateCleanupFileDto {
  filePath: string;
  fileName: string;
  fileSize: number;
  modifiedTime: number;
  rawVersion: number;
}

export interface UpdateCleanupPreviewDto {
  latestLocalVersion: number | null;
  keepFiles: UpdateCleanupFileDto[];
  deleteFiles: UpdateCleanupFileDto[];
}

export interface UpdateCleanupResultDto {
  deletedFiles: number;
  freedBytes: number;
}

export interface ContainedTitleDto {
  titleId: string | null;
  baseTitleId: string | null;
  type: GameFileKind;
  name: string;
  rawVersion: number | null;
  source: string;
  filePath: string;
  provisional: boolean;
  inspectionError: string | null;
}

export interface KnownDlcDto {
  titleId: string;
  name: string;
  nameSource: 'titledb' | 'package' | 'filename' | 'title-id';
  filePresent: boolean;
  switchStatus?: 'installed' | 'not-installed' | 'unknown';
}

export type MtpInventoryState = 'disconnected' | 'scanning' | 'ready' | 'partial' | 'unavailable' | 'error';
export interface MtpInstalledTitleDto {
  titleId: string;
  type: GameFileKind;
  rawVersion: number | null;
}
export interface MtpInventoryDto {
  state: MtpInventoryState;
  deviceId: string | null;
  revision: number;
  checkedAt: string | null;
  titles: MtpInstalledTitleDto[];
  unidentifiedFiles: number;
  message: string | null;
}
export type SwitchPresence = 'installed' | 'not-installed' | 'unknown';
export interface SwitchGameStatusDto {
  base: SwitchPresence;
  update: SwitchPresence;
  updateVersion: number | null;
  localContentReady: boolean;
}

export interface InstalledStatusDto {
  rawVersion: number;
  source: 'install-history' | 'catalog-path';
  destinationLabel: string | null;
  destinationFolder: string | null;
  completedAt: string | null;
}

export interface GameSummaryDto {
  id: number;
  displayTitle: string;
  cleanedTitle: string;
  favorite: boolean;
  hidden: boolean;
  needsReview: boolean;
  metadataLocked: boolean;
  metadataProvider: string | null;
  genres: string[];
  releaseDate: string | null;
  coverImageUrl: string | null;
  /** `catalog-image://` URL when cached locally, otherwise the origin URL. */
  coverDisplayUrl: string | null;
  baseFile: GameFileDto | null;
  updateCount: number;
  hasNewerUpdate: boolean;
  hasCleanableUpdates: boolean;
  titleId?: string | null;
  switchStatus?: SwitchGameStatusDto | null;
}

export interface GameDetailsDto extends GameSummaryDto {
  description: string;
  developer: string;
  publisher: string;
  trailerUrl: string | null;
  dateAdded: string;
  lastScanned: string;
  files: GameFileDto[];
  updates: UpdateFileDto[];
  screenshots: ScreenshotDto[];
  versionStatus: VersionStatusDto;
  updateCleanup?: UpdateCleanupPreviewDto;
  installed: InstalledStatusDto | null;
  containedTitles?: ContainedTitleDto[];
  knownDlc?: KnownDlcDto[];
  knownDlcRefreshedAt?: string | null;
  localDlc?: KnownDlcDto[];
}

export interface ScanProgressDto {
  jobId: string;
  phase: ScanPhase;
  checkedFiles: number;
  candidateFiles: number;
  gamesFound: number;
  updatesFound: number;
  currentPath?: string;
  percent?: number;
}

export interface ScanCompletedDto {
  jobId: string;
  cancelled: boolean;
  checkedFiles: number;
  gamesFound: number;
  updatesFound: number;
  unmatchedUpdates: number;
  elapsedMs: number;
  error: AppErrorDto | null;
}

export interface ScanStatusDto {
  jobId: string;
  running: boolean;
  cancelled: boolean;
  phase: ScanPhase;
  progress: ScanProgressDto;
  summary: ScanCompletedDto | null;
}

export interface MetadataCandidateDto {
  provider: string;
  providerId: string;
  title: string;
  description: string;
  releaseDate: string;
  developer: string;
  publisher: string;
  genres: string[];
  coverImageUrl: string;
  trailerUrl: string;
  screenshots: string[];
  confidence: number;
}

export interface MetadataBulkProgressDto {
  jobId: string;
  total: number;
  processed: number;
  updated: number;
  noMatch: number;
  failed: number;
  currentTitle: string;
  done: boolean;
  cancelled: boolean;
}

export interface InstallJobDto {
  id: number;
  gameId: number | null;
  sourcePath: string;
  displayName: string;
  destinationType: InstallDestinationType;
  destinationFolder: string;
  destinationLabel: string | null;
  destinationPath: string | null;
  fileKind: GameFileKind;
  detectedVersion: string;
  rawVersion: number;
  sizeBytes: number;
  transferredBytes: number;
  status: InstallJobStatus;
  error: AppErrorDto | null;
  createdAt: string;
  completedAt: string | null;
}

export interface InstallPreviewItemDto {
  filePath: string;
  fileName: string;
  fileSize: number;
  assessment: 'needed' | 'already-installed' | 'unknown' | 'older-update';
  reason: string;
  selectedByDefault: boolean;
  includesAlreadyInstalled: boolean;
  includeBaseFile: boolean;
  updateIds: number[];
}
export interface InstallPreviewDto {
  inventoryRevision: number;
  inventoryState: MtpInventoryState;
  items: InstallPreviewItemDto[];
}

export interface MtpStorageInfoDto {
  id: 'sd' | 'nand' | 'other';
  label: string;
  shellPath: string;
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface MtpStatusDto {
  available: boolean;
  adapter: 'powershell';
  storages: MtpStorageInfoDto[];
  /** Ready-to-display summary, e.g. `NAND install: 1.2 GB free / 4.0 GB | SD install: ...`. */
  statusText: string;
  checkedAt: string;
  error: AppErrorDto | null;
  deviceId?: string | null;
}

export interface HttpServerStatusDto {
  running: boolean;
  port: number;
  /** LAN directory URL to paste into DBI, e.g. `http://192.168.1.10:8000/dir/`. */
  directoryUrl: string;
  authEnabled: boolean;
  error: AppErrorDto | null;
}

export interface AppUpdateStatusDto {
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseUrl: string;
  updateAvailable: boolean;
}

export interface ShutdownStatusDto {
  phase: 'waiting' | 'closing';
  message: string;
}

export interface FileOperationResultDto {
  id: number;
  sourcePath: string;
  destinationPath: string;
}

export interface BulkMetadataResultDto {
  attempted: number;
  updated: number;
  noMatch: number;
  failed: number;
}

export interface DirectoryEntryDto {
  path: string;
  name: string;
}
