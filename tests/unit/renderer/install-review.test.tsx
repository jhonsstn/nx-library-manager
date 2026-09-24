// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallDialog } from '@renderer/features/install/InstallDialog';
import { IPC } from '@shared/contracts/ipc';
import type { GameDetailsDto, InstallPreviewDto } from '@shared/types/domain';
import { defaultAppSettings } from '@shared/schemas/settings';
import { renderWithProviders } from '../../helpers/render';

const preview: InstallPreviewDto = { inventoryRevision: 5, inventoryState: 'ready', items: [
  { filePath: 'C:\\games\\Base.nsp', fileName: 'Base.nsp', fileSize: 100,
    assessment: 'already-installed', reason: 'Already installed', selectedByDefault: false,
    includesAlreadyInstalled: true, includeBaseFile: true, updateIds: [] },
  { filePath: 'C:\\games\\Update.nsp', fileName: 'Update.nsp', fileSize: 200,
    assessment: 'needed', reason: 'Newer update', selectedByDefault: true,
    includesAlreadyInstalled: false, includeBaseFile: false, updateIds: [12] },
] };

describe('Switch install review', () => {
  it('selects only needed content and requires a deliberate click for installed files', async () => {
    const user = userEvent.setup();
    const create = vi.fn((_args: unknown[]) => []);
    renderWithProviders(<InstallDialog gameId={1} suggested onClose={() => undefined}
      destination={{ type: 'mtp', storage: 'sd' }} />, { handlers: {
      [IPC.settings.get]: () => defaultAppSettings(),
      [IPC.mtp.getStatus]: () => ({ available: true, adapter: 'powershell', storages: [
        { id: 'sd', label: 'SD install', shellPath: 'shell:::sd', freeBytes: 1000, totalBytes: 2000 },
      ], statusText: 'SD install', checkedAt: new Date().toISOString(), error: null }),
      [IPC.mtp.getInventory]: () => ({ state: 'ready', deviceId: 'switch-1', revision: 5,
        checkedAt: new Date().toISOString(), titles: [], unidentifiedFiles: 0, message: null }),
      [IPC.catalog.getGame]: () => ({ baseFile: { id: 1, filePath: 'C:\\games\\Base.nsp',
        fileName: 'Base.nsp', fileSize: 100 } } as GameDetailsDto),
      [IPC.catalog.listUpdates]: () => [],
      [IPC.install.preview]: () => preview,
      [IPC.install.create]: create,
    } });
    const update = await screen.findByText('Update.nsp');
    expect(update.closest('label')?.querySelector('input')).toBeChecked();
    expect(screen.getByText('Base.nsp').closest('label')?.querySelector('input')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Confirm install' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[0]?.[0]).toMatchObject({ gameId: 1, updateIds: [12],
      includeBaseFile: false, inventoryRevision: 5, allowAlreadyInstalled: false });
  });
});
