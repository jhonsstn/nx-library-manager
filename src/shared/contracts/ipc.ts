import type { AppErrorDto } from '../errors/codes';

export const IPC = {
  catalog: {
    listGames: 'catalog:listGames',
    getGame: 'catalog:getGame',
    getGenres: 'catalog:getGenres',
    setFavorite: 'catalog:setFavorite',
    setNeedsReview: 'catalog:setNeedsReview',
    markAsUpdate: 'catalog:markAsUpdate',
    assignUpdates: 'catalog:assignUpdates',
    unmatchUpdates: 'catalog:unmatchUpdates',
    listUpdates: 'catalog:listUpdates',
    exportBackup: 'catalog:exportBackup',
    resetLibrary: 'catalog:resetLibrary',
  },
  scan: {
    start: 'scan:start',
    cancel: 'scan:cancel',
    getStatus: 'scan:getStatus',
  },
  metadata: {
    refresh: 'metadata:refresh',
    bulkRefresh: 'metadata:bulkRefresh',
    cancel: 'metadata:cancel',
    search: 'metadata:search',
    apply: 'metadata:apply',
  },
  files: {
    chooseDirectory: 'files:chooseDirectory',
    deleteFile: 'files:deleteFile',
    moveFile: 'files:moveFile',
  },
  install: {
    create: 'install:create',
    cancel: 'install:cancel',
    retryFailed: 'install:retryFailed',
    list: 'install:list',
  },
  mtp: {
    getStatus: 'mtp:getStatus',
    refresh: 'mtp:refresh',
  },
  httpServer: {
    getStatus: 'httpServer:getStatus',
    start: 'httpServer:start',
    stop: 'httpServer:stop',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    importProdKeys: 'settings:importProdKeys',
    removeProdKeys: 'settings:removeProdKeys',
  },
  app: {
    getVersion: 'app:getVersion',
    getPlatform: 'app:getPlatform',
    checkForUpdates: 'app:checkForUpdates',
    openExternal: 'app:openExternal',
  },
} as const;

export const EVENTS = {
  scanProgress: 'event:scan:progress',
  scanCompleted: 'event:scan:completed',
  metadataBulkProgress: 'event:metadata:bulkProgress',
  installChanged: 'event:install:changed',
  mtpStatusChanged: 'event:mtp:statusChanged',
  httpServerStatusChanged: 'event:httpServer:statusChanged',
  versionsChanged: 'event:versions:changed',
  shutdownStatusChanged: 'event:shutdown:statusChanged',
} as const;

/**
 * Handlers never reject: every IPC call resolves to this envelope so failures
 * cross the process boundary with a stable code instead of a stringified stack.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: AppErrorDto };
