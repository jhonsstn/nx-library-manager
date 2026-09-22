// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstallableUpdateDto } from '@shared/contracts/api';
import { IPC } from '@shared/contracts/ipc';
import type { PublicSettingsDto } from '@shared/types/settings';
import { UnmatchedPage } from '@renderer/pages/UnmatchedPage';
import type { FakeHandler } from '../../helpers/fakeBridge';
import { renderWithProviders } from '../../helpers/render';

const MARIO: InstallableUpdateDto = {
  id: 1,
  gameId: null,
  fileName: 'Super Mario Odyssey [0100000000010000][v0].nsp',
  filePath: '/updates/Super Mario Odyssey [0100000000010000][v0].nsp',
  detectedVersion: '1.0.0',
  fileSize: 1024,
  group: 'Updates',
  gameTitle: null,
};

const ZELDA: InstallableUpdateDto = {
  id: 2,
  gameId: null,
  fileName: 'Zelda DLC [0100000000011000][v0].nsp',
  filePath: '/updates/Zelda DLC [0100000000011000][v0].nsp',
  detectedVersion: '',
  fileSize: 2048,
  group: 'DLC',
  gameTitle: null,
};

const SETTINGS: PublicSettingsDto = {
  schemaVersion: 1,
  baseGamesFolder: '/games',
  updatesFolder: '/updates',
  scanRecursively: true,
  fuzzyMatchThreshold: 0.82,
  autoRescanOnStartup: false,
  autoCheckUpdatesOnStartup: true,
  cacheImages: true,
  metadataProvider: 'igdb',
  igdbClientId: '',
  httpServerEnabled: false,
  httpServerPort: 8000,
  httpServerUsername: '',
  defaultInstallDestination: 'folder',
  defaultInstallFolder: '/install',
  installFolderLabel: '',
  gridCoverSize: 170,
  legacyImportDismissed: false,
  igdbClientSecretConfigured: false,
  httpServerPasswordConfigured: false,
};

function baseHandlers(rows: InstallableUpdateDto[]): Record<string, FakeHandler> {
  return {
    [IPC.catalog.listUpdates]: (args: unknown[]) =>
      (args[0] as { unmatchedOnly?: boolean } | undefined)?.unmatchedOnly ? rows : rows,
    [IPC.catalog.listGames]: () => ({
      items: [
        {
          id: 7,
          displayTitle: 'Hollow Knight',
          cleanedTitle: 'Hollow Knight',
          favorite: false,
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
        },
      ],
      total: 1,
    }),
    [IPC.install.list]: () => [],
    [IPC.mtp.getStatus]: () => ({
      available: false,
      adapter: 'powershell',
      storages: [],
      statusText: '',
      checkedAt: '2026-01-01T00:00:00.000Z',
      error: null,
    }),
    [IPC.settings.get]: () => SETTINGS,
  };
}

describe('UnmatchedPage', () => {
  it('lists the file name with its detected version, the full path and the group', async () => {
    renderWithProviders(<UnmatchedPage />, { handlers: baseHandlers([MARIO, ZELDA]) });

    const name = await screen.findByText(/\(v65536\) \(v1\.0\.0\)/);
    expect(name.textContent).toBe('Super Mario Odyssey [0100000000010000][v0].nsp (v65536) (v1.0.0)');
    expect(screen.getByText(MARIO.filePath)).toBeTruthy();
    expect(screen.getByText('Updates')).toBeTruthy();
    expect(screen.getByText(ZELDA.filePath)).toBeTruthy();
    expect(screen.getByText('DLC')).toBeTruthy();
    // No detected version means no suffix is invented for the row.
    expect(screen.getByText(ZELDA.fileName).textContent).toBe(ZELDA.fileName);
  });

  it('shows the matched-everything empty state when nothing is unmatched', async () => {
    renderWithProviders(<UnmatchedPage />, { handlers: baseHandlers([]) });
    expect(await screen.findByText(/Everything is matched/)).toBeTruthy();
  });

  it('assigns the selected rows to the chosen game and drops them from the list', async () => {
    const rows = [MARIO, ZELDA];
    const assigned: unknown[] = [];
    const handlers = baseHandlers(rows);
    handlers[IPC.catalog.assignUpdates] = (args: unknown[]) => {
      assigned.push(args[0]);
      rows.splice(0, rows.length);
      return undefined;
    };
    renderWithProviders(<UnmatchedPage />, { handlers });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `Select ${MARIO.fileName}` }));
    await user.click(screen.getByRole('checkbox', { name: `Select ${ZELDA.fileName}` }));
    await user.selectOptions(screen.getByLabelText('Assign to game'), '7');
    await user.click(screen.getByRole('button', { name: 'Assign Selected' }));

    await waitFor(() => expect(assigned).toEqual([{ gameId: 7, updateIds: [1, 2] }]));
    // The mutation invalidates the updates query, so the assigned rows disappear.
    expect(await screen.findByText(/Everything is matched/)).toBeTruthy();
  });

  it('requires confirmation before deleting files from disk', async () => {
    const deleted: unknown[] = [];
    const handlers = baseHandlers([MARIO]);
    handlers[IPC.files.deleteFile] = (args: unknown[]) => {
      deleted.push(args[0]);
      return { id: 1, kind: 'update', deletedFromDisk: true, cascaded: false };
    };
    renderWithProviders(<UnmatchedPage />, { handlers });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `Select ${MARIO.fileName}` }));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    const dialog = await screen.findByRole('dialog');
    expect(deleted).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toEqual([{ kind: 'update', id: 1 }]));
  });

  it('opens the install dialog without a game id and only installs after confirmation', async () => {
    const created: unknown[] = [];
    const handlers = baseHandlers([MARIO]);
    handlers[IPC.install.create] = (args: unknown[]) => {
      created.push(args[0]);
      return [];
    };
    renderWithProviders(<UnmatchedPage />, { handlers });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: `Select ${MARIO.fileName}` }));
    await user.click(screen.getByRole('button', { name: 'Install selected' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(MARIO.filePath)).toBeTruthy();
    expect(created).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Confirm install' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({ updateIds: [1], destination: { type: 'folder', path: '/install' } });
    expect(created[0]).not.toHaveProperty('gameId');
  });
});
