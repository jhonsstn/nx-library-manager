import { describe, expect, it } from 'vitest';
import { createSwitchCatalogApi, type IpcBridge } from '@shared/contracts/bridge';
import { EVENTS, IPC, type IpcResult } from '@shared/contracts/ipc';
import type { AppErrorCode } from '@shared/errors/codes';
import { SwitchCatalogError } from '@shared/errors/app-error';

interface RecordedBridge {
  bridge: IpcBridge;
  calls: Array<{ channel: string; args: unknown[] }>;
  subscriptions: Array<{ channel: string; listener: (payload: unknown) => void }>;
  unsubscribed: string[];
}

function recordingBridge(handler: (channel: string, args: unknown[]) => unknown = () => undefined): RecordedBridge {
  const calls: RecordedBridge['calls'] = [];
  const subscriptions: RecordedBridge['subscriptions'] = [];
  const unsubscribed: string[] = [];
  return {
    calls,
    subscriptions,
    unsubscribed,
    bridge: {
      async invoke<T>(channel: string, args: unknown[]) {
        calls.push({ channel, args });
        return { ok: true, value: (await handler(channel, args)) as T };
      },
      subscribe(channel, listener) {
        subscriptions.push({ channel, listener });
      },
      unsubscribe(channel) {
        unsubscribed.push(channel);
      },
    },
  };
}

function failingBridge(code: AppErrorCode, message: string): IpcBridge {
  return {
    async invoke<T>(): Promise<IpcResult<T>> {
      return { ok: false, error: { code, message } };
    },
    subscribe() {
      /* no events */
    },
    unsubscribe() {
      /* no events */
    },
  };
}

describe('createSwitchCatalogApi', () => {
  it('unwraps a successful envelope into the plain value', async () => {
    const { bridge } = recordingBridge(() => ['Action', 'RPG']);
    const api = createSwitchCatalogApi(bridge);
    await expect(api.catalog.getGenres()).resolves.toEqual(['Action', 'RPG']);
  });

  it('forwards the channel and the ordered argument tuple', async () => {
    const recorded = recordingBridge();
    const api = createSwitchCatalogApi(recorded.bridge);
    await api.catalog.setFavorite(7, true);
    expect(recorded.calls).toEqual([{ channel: IPC.catalog.setFavorite, args: [7, true] }]);
  });

  it('rehydrates a failed envelope as a SwitchCatalogError carrying the code', async () => {
    const api = createSwitchCatalogApi(failingBridge('NOT_FOUND', 'No game with id 3.'));
    const error = await api.catalog.getGame(3).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SwitchCatalogError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'No game with id 3.' });
  });

  it('multiplexes event listeners onto one subscription and unsubscribes with the last', async () => {
    const recorded = recordingBridge();
    const api = createSwitchCatalogApi(recorded.bridge);
    const first: string[] = [];
    const second: string[] = [];

    const offFirst = await api.scan.onProgress((event) => first.push(event.phase));
    const offSecond = await api.scan.onProgress((event) => second.push(event.phase));

    expect(recorded.subscriptions).toHaveLength(1);
    expect(recorded.subscriptions[0].channel).toBe(EVENTS.scanProgress);

    recorded.subscriptions[0].listener({ phase: 'classifying' });
    expect(first).toEqual(['classifying']);
    expect(second).toEqual(['classifying']);

    offFirst();
    expect(recorded.unsubscribed).toEqual([]);
    recorded.subscriptions[0].listener({ phase: 'matching' });
    expect(first).toEqual(['classifying']);
    expect(second).toEqual(['classifying', 'matching']);

    offSecond();
    expect(recorded.unsubscribed).toEqual([EVENTS.scanProgress]);
  });
});
