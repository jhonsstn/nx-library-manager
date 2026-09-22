// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IPC } from '@shared/contracts/ipc';
import type { ListGamesInput } from '@shared/contracts/api';
import type { GameDetailsDto, GameSummaryDto, GameFileDto, UpdateFileDto } from '@shared/types/domain';
import { LibraryPage } from '@renderer/pages/LibraryPage';
import { renderWithProviders } from '../../helpers/render';

vi.mock('@renderer/features/metadata/BulkMetadataDialog', () => ({
  BulkMetadataDialog: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="Scan all metadata">
      <button type="button" onClick={onClose}>
        Close bulk metadata
      </button>
    </div>
  ),
}));

vi.mock('@renderer/features/metadata/MetadataRematchDialog', () => ({
  MetadataRematchDialog: ({ gameId, onClose }: { gameId: number; onClose: () => void }) => (
    <div role="dialog" aria-label={`Metadata rematch ${gameId}`}>
      <button type="button" onClick={onClose}>
        Close rematch
      </button>
    </div>
  ),
}));

vi.mock('@renderer/features/install/InstallControls', () => ({ InstallControls: () => null }));
vi.mock('@renderer/features/install/InstallDialog', () => ({ InstallDialog: () => null }));

const BASE_FILE: GameFileDto = {
  id: 40,
  gameId: 1,
  filePath: 'D:\\games\\Zelda.nsp',
  fileName: 'Zelda.nsp',
  fileExtension: 'nsp',
  fileSize: 4 * 1024 ** 3,
  modifiedTime: 1_700_000_000,
  fileType: 'NSP',
  isBaseGame: true,
};

const UPDATE_FILE: UpdateFileDto = {
  id: 12,
  gameId: 1,
  filePath: 'D:\\updates\\Zelda [UPD][v131072].nsp',
  fileName: 'Zelda [UPD][v131072].nsp',
  detectedVersion: '131072',
  fileSize: 1024 ** 3,
  modifiedTime: 1_700_000_100,
  matchConfidence: 1,
  manualMatch: true,
  group: 'Updates',
};

const DLC_FILE: UpdateFileDto = {
  ...UPDATE_FILE,
  id: 13,
  fileName: 'Zelda [DLC].nsp',
  detectedVersion: '',
  fileSize: 512 * 1024 ** 2,
  group: 'DLC',
};

function summary(overrides: Partial<GameSummaryDto> = {}): GameSummaryDto {
  return {
    id: 1,
    displayTitle: 'Zelda',
    cleanedTitle: 'Zelda',
    favorite: false,
    needsReview: false,
    metadataLocked: false,
    metadataProvider: 'igdb',
    genres: ['Adventure'],
    releaseDate: '2017-03-03',
    coverImageUrl: null,
    coverDisplayUrl: null,
    baseFile: BASE_FILE,
    updateCount: 2,
    hasNewerUpdate: true,
    ...overrides,
  };
}

function details(overrides: Partial<GameDetailsDto> = {}): GameDetailsDto {
  return {
    ...summary(),
    description: 'An open-air adventure.',
    developer: 'Nintendo EPD',
    publisher: 'Nintendo',
    trailerUrl: null,
    dateAdded: '2024-01-01T00:00:00Z',
    lastScanned: '2024-01-02T00:00:00Z',
    files: [BASE_FILE],
    updates: [UPDATE_FILE, DLC_FILE],
    screenshots: [],
    versionStatus: {
      kind: 'update-available',
      localVersion: 65536,
      latest: { version: 131072, releaseDate: '2024-05-01' },
      newer: [{ version: 131072, releaseDate: '2024-05-01' }],
    },
    installed: null,
    ...overrides,
  };
}

function renderLibrary(handlers: Record<string, (args: unknown[]) => unknown>) {
  return renderWithProviders(<LibraryPage />, { route: '/library', handlers });
}

describe('LibraryPage', () => {
  it('lists catalog games and offers the sorted genre choices', async () => {
    const listGames = vi.fn(() => ({ items: [summary(), summary({ id: 2, displayTitle: 'Metroid' })], total: 2 }));
    renderLibrary({
      [IPC.catalog.listGames]: listGames,
      [IPC.catalog.getGenres]: () => ['RPG', 'Action'],
    });

    expect(await screen.findByRole('option', { name: 'Zelda' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Metroid' })).toBeInTheDocument();

    const genres = screen.getByLabelText('Genre');
    expect([...genres.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'All Genres',
      'Action',
      'RPG',
    ]);
    expect(listGames).toHaveBeenCalledWith([expect.objectContaining({ genre: undefined, search: undefined })]);
  });

  it('debounces the search box and refilters the rows', async () => {
    const user = userEvent.setup();
    const listGames = vi.fn((args: unknown[]) => {
      const filters = args[0] as ListGamesInput;
      const items = filters.search ? [summary()] : [summary(), summary({ id: 2, displayTitle: 'Metroid' })];
      return { items, total: items.length };
    });
    renderLibrary({
      [IPC.catalog.listGames]: listGames,
      [IPC.catalog.getGenres]: () => [],
    });

    await screen.findByRole('option', { name: 'Metroid' });
    await user.type(screen.getByLabelText('Search library'), '  zelda  ');

    await waitFor(() => expect(listGames).toHaveBeenCalledWith([expect.objectContaining({ search: 'zelda' })]));
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Metroid' })).not.toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Zelda' })).toBeInTheDocument();
  });

  it('sends the genre and review filters to the catalog', async () => {
    const user = userEvent.setup();
    const listGames = vi.fn(() => ({ items: [summary()], total: 1 }));
    renderLibrary({
      [IPC.catalog.listGames]: listGames,
      [IPC.catalog.getGenres]: () => ['RPG'],
    });

    await screen.findByRole('option', { name: 'Zelda' });
    await user.selectOptions(screen.getByLabelText('Genre'), 'RPG');
    await user.click(screen.getByRole('checkbox', { name: 'Need Review' }));
    await user.click(screen.getByRole('checkbox', { name: 'Needs Update?' }));

    await waitFor(() =>
      expect(listGames).toHaveBeenCalledWith([
        expect.objectContaining({ genre: 'RPG', needsReview: true, needsUpdate: true }),
      ]),
    );
  });

  it('loads the details of the selected row', async () => {
    const user = userEvent.setup();
    const getGame = vi.fn(() => details());
    renderLibrary({
      [IPC.catalog.listGames]: () => ({ items: [summary()], total: 1 }),
      [IPC.catalog.getGenres]: () => ['Adventure'],
      [IPC.catalog.getGame]: getGame,
    });

    await user.click(await screen.findByRole('option', { name: 'Zelda' }));

    expect(getGame).toHaveBeenCalledWith([1]);
    expect(await screen.findByRole('heading', { name: 'Zelda' })).toBeInTheDocument();
    expect(screen.getByText('NSP | 4.0 GB | D:\\games\\Zelda.nsp')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Latest Version on File: v65536 \(1\.0\.0\) Latest Version Released: v131072 \(2\.0\.0\) \(2024-05-01\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Updates')).toBeInTheDocument();
    expect(screen.getByText('DLC')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Zelda [UPD][v131072].nsp (v131072) (v2.0)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Zelda [DLC].nsp' })).toBeInTheDocument();
  });

  it('shows an inline error with its code when the catalog query fails', async () => {
    renderLibrary({
      [IPC.catalog.listGames]: () => {
        throw new Error('Library database is locked');
      },
      [IPC.catalog.getGenres]: () => [],
    });

    expect(await screen.findByText(/Library database is locked/)).toBeInTheDocument();
    expect(screen.getByText('(UNKNOWN_ERROR)')).toBeInTheDocument();
  });

  it('shows an empty state when no game matches the filters', async () => {
    renderLibrary({
      [IPC.catalog.listGames]: () => ({ items: [], total: 0 }),
      [IPC.catalog.getGenres]: () => [],
    });

    expect(await screen.findByText('No games match the current filters.')).toBeInTheDocument();
  });

  it('toggles the favorite and reflects the refetched row', async () => {
    const user = userEvent.setup();
    let favorite = false;
    const setFavorite = vi.fn((args: unknown[]) => {
      favorite = args[1] as boolean;
    });
    renderLibrary({
      [IPC.catalog.listGames]: () => ({ items: [summary({ favorite })], total: 1 }),
      [IPC.catalog.getGenres]: () => [],
      [IPC.catalog.getGame]: () => details({ favorite }),
      [IPC.catalog.setFavorite]: setFavorite,
    });

    await user.click(await screen.findByRole('option', { name: 'Zelda' }));
    const row = screen.getByRole('option', { name: 'Zelda' });
    expect(within(row).queryByLabelText('Favorite')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Favorite game' }));

    expect(setFavorite).toHaveBeenCalledWith([1, true]);
    await waitFor(() => expect(within(screen.getByRole('option', { name: 'Zelda' })).getByLabelText('Favorite')).toBeInTheDocument());
  });

  it('offers the library actions from the row context menu', async () => {
    const user = userEvent.setup();
    renderLibrary({
      [IPC.catalog.listGames]: () => ({ items: [summary()], total: 1 }),
      [IPC.catalog.getGenres]: () => [],
    });

    fireEvent.contextMenu(await screen.findByRole('option', { name: 'Zelda' }));

    const menu = await screen.findByRole('menu');
    for (const label of [
      'Search/change metadata match',
      'Favorite game',
      'Mark as DLC/update',
      'Export catalog backup',
      'Delete game file from disk',
    ]) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }

    await user.click(within(menu).getByRole('menuitem', { name: 'Search/change metadata match' }));
    expect(await screen.findByRole('dialog', { name: 'Metadata rematch 1' })).toBeInTheDocument();
  });

  it('starts a library rescan and opens the bulk metadata dialog', async () => {
    const user = userEvent.setup();
    const startScan = vi.fn(() => ({ jobId: 'job-1' }));
    renderLibrary({
      [IPC.catalog.listGames]: () => ({ items: [summary()], total: 1 }),
      [IPC.catalog.getGenres]: () => [],
      [IPC.scan.start]: startScan,
    });

    await screen.findByRole('option', { name: 'Zelda' });
    await user.click(screen.getByRole('button', { name: 'Rescan Library' }));
    expect(startScan).toHaveBeenCalledWith([{}]);

    await user.click(screen.getByRole('button', { name: 'Scan All Metadata' }));
    expect(await screen.findByRole('dialog', { name: 'Scan all metadata' })).toBeInTheDocument();
  });
});
