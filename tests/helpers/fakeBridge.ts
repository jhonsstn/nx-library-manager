import type { IpcBridge } from '@shared/contracts/bridge';
import type { AppErrorDto } from '@shared/errors/codes';
import type { IpcResult } from '@shared/contracts/ipc';

export type FakeHandler = (args: unknown[]) => unknown;
const bridgeSubscriptions = new WeakMap<IpcBridge, Map<string, (payload: unknown) => void>>();

/**
 * In-memory transport for renderer tests. Handlers are keyed by IPC channel;
 * a missing handler fails the call with an explicit envelope, which keeps tests
 * from silently observing `undefined` data.
 */
export function createFakeBridge(handlers: Record<string, FakeHandler>): IpcBridge {
  const subscriptions = new Map<string, (payload: unknown) => void>();

  const bridge: IpcBridge = {
    async invoke<T>(channel: string, args: unknown[]): Promise<IpcResult<T>> {
      const handler = handlers[channel];
      if (!handler) {
        const error: AppErrorDto = { code: 'NOT_FOUND', message: `No fake handler for ${channel}` };
        return { ok: false, error };
      }
      try {
        return { ok: true, value: (await handler(args)) as T };
      } catch (thrown) {
        const error: AppErrorDto = {
          code: 'UNKNOWN_ERROR',
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
        return { ok: false, error };
      }
    },
    subscribe(channel, listener) {
      subscriptions.set(channel, listener);
    },
    unsubscribe(channel) {
      subscriptions.delete(channel);
    },
  };
  bridgeSubscriptions.set(bridge, subscriptions);
  return bridge;
}

/** Pushes a main-process event into a bridge created by `createFakeBridge`. */
export function emitFakeEvent(bridge: IpcBridge, channel: string, payload: unknown): void {
  bridgeSubscriptions.get(bridge)?.get(channel)?.(payload);
}
