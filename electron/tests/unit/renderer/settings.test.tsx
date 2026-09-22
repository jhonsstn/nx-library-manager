// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IPC } from '@shared/contracts/ipc';
import type { HttpServerStatusDto, LegacyDataInfoDto, MtpStatusDto } from '@shared/types/domain';
import type { PublicSettingsDto } from '@shared/types/settings';
import { FirstRunImportDialog } from '@renderer/features/migration/FirstRunImportDialog';
import { SettingsPage } from '@renderer/pages/SettingsPage';
import { renderWithProviders } from '../../helpers/render';

const SETTINGS: PublicSettingsDto = {
  schemaVersion: 1,
  baseGamesFolder: '/games',
  updatesFolder: '/updates',
  scanRecursively: true,
  fuzzyMatchThreshold: 0.82,
  autoRescanOnStartup: false,
  autoCheckUpdatesOnStartup: true,
  cacheImages: false,
  metadataProvider: 'igdb',
  igdbClientId: 'client-id',
  httpServerEnabled: true,
  httpServerPort: 8000,
  httpServerUsername: 'switch',
  defaultInstallDestination: 'folder',
  defaultInstallFolder: '/install',
  installFolderLabel: '',
  gridCoverSize: 170,
  legacyImportDismissed: true,
  igdbClientSecretConfigured: true,
  httpServerPasswordConfigured: true,
};

const MTP: MtpStatusDto = {
  available: false,
  adapter: 'powershell',
  storages: [],
  statusText: '',
  checkedAt: '2026-01-01T00:00:00.000Z',
  error: null,
};

const SERVER_STOPPED: HttpServerStatusDto = {
  running: false,
  port: 8000,
  directoryUrl: 'http://192.168.1.10:8000/dir/',
  authEnabled: false,
  error: null,
};

const SERVER_RUNNING: HttpServerStatusDto = { ...SERVER_STOPPED, running: true, authEnabled: true };

const NO_LEGACY: LegacyDataInfoDto = {
  found: false,
  sourceDirectory: '/home/user/.switch_library_catalog',
  databasePresent: false,
  settingsPresent: false,
  games: 0,
  updates: 0,
  favorites: 0,
  error: null,
};

const LEGACY_FOUND: LegacyDataInfoDto = {
  ...NO_LEGACY,
  found: true,
  databasePresent: true,
  settingsPresent: true,
  games: 328,
  updates: 811,
  favorites: 56,
};

function pageHandlers(overrides: Record<string, (args: unknown[]) => unknown> = {}) {
  return {
    [IPC.settings.get]: () => SETTINGS,
    [IPC.settings.update]: (args: unknown[]) => ({ ...SETTINGS, ...(args[0] as object) }),
    [IPC.mtp.getStatus]: () => MTP,
    [IPC.httpServer.getStatus]: () => SERVER_STOPPED,
    [IPC.install.list]: () => [],
    [IPC.app.getVersion]: () => '1.0.0-beta.1',
    [IPC.app.getLegacyDataInfo]: () => NO_LEGACY,
    ...overrides,
  };
}

const writeText = vi.fn<(text: string) => Promise<void>>();

/** `userEvent.setup()` installs its own clipboard stub, so re-install ours after it. */
function stubClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  stubClipboard();
});

function browseButtonOf(input: HTMLElement): HTMLElement {
  const row = input.closest('.field__row');
  if (!row) throw new Error('Folder field is missing its row wrapper');
  return within(row as HTMLElement).getByRole('button', { name: 'Browse' });
}

describe('SettingsPage', () => {
  it('initialises the form from the stored settings', async () => {
    renderWithProviders(<SettingsPage />, { handlers: pageHandlers() });

    expect(((await screen.findByLabelText('Base games folder')) as HTMLInputElement).value).toBe('/games');
    expect((screen.getByLabelText('Updates folder') as HTMLInputElement).value).toBe('/updates');
    expect((screen.getByLabelText('IGDB client ID') as HTMLInputElement).value).toBe('client-id');
    expect((screen.getByLabelText('Fuzzy match threshold') as HTMLInputElement).value).toBe('0.82');
    expect((screen.getByLabelText('HTTP port') as HTMLInputElement).value).toBe('8000');
    expect((screen.getByLabelText('HTTP username') as HTMLInputElement).value).toBe('switch');
    expect((screen.getByLabelText('Scan recursively') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Cache images') as HTMLInputElement).checked).toBe(false);
    // Secret placeholders reflect what is stored, never the secret itself.
    expect(screen.getByLabelText('IGDB client secret').getAttribute('placeholder')).toBe(
      'Configured — leave blank to keep',
    );
    expect(screen.getByLabelText('HTTP password').getAttribute('placeholder')).toBe('Configured — leave blank to keep');
  });

  it('stores the path returned by the folder chooser', async () => {
    const chosen: unknown[] = [];
    const handlers = pageHandlers({
      [IPC.files.chooseDirectory]: (args: unknown[]) => {
        chosen.push(args[0]);
        return '/new/base';
      },
    });
    renderWithProviders(<SettingsPage />, { handlers });

    const user = userEvent.setup();
    const baseInput = await screen.findByLabelText('Base games folder');
    await user.click(browseButtonOf(baseInput));

    await waitFor(() => expect((screen.getByLabelText('Base games folder') as HTMLInputElement).value).toBe('/new/base'));
    expect(chosen).toHaveLength(1);
  });

  it('sends only the changed fields and never echoes a stored secret', async () => {
    const updates: unknown[] = [];
    const handlers = pageHandlers({
      [IPC.files.chooseDirectory]: () => '/new/base',
      [IPC.settings.update]: (args: unknown[]) => {
        updates.push(args[0]);
        return { ...SETTINGS, ...(args[0] as object) };
      },
    });
    renderWithProviders(<SettingsPage />, { handlers });

    const user = userEvent.setup();
    await user.click(browseButtonOf(await screen.findByLabelText('Base games folder')));
    await waitFor(() =>
      expect((screen.getByLabelText('Base games folder') as HTMLInputElement).value).toBe('/new/base'),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updates).toEqual([{ baseGamesFolder: '/new/base' }]));
    expect(updates[0]).not.toHaveProperty('igdbClientSecret');
    expect(updates[0]).not.toHaveProperty('httpServerPassword');

    await user.type(screen.getByLabelText('IGDB client secret'), 'typed-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toEqual({ igdbClientSecret: 'typed-secret' });
  });

  it('blocks saving an out-of-range port with an inline error', async () => {
    const updates: unknown[] = [];
    const handlers = pageHandlers({
      [IPC.settings.update]: (args: unknown[]) => {
        updates.push(args[0]);
        return { ...SETTINGS, ...(args[0] as object) };
      },
    });
    renderWithProviders(<SettingsPage />, { handlers });

    const user = userEvent.setup();
    const port = await screen.findByLabelText('HTTP port');
    await user.clear(port);
    await user.type(port, '70000');

    expect(await screen.findByText('Port must be a number between 1 and 65535.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updates).toEqual([]);
  });

  it('starts and stops the DBI server and copies the directory URL', async () => {
    const handlers = pageHandlers({
      [IPC.httpServer.start]: () => SERVER_RUNNING,
      [IPC.httpServer.stop]: () => SERVER_STOPPED,
    });
    renderWithProviders(<SettingsPage />, { handlers });

    const user = userEvent.setup();
    stubClipboard();
    await user.click(await screen.findByRole('button', { name: 'Start server' }));

    const panel = screen.getByText('DBI HTTP server').closest('section') as HTMLElement;
    expect(await within(panel).findByText('http://192.168.1.10:8000/dir/')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://192.168.1.10:8000/dir/'));

    await user.click(screen.getByRole('button', { name: 'Stop server' }));
    await waitFor(() => expect(within(panel).queryByText('http://192.168.1.10:8000/dir/')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Start server' })).toBeTruthy();
  });

  it('warns that Basic Auth over plain HTTP is not encrypted', async () => {
    renderWithProviders(<SettingsPage />, { handlers: pageHandlers() });
    expect(
      await screen.findByText(/Basic Auth over plain HTTP does not encrypt credentials or traffic/),
    ).toBeTruthy();
    expect(screen.getByText(/Tailscale or WireGuard/)).toBeTruthy();
  });

  it('reports application updates and opens the release page', async () => {
    const opened: unknown[] = [];
    const handlers = pageHandlers({
      [IPC.app.checkForUpdates]: () => ({
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseName: 'v1.1.0',
        releaseUrl: 'https://example.test/releases/1.1.0',
        updateAvailable: true,
      }),
      [IPC.app.openExternal]: (args: unknown[]) => {
        opened.push(args[0]);
        return undefined;
      },
    });
    renderWithProviders(<SettingsPage />, { handlers });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check for Updates' }));

    expect(await screen.findByText(/Installed: v1\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/Latest: 1\.1\.0/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open release page' }));
    await waitFor(() => expect(opened).toEqual(['https://example.test/releases/1.1.0']));
  });

  it('confirms before resetting the library and keeps play files', async () => {
    let resets = 0;
    const handlers = pageHandlers({
      [IPC.catalog.resetLibrary]: () => {
        resets += 1;
        return undefined;
      },
    });
    renderWithProviders(<SettingsPage />, { handlers });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Reset library' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Files on disk are not touched/)).toBeTruthy();
    expect(resets).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: 'Reset library' }));
    await waitFor(() => expect(resets).toBe(1));
  });
});

describe('FirstRunImportDialog', () => {
  it('stays hidden when no legacy data was found', async () => {
    renderWithProviders(<FirstRunImportDialog />, { handlers: pageHandlers() });

    await waitFor(() => expect(screen.queryByText('Existing Switch Game Catalog data found')).toBeNull());
  });

  it('stays hidden when the prompt was already answered', async () => {
    const handlers = pageHandlers({
      [IPC.settings.get]: () => ({ ...SETTINGS, legacyImportDismissed: true }),
      [IPC.app.getLegacyDataInfo]: () => LEGACY_FOUND,
    });
    renderWithProviders(<FirstRunImportDialog />, { handlers });

    await waitFor(() => expect(screen.queryByText('Existing Switch Game Catalog data found')).toBeNull());
  });

  it('shows the legacy counts and imports the existing data', async () => {
    let imports = 0;
    const handlers = pageHandlers({
      [IPC.settings.get]: () => ({ ...SETTINGS, legacyImportDismissed: false }),
      [IPC.app.getLegacyDataInfo]: () => LEGACY_FOUND,
      [IPC.app.importLegacyData]: () => {
        imports += 1;
        return { ...SETTINGS, legacyImportDismissed: true, baseGamesFolder: '/games' };
      },
    });
    renderWithProviders(<FirstRunImportDialog />, { handlers });

    const heading = await screen.findByRole('heading', { name: 'Existing Switch Game Catalog data found' });
    expect(heading).toBeTruthy();
    expect(screen.getByText('328')).toBeTruthy();
    expect(screen.getByText('811')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Import Existing Data' }));

    await waitFor(() => expect(imports).toBe(1));
    expect(await screen.findByText(/Existing data imported/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Existing Switch Game Catalog data found' })).toBeNull(),
    );
  });
});
