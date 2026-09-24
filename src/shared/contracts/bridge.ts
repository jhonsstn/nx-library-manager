import type { SwitchCatalogApi } from './api';
import { EVENTS, IPC, type IpcResult } from './ipc';
import { SwitchCatalogError } from '../errors/app-error';
import type {
  AppUpdateStatusDto,
  BulkMetadataResultDto,
  FileOperationResultDto,
  GameDetailsDto,
  GameSummaryDto,
  HttpServerStatusDto,
  InstallJobDto,
  InstallPreviewDto,
  JobStartedDto,
  MetadataBulkProgressDto,
  MetadataCandidateDto,
  MtpStatusDto,
  MtpInventoryDto,
  PagedResult,
  ScanCompletedDto,
  ScanProgressDto,
  ScanStatusDto,
  ShutdownStatusDto,
  UpdateCleanupResultDto,
} from '../types/domain';
import type { PublicSettingsDto, SettingsUpdateInput } from '../types/settings';
import type { DeleteFileResultDto } from './results';

/**
 * Primitive transport exposed by the preload script.
 *
 * Deliberately smaller than raw `ipcRenderer`: only the two operations the app
 * needs, with a fixed channel allowlist enforced in the preload.
 */
export interface IpcBridge {
  invoke<T>(channel: string, args: unknown[]): Promise<IpcResult<T>>;
  /** Registers the single dispatcher for a channel; repeat calls replace it. */
  subscribe(channel: string, listener: (payload: unknown) => void): void;
  unsubscribe(channel: string): void;
}

/**
 * Builds the renderer-facing API from a transport.
 *
 * Lives in `shared` (rather than in the preload) so failures are converted into
 * a real `SwitchCatalogError` in the *renderer* realm: Electron's
 * contextBridge strips custom error properties, which would lose `code`.
 */
export function createSwitchCatalogApi(bridge: IpcBridge): SwitchCatalogApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  async function call<T>(channel: string, args: unknown[] = []): Promise<T> {
    const result = await bridge.invoke<T>(channel, args);
    if (!result.ok) throw new SwitchCatalogError(result.error);
    return result.value;
  }

  /** Multiplexes many renderer listeners onto one preload subscription. */
  function on<T>(channel: string, listener: (payload: T) => void): () => void {
    const typed = listener as (payload: unknown) => void;
    let channelListeners = listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      listeners.set(channel, channelListeners);
      bridge.subscribe(channel, (payload) => {
        for (const current of listeners.get(channel) ?? []) current(payload);
      });
    }
    channelListeners.add(typed);
    return () => {
      const current = listeners.get(channel);
      if (!current) return;
      current.delete(typed);
      if (current.size === 0) {
        listeners.delete(channel);
        bridge.unsubscribe(channel);
      }
    };
  }

  return {
    catalog: {
      listGames: (input) => call<PagedResult<GameSummaryDto>>(IPC.catalog.listGames, [input]),
      getGame: (gameId) => call<GameDetailsDto>(IPC.catalog.getGame, [gameId]),
      getGenres: () => call<string[]>(IPC.catalog.getGenres),
      setFavorite: (gameId, favorite) => call<void>(IPC.catalog.setFavorite, [gameId, favorite]),
      setNeedsReview: (gameId, value) => call<void>(IPC.catalog.setNeedsReview, [gameId, value]),
      setHidden: (gameId, hidden) => call<void>(IPC.catalog.setHidden, [gameId, hidden]),
      markAsUpdate: (gameId) => call<void>(IPC.catalog.markAsUpdate, [gameId]),
      assignUpdates: (input) => call<void>(IPC.catalog.assignUpdates, [input]),
      unmatchUpdates: (updateIds) => call<void>(IPC.catalog.unmatchUpdates, [updateIds]),
      listUpdates: (input) => call(IPC.catalog.listUpdates, [input]),
      exportBackup: () => call<string | null>(IPC.catalog.exportBackup),
      resetLibrary: () => call<void>(IPC.catalog.resetLibrary),
    },
    scan: {
      start: (input) => call<JobStartedDto>(IPC.scan.start, [input]),
      cancel: (jobId) => call<void>(IPC.scan.cancel, [jobId]),
      getStatus: (jobId) => call<ScanStatusDto>(IPC.scan.getStatus, [jobId]),
      onProgress: async (listener) => on<ScanProgressDto>(EVENTS.scanProgress, listener),
      onCompleted: async (listener) => on<ScanCompletedDto>(EVENTS.scanCompleted, listener),
    },
    metadata: {
      refresh: (gameId) => call<JobStartedDto>(IPC.metadata.refresh, [gameId]),
      bulkRefresh: (input) => call<JobStartedDto>(IPC.metadata.bulkRefresh, [input]),
      cancel: (jobId) => call<void>(IPC.metadata.cancel, [jobId]),
      search: (gameId, query) => call<MetadataCandidateDto[]>(IPC.metadata.search, [gameId, query]),
      apply: (gameId, candidate) => call<GameDetailsDto>(IPC.metadata.apply, [gameId, candidate]),
      onBulkProgress: async (listener) => on<MetadataBulkProgressDto>(EVENTS.metadataBulkProgress, listener),
    },
    files: {
      chooseDirectory: (input) => call<string | null>(IPC.files.chooseDirectory, [input]),
      deleteFile: (input) => call<DeleteFileResultDto>(IPC.files.deleteFile, [input]),
      cleanOldUpdates: (gameId, preview) => call<UpdateCleanupResultDto>(IPC.files.cleanOldUpdates, [gameId, preview]),
      moveFile: (input) => call<FileOperationResultDto>(IPC.files.moveFile, [input]),
    },
    install: {
      preview: (input) => call<InstallPreviewDto>(IPC.install.preview, [input]),
      create: (input) => call<InstallJobDto[]>(IPC.install.create, [input]),
      cancel: (jobId) => call<void>(IPC.install.cancel, [jobId]),
      retryFailed: () => call<InstallJobDto[]>(IPC.install.retryFailed),
      list: () => call<InstallJobDto[]>(IPC.install.list),
      onChanged: async (listener) => on<InstallJobDto>(EVENTS.installChanged, listener),
    },
    mtp: {
      getStatus: () => call<MtpStatusDto>(IPC.mtp.getStatus),
      refresh: () => call<MtpStatusDto>(IPC.mtp.refresh),
      getInventory: () => call<MtpInventoryDto>(IPC.mtp.getInventory),
      refreshInventory: () => call<MtpInventoryDto>(IPC.mtp.refreshInventory),
      onStatusChanged: async (listener) => on<MtpStatusDto>(EVENTS.mtpStatusChanged, listener),
      onInventoryChanged: async (listener) => on<MtpInventoryDto>(EVENTS.mtpInventoryChanged, listener),
    },
    httpServer: {
      getStatus: () => call<HttpServerStatusDto>(IPC.httpServer.getStatus),
      start: () => call<HttpServerStatusDto>(IPC.httpServer.start),
      stop: () => call<HttpServerStatusDto>(IPC.httpServer.stop),
      onStatusChanged: async (listener) => on<HttpServerStatusDto>(EVENTS.httpServerStatusChanged, listener),
    },
    settings: {
      get: () => call<PublicSettingsDto>(IPC.settings.get),
      update: (input: SettingsUpdateInput) => call<PublicSettingsDto>(IPC.settings.update, [input]),
      importProdKeys: () => call<boolean>(IPC.settings.importProdKeys),
      removeProdKeys: () => call<void>(IPC.settings.removeProdKeys),
    },
    app: {
      getVersion: () => call<string>(IPC.app.getVersion),
      getPlatform: () => call<string>(IPC.app.getPlatform),
      checkForUpdates: () => call<AppUpdateStatusDto>(IPC.app.checkForUpdates),
      openExternal: (url) => call<void>(IPC.app.openExternal, [url]),
      onVersionsChanged: async (listener) => on<void>(EVENTS.versionsChanged, listener),
      onShutdownStatus: async (listener) => on<ShutdownStatusDto>(EVENTS.shutdownStatusChanged, listener),
    },
  };
}

/** Channels the preload will transport; anything else is rejected before IPC. */
export const ALLOWED_INVOKE_CHANNELS: readonly string[] = Object.values(IPC).flatMap((group) =>
  Object.values(group),
);

export const ALLOWED_EVENT_CHANNELS: readonly string[] = Object.values(EVENTS);

/** Type-level guard so `BulkMetadataResultDto` stays referenced by the API contract. */
export type BridgeResultTypes = BulkMetadataResultDto;
