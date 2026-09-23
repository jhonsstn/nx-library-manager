// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { IpcBridge } from '@shared/contracts/bridge';
import { EVENTS, IPC, type IpcResult } from '@shared/contracts/ipc';
import type { AppErrorDto } from '@shared/errors/codes';
import type { GameDetailsDto, MetadataCandidateDto, MetadataBulkProgressDto } from '@shared/types/domain';
import { configureCatalogBridge } from '@renderer/api';
import { ToastProvider } from '@renderer/components/Toast';
import { BulkMetadataDialog } from '@renderer/features/metadata/BulkMetadataDialog';
import { MetadataRematchDialog } from '@renderer/features/metadata/MetadataRematchDialog';
import { AppEventsProvider } from '@renderer/query/AppEventsProvider';
import { createFakeBridge, type FakeHandler } from '../../helpers/fakeBridge';
import { renderWithProviders } from '../../helpers/render';

const GAME: GameDetailsDto = {
  id: 7,
  displayTitle: 'Hollow Knight',
  cleanedTitle: 'Hollow Knight',
  favorite: false,
  hidden: false,
  needsReview: false,
  metadataLocked: false,
  metadataProvider: null,
  genres: [],
  releaseDate: null,
  coverImageUrl: null,
  coverDisplayUrl: null,
  baseFile: null,
  updateCount: 0,
  hasNewerUpdate: false,
  description: '',
  developer: '',
  publisher: '',
  trailerUrl: null,
  dateAdded: '2026-01-01T00:00:00.000Z',
  lastScanned: '2026-01-01T00:00:00.000Z',
  files: [],
  updates: [],
  screenshots: [],
  versionStatus: { kind: 'current', localVersion: 0, latest: null, newer: [] },
  installed: null,
};

const CANDIDATE: MetadataCandidateDto = {
  provider: 'igdb',
  providerId: '1234',
  title: 'Hollow Knight',
  description: 'A hand-drawn metroidvania.',
  releaseDate: '2017-02-24',
  developer: 'Team Cherry',
  publisher: 'Team Cherry',
  genres: ['Platform'],
  coverImageUrl: 'https://images.igdb.com/igdb/image/upload/t_thumb/co1rgi.jpg',
  trailerUrl: '',
  screenshots: [],
  confidence: 0.92,
};

const ONCLOSE = () => undefined;

describe('MetadataRematchDialog', () => {
  it('searches with the game title and applies the chosen candidate', async () => {
    const searches: unknown[] = [];
    const applied: unknown[] = [];
    const onClose = vi.fn();
    renderWithProviders(<MetadataRematchDialog gameId={7} onClose={onClose} />, {
      withSelection: false,
      handlers: {
        [IPC.catalog.getGame]: () => GAME,
        [IPC.metadata.search]: (args: unknown[]) => {
          searches.push(args);
          return [CANDIDATE];
        },
        [IPC.metadata.apply]: (args: unknown[]) => {
          applied.push(args);
          return GAME;
        },
      },
    });

    await waitFor(() => expect(searches).toEqual([[7, 'Hollow Knight']]));
    expect(await screen.findByText(/Released: 2017-02-24/)).toBeTruthy();
    expect(screen.getByText('Confidence 92%')).toBeTruthy();
    expect(screen.getByAltText('Hollow Knight')).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Use Hollow Knight' }));
    await waitFor(() => expect(applied).toEqual([[7, CANDIDATE]]));
    expect(onClose).toHaveBeenCalled();
  });

  it('re-queries with the typed title and reports a failed search inline', async () => {
    const searches: unknown[] = [];
    renderWithProviders(<MetadataRematchDialog gameId={7} onClose={ONCLOSE} />, {
      withSelection: false,
      handlers: {
        [IPC.catalog.getGame]: () => GAME,
        [IPC.metadata.search]: (args: unknown[]) => {
          searches.push(args);
          throw new Error('IGDB is unreachable');
        },
      },
    });

    const user = userEvent.setup();
    const input = await screen.findByLabelText('Metadata search title');
    expect(await screen.findByText(/IGDB is unreachable/)).toBeTruthy();

    await user.clear(input);
    await user.type(input, 'Hollow Knight Voidheart');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(searches).toEqual([[7, 'Hollow Knight'], [7, 'Hollow Knight Voidheart']]));
  });
});

describe('MetadataRematchDialog with missing credentials', () => {
  it('points the user at Settings when IGDB rejects the request', async () => {
    renderWithBridge(<MetadataRematchDialog gameId={7} onClose={ONCLOSE} />, {
      handlers: { [IPC.catalog.getGame]: () => GAME },
      errors: { [IPC.metadata.search]: { code: 'METADATA_AUTH_ERROR', message: 'IGDB rejected the credentials.' } },
    });

    expect(await screen.findByText(/IGDB rejected the credentials\./)).toBeTruthy();
    expect(screen.getByText(/METADATA_AUTH_ERROR/)).toBeTruthy();
    expect(screen.getByText(/Add the client ID and secret in Settings/)).toBeTruthy();
  });
});

describe('BulkMetadataDialog', () => {
  it('starts a forced scan, tracks progress and cancels the running job', async () => {
    const started: unknown[] = [];
    const cancelled: string[] = [];
    const bridge = renderWithBridge(<BulkMetadataDialog onClose={ONCLOSE} />, {
      handlers: {
        [IPC.metadata.bulkRefresh]: (args: unknown[]) => {
          started.push(args[0]);
          return { jobId: 'job-1' };
        },
        [IPC.metadata.cancel]: (args: unknown[]) => {
          cancelled.push(args[0] as string);
          return undefined;
        },
      },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Force refresh games that already have cached metadata'));
    await user.click(screen.getByRole('button', { name: 'Start scan' }));

    await waitFor(() => expect(started).toEqual([{ force: true }]));
    await waitFor(() => expect(bridge.hasSubscriber(EVENTS.metadataBulkProgress)).toBe(true));

    bridge.emit(EVENTS.metadataBulkProgress, {
      jobId: 'job-1',
      total: 10,
      processed: 5,
      updated: 4,
      noMatch: 1,
      failed: 0,
      currentTitle: 'Celeste',
      done: false,
      cancelled: false,
    } satisfies MetadataBulkProgressDto);

    expect(await screen.findByText('5 of 10 games')).toBeTruthy();
    expect(screen.getByText('Scanning Celeste')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelled).toEqual(['job-1']));
  });

  it('summarises the finished scan and flags the games that need review', async () => {
    const bridge = renderWithBridge(<BulkMetadataDialog onClose={ONCLOSE} />, {
      handlers: { [IPC.metadata.bulkRefresh]: () => ({ jobId: 'job-2' }) },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start scan' }));
    await waitFor(() => expect(bridge.hasSubscriber(EVENTS.metadataBulkProgress)).toBe(true));

    bridge.emit(EVENTS.metadataBulkProgress, {
      jobId: 'job-2',
      total: 10,
      processed: 10,
      updated: 8,
      noMatch: 2,
      failed: 0,
      currentTitle: '',
      done: true,
      cancelled: false,
    } satisfies MetadataBulkProgressDto);

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/Scan complete: 10 processed, 8 updated, 2 with no match, 0 failed\./)).toBeTruthy();
    expect(within(dialog).getByText(/were marked for review\./)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ helpers */

interface TestBridge extends IpcBridge {
  emit: (channel: string, payload: unknown) => void;
  hasSubscriber: (channel: string) => boolean;
}

/** The shared fake bridge cannot express a chosen error code or push main-process events. */
function createTestBridge(
  handlers: Record<string, FakeHandler>,
  errors: Record<string, AppErrorDto> = {},
): TestBridge {
  const listeners = new Map<string, (payload: unknown) => void>();
  const base = createFakeBridge(handlers);
  return {
    async invoke<T>(channel: string, args: unknown[]): Promise<IpcResult<T>> {
      const error = errors[channel];
      if (error) return { ok: false, error };
      return base.invoke<T>(channel, args);
    },
    subscribe(channel, listener) {
      listeners.set(channel, listener);
    },
    unsubscribe(channel) {
      listeners.delete(channel);
    },
    emit: (channel, payload) => listeners.get(channel)?.(payload),
    hasSubscriber: (channel) => listeners.has(channel),
  };
}

function renderWithBridge(
  ui: ReactElement,
  options: { handlers?: Record<string, FakeHandler>; errors?: Record<string, AppErrorDto> },
): TestBridge {
  const bridge = createTestBridge(options.handlers ?? {}, options.errors ?? {});
  configureCatalogBridge(() => bridge);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppEventsProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </AppEventsProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return bridge;
}
