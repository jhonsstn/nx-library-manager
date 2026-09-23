// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IPC } from '@shared/contracts/ipc';
import type {
  GameDetailsDto,
  GameFileDto,
  GameSummaryDto,
  ScreenshotDto,
  UpdateFileDto,
} from '@shared/types/domain';
import { GameDetailsPane } from '@renderer/features/details/GameDetailsPane';
import { renderWithProviders } from '../../helpers/render';

vi.mock('@renderer/features/install/InstallControls', () => ({
  InstallControls: ({ gameId, updateIds }: { gameId: number; updateIds: number[] }) => (
    <div data-testid="install-controls">{`${gameId}:${updateIds.join(',')}`}</div>
  ),
}));

vi.mock('@renderer/features/install/InstallDialog', () => ({
  InstallDialog: ({
    gameId,
    updateIds,
    onClose,
  }: {
    gameId?: number | null;
    updateIds: number[];
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Install dialog">
      <span>{`${gameId ?? 'none'}:${updateIds.join(',')}`}</span>
      <button type="button" onClick={onClose}>
        Close install
      </button>
    </div>
  ),
}));

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
  filePath: 'D:\\updates\\Zelda [DLC].nsp',
  fileName: 'Zelda [DLC].nsp',
  detectedVersion: '',
  fileSize: 512 * 1024 ** 2,
  group: 'DLC',
};

function screenshot(id: number): ScreenshotDto {
  return {
    id,
    gameId: 1,
    imageUrl: `https://images.igdb.com/igdb/image/upload/t_screenshot_big/shot${id}.jpg`,
    localPath: null,
    displayUrl: `catalog-image://screenshot/${id}`,
    sortOrder: id,
  };
}

const SUMMARY: GameSummaryDto = {
  id: 1,
  displayTitle: 'Zelda',
  cleanedTitle: 'Zelda',
  favorite: false,
  needsReview: false,
  metadataLocked: true,
  metadataProvider: 'igdb',
  genres: ['Adventure'],
  releaseDate: '2017-03-03',
  coverImageUrl: null,
  coverDisplayUrl: 'catalog-image://cover/1',
  baseFile: BASE_FILE,
  updateCount: 2,
  hasNewerUpdate: true,
};

function details(overrides: Partial<GameDetailsDto> = {}): GameDetailsDto {
  return {
    ...SUMMARY,
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

function renderPane(handlers: Record<string, (args: unknown[]) => unknown>) {
  return renderWithProviders(<GameDetailsPane gameId={1} />, { handlers });
}

describe('GameDetailsPane', () => {
  it('shows the game summary while keeping long descriptions and paths collapsed', async () => {
    const user = userEvent.setup();
    renderPane({
      [IPC.catalog.getGame]: () =>
        details({
          installed: {
            rawVersion: 65536,
            source: 'install-history',
            destinationLabel: 'SD install',
            destinationFolder: null,
            completedAt: '2024-06-01T00:00:00Z',
          },
        }),
    });

    expect(await screen.findByRole('heading', { name: 'Zelda' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Zelda' })).toHaveAttribute('src', 'catalog-image://cover/1');
    expect(screen.getByText('2017-03-03 · Nintendo')).toBeInTheDocument();
    expect(screen.getByText('Adventure · Developed by Nintendo EPD')).toBeInTheDocument();
    expect(screen.getByText('Base file · NSP · 4.0 GB · Zelda.nsp')).toBeInTheDocument();
    expect(screen.getByText('Newer update available')).toBeInTheDocument();
    expect(screen.getByText('On file: v65536 (1.0.0) · Latest released: v131072 (2.0.0) (2024-05-01)')).toBeInTheDocument();
    expect(screen.getByText('Latest Installed: v65536 (1.0.0) | SD install')).toBeInTheDocument();
    expect(screen.getByText('An open-air adventure.')).not.toBeVisible();
    expect(screen.getByText('Base file: D:\\games\\Zelda.nsp')).not.toBeVisible();
    await user.click(screen.getByText('About this game'));
    expect(screen.getByText('An open-air adventure.')).toBeVisible();
    await user.click(screen.getByText(/Package details/));
    expect(screen.getByText('Base file: D:\\games\\Zelda.nsp')).toBeVisible();
    expect(screen.getByText('Newer releases')).toBeVisible();
    expect(screen.getByText('v131072 (2.0.0) (2024-05-01)')).toBeVisible();
  });

  it('keeps missing updates and DLC visible while package inventory stays collapsed', async () => {
    renderPane({
      [IPC.catalog.getGame]: () => details({
        titleId: '0100AABBCCDD0000',
        containedTitles: [{
          titleId: '0100AABBCCDD0000', baseTitleId: '0100AABBCCDD0000', type: 'base',
          name: 'Zelda', rawVersion: 0, source: 'cnmt', filePath: BASE_FILE.filePath,
          provisional: false, inspectionError: null,
        }],
        knownDlc: [
          { titleId: '0100AABBCCDD1001', name: 'Present pack', filePresent: true },
          { titleId: '0100AABBCCDD1002', name: 'Missing pack', filePresent: false },
        ],
        knownDlcRefreshedAt: '2026-09-23T00:00:00Z',
        versionStatus: {
          kind: 'update-available', localVersion: 65536,
          latest: { version: 131072, releaseDate: '2024-05-01' },
          newer: [{ version: 131072, releaseDate: '2024-05-01' }],
          missingUpdate: { version: 131072, releaseDate: '2024-05-01' },
        },
      }),
    });

    expect(await screen.findByText('Update file missing')).toBeVisible();
    expect(screen.getByText(/Missing v131072 .* TitleDB/)).toBeVisible();
    expect(screen.getByText('2 listed · 1 file missing')).toBeVisible();
    expect(screen.getByText('Missing pack')).toBeVisible();
    expect(screen.getByText('Present pack')).toBeVisible();
    expect(screen.getByText('Verified cnmt · D:\\games\\Zelda.nsp')).not.toBeVisible();
  });

  it('groups the DLC and update files and installs the current selection', async () => {
    const user = userEvent.setup();
    renderPane({ [IPC.catalog.getGame]: () => details() });

    expect(await screen.findByText('Updates')).toBeInTheDocument();
    expect(screen.getByText('DLC')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Zelda [UPD][v131072].nsp (v131072) (v2.0)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Zelda [DLC].nsp' })).toBeInTheDocument();
    expect(screen.getByText('Install size: Base 4.0 GB + 0 update/DLC file(s) 0.0 B = Total size 4.0 GB')).toBeInTheDocument();
    expect(screen.getByTestId('install-controls')).toHaveTextContent('1:');

    await user.click(screen.getByRole('option', { name: 'Zelda [UPD][v131072].nsp (v131072) (v2.0)' }));
    await user.click(screen.getByRole('option', { name: 'Zelda [DLC].nsp' }));

    expect(screen.getByRole('option', { name: 'Zelda [DLC].nsp' })).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByText('Install size: Base 4.0 GB + 2 update/DLC file(s) 1.5 GB = Total size 5.5 GB'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('install-controls')).toHaveTextContent('1:12,13');

    await user.click(screen.getByRole('button', { name: 'Install Game + Selected Updates' }));
    expect(await screen.findByRole('dialog', { name: 'Install dialog' })).toHaveTextContent('1:12,13');
  });

  it('installs the selection from the update context menu', async () => {
    const user = userEvent.setup();
    renderPane({ [IPC.catalog.getGame]: () => details() });

    fireEvent.contextMenu(await screen.findByRole('option', { name: 'Zelda [DLC].nsp' }));
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', {
        name: 'Install selected update/DLC file(s)',
      }),
    );

    expect(await screen.findByRole('dialog', { name: 'Install dialog' })).toHaveTextContent('1:13');
  });

  it('deletes and unmatches the selected update files', async () => {
    const user = userEvent.setup();
    const deleteFile = vi.fn(() => ({ id: 12, fileName: 'Zelda [UPD][v131072].nsp', path: 'D:\\updates', deleted: true }));
    const unmatchUpdates = vi.fn(() => undefined);
    renderPane({
      [IPC.catalog.getGame]: () => details(),
      [IPC.files.deleteFile]: deleteFile,
      [IPC.catalog.unmatchUpdates]: unmatchUpdates,
    });

    fireEvent.contextMenu(await screen.findByRole('option', { name: 'Zelda [UPD][v131072].nsp (v131072) (v2.0)' }));
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete selected update file(s)' }),
    );

    const confirm = await screen.findByRole('dialog', { name: 'Delete update files' });
    expect(confirm).toHaveTextContent('Zelda [UPD][v131072].nsp');
    await user.click(within(confirm).getByRole('button', { name: 'Delete from disk' }));
    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith([{ kind: 'update', updateId: 12 }]));

    fireEvent.contextMenu(screen.getByRole('option', { name: 'Zelda [UPD][v131072].nsp (v131072) (v2.0)' }));
    await user.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Unmatch selected update(s)' }),
    );
    await waitFor(() => expect(unmatchUpdates).toHaveBeenCalledWith([[12]]));
  });

  it('opens the screenshot viewer with previous/next navigation', async () => {
    const user = userEvent.setup();
    renderPane({
      [IPC.catalog.getGame]: () => details({ screenshots: Array.from({ length: 9 }, (_, index) => screenshot(index + 1)) }),
    });

    const thumbs = await screen.findAllByRole('button', { name: /Open screenshot/ });
    expect(thumbs).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: 'Open screenshot 1 of 8' }));
    const viewer = await screen.findByRole('dialog', { name: 'Screenshots' });
    expect(within(viewer).getByText('1 / 8')).toBeInTheDocument();

    await user.click(within(viewer).getByRole('button', { name: 'Next screenshot' }));
    expect(within(viewer).getByText('2 / 8')).toBeInTheDocument();
    expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'catalog-image://screenshot/2');

    await user.click(within(viewer).getByRole('button', { name: 'Previous screenshot' }));
    expect(within(viewer).getByText('1 / 8')).toBeInTheDocument();
    expect(within(viewer).getByRole('img')).toHaveAttribute('src', 'catalog-image://screenshot/1');
  });

  it('plays the trailer inside a dialog and can hand it to the browser', async () => {
    const user = userEvent.setup();
    const openExternal = vi.fn(() => undefined);
    renderPane({
      [IPC.catalog.getGame]: () => details({ trailerUrl: 'https://www.youtube.com/watch?v=abc123' }),
      [IPC.app.openExternal]: openExternal,
    });

    await user.click(await screen.findByRole('button', { name: 'Trailer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Trailer' });
    expect(within(dialog).getByTitle('Trailer')).toHaveAttribute('src', 'https://www.youtube.com/embed/abc123');

    await user.click(within(dialog).getByRole('button', { name: 'Open in browser' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(['https://www.youtube.com/watch?v=abc123']));
  });

  it('toggles the favorite and the review flag from the pane', async () => {
    const user = userEvent.setup();
    let favorite = false;
    let needsReview = false;
    const setFavorite = vi.fn((args: unknown[]) => {
      favorite = args[1] as boolean;
    });
    const setNeedsReview = vi.fn((args: unknown[]) => {
      needsReview = args[1] as boolean;
    });
    renderPane({
      [IPC.catalog.getGame]: () => details({ favorite, needsReview }),
      [IPC.catalog.setFavorite]: setFavorite,
      [IPC.catalog.setNeedsReview]: setNeedsReview,
    });

    await user.click(await screen.findByRole('button', { name: 'Favorite game' }));
    expect(setFavorite).toHaveBeenCalledWith([1, true]);
    expect(await screen.findByRole('button', { name: 'Remove favorite' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark as needs review' }));
    expect(setNeedsReview).toHaveBeenCalledWith([1, true]);
    expect(await screen.findByRole('button', { name: 'Clear needs review' })).toBeInTheDocument();
  });

  it('reports a failed details query inline', async () => {
    renderPane({
      [IPC.catalog.getGame]: () => {
        throw new Error('Game 1 is not in the catalog');
      },
    });

    expect(await screen.findByText(/Game 1 is not in the catalog/)).toBeInTheDocument();
    expect(screen.getByText('(UNKNOWN_ERROR)')).toBeInTheDocument();
  });
});
