// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { InstallBatchProgress } from '@renderer/features/install/InstallBatchProgress';
import { IPC } from '@shared/contracts/ipc';
import type { InstallJobDto } from '@shared/types/domain';
import { renderWithProviders } from '../../helpers/render';

const job: InstallJobDto = { id: 41, gameId: 1, sourcePath: 'C:/games/Pack.nsp',
  displayName: 'Pack.nsp', destinationType: 'mtp-sd', destinationFolder: 'shell:::sd',
  destinationLabel: 'SD install', destinationPath: null, fileKind: 'dlc', detectedVersion: '',
  rawVersion: 0, sizeBytes: 1024, transferredBytes: 1024, status: 'completed', error: null,
  createdAt: '2026-09-24T12:00:00Z', completedAt: '2026-09-24T12:01:00Z' };
describe('InstallBatchProgress', () => {
  it('shows file-count progress while a small file is being copied', async () => {
    renderWithProviders(<InstallBatchProgress jobs={[{ ...job, status: 'running', transferredBytes: 0 }]}
      onClose={() => undefined} />, { handlers: {
      [IPC.install.list]: () => [{ ...job, status: 'running', transferredBytes: 0 }],
    } });
    expect(await screen.findByText('Transferring 1 file to Switch')).toBeInTheDocument();
    expect(screen.getByText(/Keep the Switch connected/)).toBeInTheDocument();
    expect(screen.queryByText('Transfer successful')).not.toBeInTheDocument();
  });

  it('reports transfer success without refreshing the cached DBI inventory', async () => {
    renderWithProviders(<InstallBatchProgress jobs={[job]} onClose={() => undefined} />, { handlers: {
      [IPC.install.list]: () => [job],
      [IPC.mtp.refreshInventory]: () => { throw new Error('must not refresh'); },
    } });
    expect(await screen.findByText('Transfer successful')).toBeInTheDocument();
    expect(screen.getByText('All selected files finished transferring to the Switch.')).toBeInTheDocument();
  });

  it('shows and copies the transfer failure report', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const failed = { ...job, status: 'failed' as const, error: { code: 'MTP_COPY_FAILED' as const,
      message: 'Value does not fall within the expected range',
      details: { stdout: 'MTP_PRETRANSFER_FAILED at resolve destination' } } };
    renderWithProviders(<InstallBatchProgress jobs={[failed]} onClose={() => undefined} />,
      { handlers: { [IPC.install.list]: () => [failed] } });
    expect(await screen.findByText('Transfer stopped')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy error log' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('MTP_PRETRANSFER_FAILED'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('C:/games/Pack.nsp'));
  });
});
