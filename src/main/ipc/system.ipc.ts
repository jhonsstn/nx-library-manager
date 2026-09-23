import { z } from 'zod';
import { BrowserWindow, dialog } from 'electron';
import { IPC } from '../../shared/contracts/ipc';
import { SettingsUpdateSchema } from '../../shared/schemas/settings';
import { OpenExternalInputSchema } from '../../shared/schemas/inputs';
import { openExternalUrl } from '../lifecycle/window';
import { handle } from './handle';
import type { IpcDeps } from './deps';
import { updateSettingsTransactional } from '../settings/update-settings';
import { resolveScanInput } from './scan.ipc';

export function registerSettingsIpc(deps: IpcDeps): void {
  handle(IPC.settings.get, z.tuple([]), () => ({ ...deps.settings.load(), prodKeysConfigured: deps.prodKeys.available }));
  handle(IPC.settings.update, z.tuple([SettingsUpdateSchema]), async (input) => ({
    ...await updateSettingsTransactional(deps, input), prodKeysConfigured: deps.prodKeys.available,
  }));
  handle(IPC.settings.importProdKeys, z.tuple([]), async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!parent) return false;
    const result = await dialog.showOpenDialog(parent, {
      title: 'Import prod.keys', properties: ['openFile'],
      filters: [{ name: 'Switch keys', extensions: ['keys'] }],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    deps.prodKeys.importFile(result.filePaths[0]);
    scheduleKeyRescan(deps);
    return true;
  });
  handle(IPC.settings.removeProdKeys, z.tuple([]), async () => {
    deps.prodKeys.remove();
    scheduleKeyRescan(deps);
  });
}

function scheduleKeyRescan(deps: IpcDeps): void {
  const settings = deps.settings.getFull();
  if (!settings.baseGamesFolder) return;
  void deps.scanner.whenIdle().then(() => deps.scanner.start(resolveScanInput(settings, {})))
    .catch((error: unknown) => deps.logger.warn('scan.afterKeyChangeFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }));
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
}
