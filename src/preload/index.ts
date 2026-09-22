import { contextBridge, ipcRenderer } from 'electron';
import { ALLOWED_EVENT_CHANNELS, ALLOWED_INVOKE_CHANNELS, type IpcBridge } from '../shared/contracts/bridge';
import type { AppErrorDto } from '../shared/errors/codes';
import type { IpcResult } from '../shared/contracts/ipc';

/**
 * Sandboxed preload (spec 04): exposes exactly two primitive operations, with a
 * fixed channel allowlist, and never hands out `ipcRenderer` itself.
 */
const invokeChannels = new Set(ALLOWED_INVOKE_CHANNELS);
const eventChannels = new Set(ALLOWED_EVENT_CHANNELS);

const dispatchers = new Map<string, (payload: unknown) => void>();

const bridge: IpcBridge = {
  async invoke<T>(channel: string, args: unknown[]): Promise<IpcResult<T>> {
    if (!invokeChannels.has(channel)) {
      const error: AppErrorDto = { code: 'NOT_FOUND', message: `Unsupported channel: ${channel}` };
      return { ok: false, error };
    }
    try {
      return (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
    } catch (thrown) {
      const error: AppErrorDto = {
        code: 'UNKNOWN_ERROR',
        message: thrown instanceof Error ? thrown.message : String(thrown),
      };
      return { ok: false, error };
    }
  },

  subscribe(channel: string, listener: (payload: unknown) => void): void {
    if (!eventChannels.has(channel)) return;
    if (dispatchers.has(channel)) return;
    const handler = (_event: unknown, payload: unknown) => {
      dispatchers.get(channel)?.(payload);
    };
    dispatchers.set(channel, listener);
    ipcRenderer.on(channel, handler);
  },

  unsubscribe(channel: string): void {
    if (!eventChannels.has(channel)) return;
    dispatchers.delete(channel);
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld('switchCatalogBridge', bridge);
