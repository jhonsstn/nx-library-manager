# 03 — IPC Contract

## Goal

Expose a small, typed, validated application API to React without exposing Electron IPC primitives or Node.js APIs.

## Public renderer API

Suggested surface:

```ts
interface SwitchCatalogApi {
  catalog: {
    listGames(input?: ListGamesInput): Promise<PagedResult<GameSummaryDto>>;
    getGame(gameId: number): Promise<GameDetailsDto>;
    setFavorite(gameId: number, favorite: boolean): Promise<void>;
    setNeedsReview(gameId: number, value: boolean): Promise<void>;
  };

  scan: {
    start(input?: ScanInput): Promise<JobStartedDto>;
    cancel(jobId: string): Promise<void>;
    getStatus(jobId: string): Promise<ScanStatusDto>;
    onProgress(listener: (event: ScanProgressDto) => void): Unsubscribe;
    onCompleted(listener: (event: ScanCompletedDto) => void): Unsubscribe;
  };

  metadata: {
    refresh(gameId: number): Promise<JobStartedDto>;
    search(gameId: number, query?: string): Promise<MetadataCandidateDto[]>;
    apply(gameId: number, candidateId: string): Promise<GameDetailsDto>;
  };

  files: {
    chooseDirectory(input?: ChooseDirectoryInput): Promise<string | null>;
    deleteFile(input: DeleteFileInput): Promise<void>;
    moveFile(input: MoveFileInput): Promise<FileOperationResultDto>;
  };

  install: {
    create(input: CreateInstallInput): Promise<InstallQueueDto>;
    cancel(jobId: number): Promise<void>;
    list(): Promise<InstallJobDto[]>;
    onChanged(listener: (event: InstallJobDto) => void): Unsubscribe;
  };

  mtp: {
    getStatus(): Promise<MtpStatusDto>;
    refresh(): Promise<MtpStatusDto>;
    onStatusChanged(listener: (event: MtpStatusDto) => void): Unsubscribe;
  };

  httpServer: {
    getStatus(): Promise<HttpServerStatusDto>;
    start(): Promise<HttpServerStatusDto>;
    stop(): Promise<HttpServerStatusDto>;
  };

  settings: {
    get(): Promise<PublicSettingsDto>;
    update(input: SettingsUpdateInput): Promise<PublicSettingsDto>;
  };

  app: {
    getVersion(): Promise<string>;
    checkForUpdates(): Promise<AppUpdateStatusDto>;
    openExternal(url: string): Promise<void>;
  };
}
```

## Contract rules

1. Every command input is parsed with Zod in the main process.
2. Numeric IDs must be positive integers.
3. File operations must resolve their targets against server-side records or approved directories; renderer-provided arbitrary paths are not trusted by default.
4. All IPC failures are serialized to a stable error envelope.
5. Events include a job ID where jobs may overlap.
6. Preload returns unsubscribe callbacks for all event subscriptions.

## Error envelope

```ts
interface AppErrorDto {
  code: AppErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}
```

Suggested codes:

```text
VALIDATION_ERROR
NOT_FOUND
FILE_MISSING
PERMISSION_DENIED
PATH_NOT_ALLOWED
JOB_ALREADY_RUNNING
JOB_CANCELLED
DATABASE_ERROR
NETWORK_ERROR
METADATA_AUTH_ERROR
METADATA_RATE_LIMITED
MTP_NOT_CONNECTED
MTP_DESTINATION_NOT_FOUND
MTP_COPY_FAILED
HTTP_PORT_IN_USE
HTTP_SERVER_ERROR
UPDATE_CHECK_FAILED
UNKNOWN_ERROR
```

## Scan events

```ts
interface ScanProgressDto {
  jobId: string;
  phase: 'discovering' | 'classifying' | 'matching' | 'reconciling';
  checkedFiles: number;
  candidateFiles: number;
  gamesFound: number;
  updatesFound: number;
  currentPath?: string;
  percent?: number;
}
```

Completion:

```ts
interface ScanCompletedDto {
  jobId: string;
  cancelled: boolean;
  checkedFiles: number;
  gamesFound: number;
  updatesFound: number;
  unmatchedUpdates: number;
  elapsedMs: number;
}
```

## Install events

```ts
interface InstallJobDto {
  id: number;
  gameId?: number;
  sourcePath: string;
  displayName: string;
  destinationType: 'folder' | 'mtp-sd' | 'mtp-nand';
  sizeBytes: number;
  transferredBytes: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: AppErrorDto;
}
```

## Security-sensitive settings

`settings.get()` should not automatically return secrets in cleartext just because the settings page loads.

Preferred UI shape:

```ts
interface PublicSettingsDto {
  igdbClientId: string;
  igdbClientSecretConfigured: boolean;
  httpPasswordConfigured: boolean;
  // ...normal settings
}
```

Secret replacement fields are write-only where possible.

## IPC registration

Main should have one central registration function:

```ts
registerCatalogIpc(deps);
registerScanIpc(deps);
registerMetadataIpc(deps);
registerInstallIpc(deps);
registerSettingsIpc(deps);
registerMtpIpc(deps);
registerHttpServerIpc(deps);
```

No feature should register ad hoc handlers from arbitrary files.
