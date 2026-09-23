// @vitest-environment jsdom
import { useGames } from '@renderer/query/hooks';
import { EVENTS, IPC } from '@shared/contracts/ipc';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFakeBridge, emitFakeEvent } from '../../helpers/fakeBridge';
import { renderWithProviders } from '../../helpers/render';

function CatalogProbe() {
  const games = useGames({});
  return <span>{games.data?.total ?? 'loading'}</span>;
}

describe('AppEventsProvider', () => {
  it('invalidates catalog queries when version data changes', async () => {
    const listGames = vi.fn(() => ({ items: [], total: 0 }));
    const bridge = createFakeBridge({ [IPC.catalog.listGames]: listGames });
    renderWithProviders(<CatalogProbe />, { bridge });
    await screen.findByText('0');

    emitFakeEvent(bridge, EVENTS.versionsChanged, undefined);

    await waitFor(() => expect(listGames).toHaveBeenCalledTimes(2));
  });

  it('shows scan failures to the user', async () => {
    const bridge = createFakeBridge({});
    renderWithProviders(<span>ready</span>, { bridge });
    await screen.findByText('ready');

    emitFakeEvent(bridge, EVENTS.scanCompleted, {
      jobId: 'scan-1',
      cancelled: false,
      checkedFiles: 0,
      gamesFound: 0,
      updatesFound: 0,
      unmatchedUpdates: 0,
      elapsedMs: 10,
      error: { code: 'PERMISSION_DENIED', message: 'The library folder could not be read.' },
    });

    expect(await screen.findByText('Library scan failed')).toBeTruthy();
    expect(screen.getByText('The library folder could not be read.')).toBeTruthy();
  });
});
