import { createSwitchCatalogApi, type IpcBridge } from '@shared/contracts/bridge';
import type { SwitchCatalogApi } from '@shared/contracts/api';

/**
 * Fallback transport used when the renderer is loaded outside Electron (unit
 * tests, plain browser). Every call fails loudly with a real error envelope
 * instead of throwing a TypeError on an undefined bridge.
 */
const unavailableBridge: IpcBridge = {
  invoke: async () => ({
    ok: false,
    error: {
      code: 'UNKNOWN_ERROR',
      message: 'The preload bridge is unavailable. Run the app through Electron.',
    },
  }),
  subscribe: () => {
    /* no events without Electron */
  },
  unsubscribe: () => {
    /* no events without Electron */
  },
};

let bridgeFactory: () => IpcBridge = () => window.switchCatalogBridge ?? unavailableBridge;
let cached: { api: SwitchCatalogApi } | null = null;

/** Test/DI seam: replaces the transport used by the renderer API. */
export function configureCatalogBridge(factory: () => IpcBridge): void {
  bridgeFactory = factory;
  cached = null;
}

export function getCatalogApi(): SwitchCatalogApi {
  if (!cached) {
    const api = createSwitchCatalogApi(bridgeFactory());
    window.switchCatalog = api;
    cached = { api };
  }
  return cached.api;
}
