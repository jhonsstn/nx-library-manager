import type { IpcBridge } from '@shared/contracts/bridge';
import type { AppErrorDto } from '@shared/errors/codes';
import type { IpcResult } from '@shared/contracts/ipc';

export type FakeHandler = (args: unknown[]) => unknown;

/**
 * In-memory transport for renderer tests. Handlers are keyed by IPC channel;
 * a missing handler fails the call with an explicit envelope, which keeps tests
 * from silently observing `undefined` data.
 */
export function createFakeBridge(handlers: Record<string, FakeHandler>): IpcBridge {
  const subscriptions = new Map<string, (payload: unknown) => void>();

  return {
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
}

/** Pushes a main-process event into a bridge created by `createFakeBridge`. */
export function emitFakeEvent(bridge: IpcBridge, channel: string, payload: unknown): void {
  // `subscribe` stores the dispatcher; re-subscribing is how tests reach it.
  let captured: ((value: unknown) => void) | null = null;
  bridge.subscribe(channel, (value) => {
    captured = value as (value: unknown) => void;
  });
  if (captured) (captured as unknown as (value: unknown) => void)(payload);
}
