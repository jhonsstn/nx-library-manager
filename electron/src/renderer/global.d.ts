import type { IpcBridge } from '@shared/contracts/bridge';
import type { SwitchCatalogApi } from '@shared/contracts/api';

declare global {
  interface Window {
    /** Exposed by the preload script; the only transport the renderer gets. */
    switchCatalogBridge?: IpcBridge;
    /** Convenience handle installed by `src/renderer/api.ts`. */
    switchCatalog?: SwitchCatalogApi;
  }
}

export {};
