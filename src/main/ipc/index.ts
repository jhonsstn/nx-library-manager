import { registerCatalogIpc, registerFilesIpc } from './catalog.ipc';
import { registerInstallIpc, registerMtpIpc } from './install.ipc';
import { registerMetadataIpc } from './metadata.ipc';
import { registerScanIpc } from './scan.ipc';
import { registerAppIpc, registerHttpServerIpc, registerSettingsIpc } from './system.ipc';
import type { IpcDeps } from './deps';

/**
 * Single registration entry point (spec 03). No other module may call
 * `ipcMain.handle` directly.
 */
export function registerIpc(deps: IpcDeps): void {
  registerCatalogIpc(deps);
  registerScanIpc(deps);
  registerMetadataIpc(deps);
  registerFilesIpc(deps);
  registerInstallIpc(deps);
  registerMtpIpc(deps);
  registerHttpServerIpc(deps);
  registerSettingsIpc(deps);
  registerAppIpc(deps);
}

export type { IpcDeps };
