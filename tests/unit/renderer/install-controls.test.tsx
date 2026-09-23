// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstallableUpdateDto } from '@shared/contracts/api';
import { IPC } from '@shared/contracts/ipc';
import type { GameDetailsDto, InstallJobDto, MtpStatusDto } from '@shared/types/domain';
import type { PublicSettingsDto } from '@shared/types/settings';
import { InstallControls } from '@renderer/features/install/InstallControls';
import { InstallQueueTray } from '@renderer/features/install/InstallQueueTray';
import { renderWithProviders } from '../../helpers/render';

const BASE_FILE = {
  id: 100,
  gameId: 7,
  filePath: '/games/Hollow Knight [0100000001].nsp',
  fileName: 'Hollow Knight [0100000001].nsp',
  fileExtension: '.nsp',
  fileSize: 1_048_576,
  modifiedTime: 0,
  fileType: 'nsp',
  isBaseGame: true,
};

const UPDATE_OLD: InstallableUpdateDto = {
  id: 11,
  gameId: 7,
  fileName: 'Hollow Knight [v1].nsp',
  filePath: '/updates/Hollow Knight [v1].nsp',
  detectedVersion: '1.0.0',
  fileSize: 2_097_152,
  group: 'Updates',
  gameTitle: 'Hollow Knight',
};

const UPDATE_NEW: InstallableUpdateDto = {
  id: 12,
  gameId: 7,
  fileName: 'Hollow Knight [v2].nsp',
  filePath: '/updates/Hollow Knight [v2].nsp',
  detectedVersion: '2.0.0',
  fileSize: 3_145_728,
  group: 'Updates',
  gameTitle: 'Hollow Knight',
};

const DLC: InstallableUpdateDto = {
  id: 13,
  gameId: 7,
  fileName: 'Hollow Knight DLC.nsp',
  filePath: '/updates/Hollow Knight DLC.nsp',
  detectedVersion: '',
  fileSize: 4_194_304,
  group: 'DLC',
  gameTitle: 'Hollow Knight',
};

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
  baseFile: BASE_FILE,
  updateCount: 3,
  hasNewerUpdate: false,
  description: '',
  developer: '',
  publisher: '',
  trailerUrl: null,
  dateAdded: '2026-01-01T00:00:00.000Z',
  lastScanned: '2026-01-01T00:00:00.000Z',
  files: [BASE_FILE],
  updates: [],
  screenshots: [],
  versionStatus: { kind: 'current', localVersion: 0, latest: null, newer: [] },
  installed: null,
};

const MTP_DISCONNECTED: MtpStatusDto = {
  available: false,
  adapter: 'powershell',
  storages: [],
  statusText: '',
  checkedAt: '2026-01-01T00:00:00.000Z',
  error: null,
};

function settingsWith(overrides: Partial<PublicSettingsDto> = {}): PublicSettingsDto {
  return {
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
    igdbClientSecretConfigured: false,
    httpServerPasswordConfigured: false,
    ...overrides,
  };
}

function installHandlers(overrides: Record<string, (args: unknown[]) => unknown> = {}) {
  return {
    [IPC.settings.get]: () => settingsWith(),
    [IPC.catalog.getGame]: () => GAME,
    [IPC.catalog.listUpdates]: () => [UPDATE_NEW, DLC, UPDATE_OLD],
    [IPC.mtp.getStatus]: () => MTP_DISCONNECTED,
    [IPC.install.list]: () => [],
    ...overrides,
  };
}

function job(overrides: Partial<InstallJobDto>): InstallJobDto {
  return {
    id: 1,
    gameId: 7,
    sourcePath: '/updates/Hollow Knight DLC.nsp',
    displayName: 'Hollow Knight DLC.nsp',
    destinationType: 'folder',
    destinationFolder: '/install',
    destinationLabel: null,
    destinationPath: '/install/Hollow Knight DLC.nsp',
    fileKind: 'dlc',
    detectedVersion: '',
    rawVersion: 0,
    sizeBytes: 100,
    transferredBytes: 0,
    status: 'pending',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('InstallControls', () => {
  it('lists the base file first, then updates oldest to newest, then DLC', async () => {
    renderWithProviders(<InstallControls gameId={7} updateIds={[12, 13, 11]} />, {
      handlers: installHandlers(),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Install' }));

    const dialog = await screen.findByRole('dialog');
    const items = await within(dialog).findAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain('Hollow Knight [0100000001].nsp');
    expect(items[1].textContent).toContain('Hollow Knight [v1].nsp');
    expect(items[2].textContent).toContain('Hollow Knight [v2].nsp');
    expect(items[3].textContent).toContain('Hollow Knight DLC.nsp');
    // 10 MB of files, formatted through the shared byte formatter.
    expect(within(dialog).getByText(/Total size 10\.0 MB/)).toBeTruthy();
  });

  it('does not install anything until the dialog is confirmed', async () => {
    const created: unknown[] = [];
    renderWithProviders(<InstallControls gameId={7} updateIds={[11, 12, 13]} />, {
      handlers: installHandlers({
        [IPC.install.create]: (args: unknown[]) => {
          created.push(args[0]);
          return [];
        },
      }),
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    await screen.findByRole('dialog');
    expect(created).toEqual([]);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(created).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm install' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      gameId: 7,
      updateIds: [11, 12, 13],
      includeBaseFile: true,
      destination: { type: 'folder', path: '/install' },
    });
  });

  it('blocks the install when the Switch is not connected for an MTP destination', async () => {
    renderWithProviders(<InstallControls gameId={7} updateIds={[11]} />, {
      handlers: installHandlers({
        [IPC.settings.get]: () => settingsWith({ defaultInstallDestination: 'mtp-sd' }),
      }),
    });

    expect(await screen.findByText('No Switch detected')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('InstallQueueTray', () => {
  it('shows the status word instead of a percentage for MTP jobs without byte progress', async () => {
    const jobs = [
      job({
        id: 1,
        displayName: 'Install to SD.nsp',
        destinationType: 'mtp-sd',
        destinationFolder: 'shell:::sd',
        destinationLabel: 'SD install',
        status: 'running',
        sizeBytes: 4_000_000_000,
      }),
    ];
    renderWithProviders(<InstallQueueTray />, { handlers: { [IPC.install.list]: () => jobs } });

    expect(await screen.findByText('Install to SD.nsp')).toBeTruthy();
    const row = screen.getByText('Install to SD.nsp').closest('li') as HTMLElement;
    expect(within(row).getByText('Running')).toBeTruthy();
    expect(within(row).getByText('SD install')).toBeTruthy();
    expect(row.textContent).not.toContain('0%');
  });

  it('cancels pending jobs and retries failed ones', async () => {
    const cancelled: unknown[] = [];
    let retries = 0;
    const jobs = [
      job({ id: 5, displayName: 'Pending file.nsp', status: 'pending' }),
      job({
        id: 6,
        displayName: 'Failed file.nsp',
        status: 'failed',
        transferredBytes: 25,
        sizeBytes: 100,
        error: { code: 'MTP_COPY_FAILED', message: 'The device disconnected.' },
      }),
    ];
    renderWithProviders(<InstallQueueTray />, {
      handlers: {
        [IPC.install.list]: () => jobs,
        [IPC.install.cancel]: (args: unknown[]) => {
          cancelled.push(args[0]);
          return undefined;
        },
        [IPC.install.retryFailed]: () => {
          retries += 1;
          return [];
        },
      },
    });

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelled).toEqual([5]));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(retries).toBe(1));

    expect(screen.getByText('The device disconnected.')).toBeTruthy();
  });

  it('renders nothing when the queue is empty', async () => {
    renderWithProviders(<InstallQueueTray />, { handlers: { [IPC.install.list]: () => [] } });
    await waitFor(() => expect(screen.queryByLabelText('Install queue')).toBeNull());
  });
});
