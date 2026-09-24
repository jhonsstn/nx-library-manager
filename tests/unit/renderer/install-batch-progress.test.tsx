// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { InstallBatchProgress } from '@renderer/features/install/InstallBatchProgress';
import { IPC } from '@shared/contracts/ipc';
import type { ContainedTitleDto, InstallJobDto, MtpInventoryDto } from '@shared/types/domain';
import { renderWithProviders } from '../../helpers/render';

const job: InstallJobDto = { id: 41, gameId: 1, sourcePath: 'C:/games/Pack.nsp',
  displayName: 'Pack.nsp', destinationType: 'mtp-sd', destinationFolder: 'shell:::sd',
  destinationLabel: 'SD install', destinationPath: null, fileKind: 'dlc', detectedVersion: '',
  rawVersion: 0, sizeBytes: 1024, transferredBytes: 1024, status: 'completed', error: null,
  createdAt: '2026-09-24T12:00:00Z', completedAt: '2026-09-24T12:01:00Z' };
const contents: ContainedTitleDto[] = [{ filePath: job.sourcePath, titleId: '0100000000011001',
  baseTitleId: '0100000000010000', type: 'dlc', name: 'Pack', rawVersion: 0,
  source: 'cnmt', provisional: false, inspectionError: null }];
const inventory: MtpInventoryDto = { state: 'partial', deviceId: 'switch-1', revision: 2,
  checkedAt: '2026-09-24T12:02:00Z', unidentifiedFiles: 1, message: null,
  titles: [{ titleId: '0100000000011001', type: 'dlc', rawVersion: 0 }] };
const before: MtpInventoryDto = { ...inventory, state: 'ready', revision: 1, titles: [] };

describe('InstallBatchProgress', () => {
  it('shows file-count progress while a small file is being copied', async () => {
    renderWithProviders(<InstallBatchProgress jobs={[{ ...job, status: 'running', transferredBytes: 0 }]}
      contents={contents} deviceId="switch-1" before={before} onClose={() => undefined} />, { handlers: {
      [IPC.install.list]: () => [{ ...job, status: 'running', transferredBytes: 0 }],
    } });
    expect(await screen.findByText('Copying file 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('Current: Pack.nsp')).toBeInTheDocument();
    expect(screen.getByText(/Keep the Switch connected/)).toBeInTheDocument();
    expect(screen.queryByText(/You can disconnect/)).not.toBeInTheDocument();
  });

  it('only says the Switch can be disconnected after a fresh positive DBI scan', async () => {
    renderWithProviders(<InstallBatchProgress jobs={[job]} contents={contents}
      deviceId="switch-1" before={before} onClose={() => undefined} />, { handlers: {
      [IPC.install.list]: () => [job],
      [IPC.mtp.refreshInventory]: () => inventory,
    } });
    expect(await screen.findByText(/You can disconnect the Switch/)).toBeInTheDocument();
    expect(screen.getByText('Installed content confirmed on Switch')).toBeInTheDocument();
  });
});
