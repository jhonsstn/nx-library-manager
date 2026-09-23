// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { IPC } from '@shared/contracts/ipc';
import type { GameSummaryDto } from '@shared/types/domain';
import { useSelection } from '@renderer/app/SelectionProvider';
import { FavoritesPage } from '@renderer/pages/FavoritesPage';
import { GridPage } from '@renderer/pages/GridPage';
import { renderWithProviders } from '../../helpers/render';

/**
 * jsdom has no layout engine, so the windowed grid would measure a 0×0 viewport
 * and mount nothing. Give every element a viewport so the virtualizer computes
 * columns and mounts the visible rows like it does in the browser.
 */
beforeAll(() => {
  for (const [property, size] of [
    ['clientWidth', 1200],
    ['offsetWidth', 1200],
    ['offsetHeight', 800],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: () => size });
  }
});

function game(id: number, displayTitle: string, overrides: Partial<GameSummaryDto> = {}): GameSummaryDto {
  return {
    id,
    displayTitle,
    cleanedTitle: displayTitle,
    favorite: false,
    hidden: false,
    needsReview: false,
    metadataLocked: false,
    metadataProvider: 'igdb',
    genres: [],
    releaseDate: null,
    coverImageUrl: null,
    coverDisplayUrl: `catalog-image://cover/${id}`,
    baseFile: null,
    updateCount: 0,
    hasNewerUpdate: false,
    ...overrides,
  };
}

function LibraryProbe() {
  const { selectedGameId } = useSelection();
  return <p>{`Library selection: ${selectedGameId ?? 'none'}`}</p>;
}

function renderGrid(routes: 'grid' | 'favorites', handlers: Record<string, (args: unknown[]) => unknown>) {
  const element =
    routes === 'grid' ? (
      <Routes>
        <Route path="/grid" element={<GridPage />} />
        <Route path="/library" element={<LibraryProbe />} />
      </Routes>
    ) : (
      <FavoritesPage />
    );
  return renderWithProviders(element, { route: `/${routes}`, handlers });
}

describe('GridPage', () => {
  it('renders one accessible cover button per game and opens it in the library', async () => {
    const user = userEvent.setup();
    renderGrid('grid', {
      [IPC.catalog.listGames]: () => ({
        items: [
          game(1, 'Zelda', { favorite: true, hasNewerUpdate: true }),
          game(2, 'Metroid', { needsReview: true }),
        ],
        total: 2,
      }),
      [IPC.settings.get]: () => ({ gridCoverSize: 170 }),
    });

    const zelda = await screen.findByRole('button', { name: 'Zelda' });
    expect(screen.getByRole('button', { name: 'Metroid' })).toBeInTheDocument();
    expect(within(zelda).getByLabelText('Favorite')).toHaveTextContent('Favorite');
    expect(within(zelda).getByText('Update')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Metroid' })).getByText('Review')).toBeInTheDocument();

    await user.dblClick(screen.getByRole('button', { name: 'Metroid' }));
    expect(await screen.findByText('Library selection: 2')).toBeInTheDocument();
  });

  it('opens the highlighted game with the keyboard', async () => {
    const user = userEvent.setup();
    renderGrid('grid', {
      [IPC.catalog.listGames]: () => ({ items: [game(3, 'Hades')], total: 1 }),
      [IPC.settings.get]: () => ({ gridCoverSize: 170 }),
    });

    const cell = await screen.findByRole('button', { name: 'Hades' });
    await user.tab();
    cell.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Library selection: 3')).toBeInTheDocument();
  });

  it('resizes the covers from the art size slider', async () => {
    const updateSettings = vi.fn(() => ({ gridCoverSize: 260 }));
    renderGrid('grid', {
      [IPC.catalog.listGames]: () => ({ items: [game(1, 'Zelda')], total: 1 }),
      [IPC.settings.get]: () => ({ gridCoverSize: 170 }),
      [IPC.settings.update]: updateSettings,
    });

    await screen.findByRole('button', { name: 'Zelda' });
    const slider = screen.getByLabelText('Art size');
    const artWidth = () =>
      (screen.getByRole('button', { name: 'Zelda' }).querySelector('.grid__art') as HTMLElement).style.width;
    expect(artWidth()).toBe('170px');
    expect(screen.getByText('170 px')).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '110' } });
    expect(screen.getByText('110 px')).toBeInTheDocument();
    expect(artWidth()).toBe('110px');

    fireEvent.change(slider, { target: { value: '260' } });
    expect(artWidth()).toBe('260px');

    fireEvent.blur(slider);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith([{ gridCoverSize: 260 }]));
  });

  it('toggles the favorite from the cell context menu', async () => {
    const user = userEvent.setup();
    const setFavorite = vi.fn(() => undefined);
    renderGrid('grid', {
      [IPC.catalog.listGames]: () => ({ items: [game(1, 'Zelda')], total: 1 }),
      [IPC.settings.get]: () => ({ gridCoverSize: 170 }),
      [IPC.catalog.setFavorite]: setFavorite,
    });

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Zelda' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open in library' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Mark as DLC/update' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Hide from library' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Export catalog backup' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Favorite game' }));
    expect(setFavorite).toHaveBeenCalledWith([1, true]);
  });

  it('hides a game from the grid context menu', async () => {
    const user = userEvent.setup();
    const setHidden = vi.fn(() => undefined);
    renderGrid('grid', {
      [IPC.catalog.listGames]: () => ({ items: [game(1, 'Zelda')], total: 1 }),
      [IPC.settings.get]: () => ({ gridCoverSize: 170 }),
      [IPC.catalog.setHidden]: setHidden,
    });
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Zelda' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Hide from library' }));
    expect(setHidden).toHaveBeenCalledWith([1, true]);
  });
});

describe('FavoritesPage', () => {
  it('asks the catalog for favorites only', async () => {
    const listGames = vi.fn(() => ({ items: [game(1, 'Zelda', { favorite: true })], total: 1 }));
    renderGrid('favorites', { [IPC.catalog.listGames]: listGames });

    await waitFor(() => expect(listGames).toHaveBeenCalledWith([{ favoritesOnly: true }]));
    expect(await screen.findByRole('button', { name: 'Zelda' })).toBeInTheDocument();
  });

  it('shows an empty state without favorites', async () => {
    renderGrid('favorites', { [IPC.catalog.listGames]: () => ({ items: [], total: 0 }) });

    expect(await screen.findByText(/No favorites yet/)).toBeInTheDocument();
  });
});
