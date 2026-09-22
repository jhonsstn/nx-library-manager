import { z } from 'zod';
import { IPC } from '../../shared/contracts/ipc';
import { SettingsUpdateSchema } from '../../shared/schemas/settings';
import { OpenExternalInputSchema } from '../../shared/schemas/inputs';
import { openExternalUrl } from '../lifecycle/window';
import { handle } from './handle';
import type { IpcDeps } from './deps';

export function registerSettingsIpc(deps: IpcDeps): void {
  handle(IPC.settings.get, z.tuple([]), () => deps.settings.load());
  handle(IPC.settings.update, z.tuple([SettingsUpdateSchema]), async (input) => {
    const publicSettings = deps.settings.update(input);
    // HTTP server settings take effect immediately (Qt `_sync_http_server`).
    await deps.httpServer.applySettings();
    return publicSettings;
  });
}

export function registerHttpServerIpc(deps: IpcDeps): void {
  handle(IPC.httpServer.getStatus, z.tuple([]), () => deps.httpServer.getStatus());
  handle(IPC.httpServer.start, z.tuple([]), () => deps.httpServer.start());
  handle(IPC.httpServer.stop, z.tuple([]), () => deps.httpServer.stop());
}

export function registerAppIpc(deps: IpcDeps): void {
  handle(IPC.app.getVersion, z.tuple([]), () => deps.currentVersion);
  handle(IPC.app.getPlatform, z.tuple([]), () => process.platform);
  handle(IPC.app.checkForUpdates, z.tuple([]), () => deps.appUpdate.checkLatestRelease());
  handle(IPC.app.openExternal, z.tuple([OpenExternalInputSchema]), (input) => openExternalUrl(input.url));
  handle(IPC.app.getLegacyDataInfo, z.tuple([]), () => deps.legacy.info());
  handle(IPC.app.importLegacyData, z.tuple([]), () => deps.legacy.import());
  handle(IPC.app.skipLegacyImport, z.tuple([]), () => deps.legacy.skip());
}
