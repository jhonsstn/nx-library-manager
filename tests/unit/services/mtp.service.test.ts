import { afterEach, describe, expect, it, vi } from 'vitest';
import { MtpService, toMtpStatusDto } from '@main/services/mtp.service';
import type { MtpAdapter, MtpInstalledListing, MtpStatus, MtpStorageDestination, ShellFolderSelection } from '@main/mtp/mtp.adapter';

const GB = 1024 * 1024 * 1024;

function storage(overrides: Partial<MtpStorageDestination> = {}): MtpStorageDestination {
  return {
    id: 'sd',
    name: 'SD install',
    label: 'SD Card install',
    shellPath: 'shell:::sd',
    freeBytes: 2 * GB,
    totalBytes: 8 * GB,
    ...overrides,
  };
}

interface FakeAdapter {
  adapter: MtpAdapter;
  statusCalls: number;
  pickCalls: string[];
  listing: MtpInstalledListing;
  status: MtpStatus;
}

function fakeAdapter(status: MtpStatus): FakeAdapter {
  const state: FakeAdapter = {
    statusCalls: 0,
    pickCalls: [],
    status,
    listing: { state: 'ready', deviceId: 'switch-1', files: [], unidentifiedFiles: 0, message: null },
    adapter: {
      async isAvailable() {
        return state.status.available;
      },
      async listInstallDestinations() {
        return state.status.storages;
      },
      async getStatus() {
        state.statusCalls += 1;
        return state.status;
      },
      async listInstalledTitles() {
        return state.listing;
      },
      async copyFile() {
        /* not exercised here */
      },
      async pickShellFolder(title: string): Promise<ShellFolderSelection | null> {
        state.pickCalls.push(title);
        return { path: 'shell:::picked', label: 'Switch/SD Card Install' };
      },
    },
  };
  return state;
}

function okStatus(storages: MtpStorageDestination[]): MtpStatus {
  return { available: storages.length > 0, adapter: 'powershell', storages, checkedAt: '2026-01-01T00:00:00.000Z', error: null };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('toMtpStatusDto', () => {
  it('summarizes storages in NAND-then-SD order with friendly labels', () => {
    const dto = toMtpStatusDto(
      okStatus([
        storage(),
        storage({ id: 'nand', name: 'NAND install', label: 'NAND install', freeBytes: GB, totalBytes: 4 * GB }),
      ]),
    );
    expect(dto.available).toBe(true);
    expect(dto.statusText).toBe('NAND install: 1.0 GB free / 4.0 GB | SD install: 2.0 GB free / 8.0 GB');
    expect(dto.storages).toEqual([
      { id: 'sd', label: 'SD Card install', shellPath: 'shell:::sd', freeBytes: 2 * GB, totalBytes: 8 * GB },
      { id: 'nand', label: 'NAND install', shellPath: 'shell:::sd', freeBytes: GB, totalBytes: 4 * GB },
    ]);
  });

  it('reports unknown sizes as null and an empty list as unavailable', () => {
    const dto = toMtpStatusDto(okStatus([storage({ freeBytes: 0, totalBytes: 0 })]));
    expect(dto.storages[0]).toMatchObject({ freeBytes: null, totalBytes: null });
    expect(toMtpStatusDto(okStatus([]))).toMatchObject({ available: false, statusText: '' });
  });
});

describe('MtpService', () => {
  it('caches a recent status and re-reads when a refresh is requested', async () => {
    const fake = fakeAdapter(okStatus([storage()]));
    const service = new MtpService({ adapter: fake.adapter, cacheTtlMs: 60_000 });

    const first = await service.getStatus();
    const second = await service.getStatus();
    expect(first).toBe(second);
    expect(fake.statusCalls).toBe(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    await service.getStatus({ refresh: true });
    expect(fake.statusCalls).toBe(2);
  });

  it('coalesces concurrent refreshes into one adapter call', async () => {
    const fake = fakeAdapter(okStatus([storage()]));
    const service = new MtpService({ adapter: fake.adapter });

    const [a, b, c] = await Promise.all([
      service.getStatus({ refresh: true }),
      service.getStatus({ refresh: true }),
      service.getStatus({ refresh: true }),
    ]);
    expect(fake.statusCalls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('publishes each refreshed status to the renderer callback', async () => {
    const fake = fakeAdapter(okStatus([storage()]));
    const seen: string[] = [];
    const service = new MtpService({ adapter: fake.adapter, onStatusChanged: (status) => seen.push(status.statusText) });

    await service.getStatus({ refresh: true });
    expect(seen).toEqual(['SD install: 2.0 GB free / 8.0 GB']);
  });

  it('polls while started and stops cleanly', async () => {
    vi.useFakeTimers();
    const fake = fakeAdapter(okStatus([storage()]));
    const service = new MtpService({ adapter: fake.adapter, pollIntervalMs: 1000 });
    service.start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(fake.statusCalls).toBeGreaterThanOrEqual(3);
    service.stop();
    const afterStop = fake.statusCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.statusCalls).toBe(afterStop);
    service.stop();
  });

  it('delegates the Shell folder picker to the adapter', async () => {
    const fake = fakeAdapter(okStatus([storage()]));
    const service = new MtpService({ adapter: fake.adapter });
    await expect(service.pickShellFolder('Choose Switch install folder')).resolves.toEqual({
      path: 'shell:::picked',
      label: 'Switch/SD Card Install',
    });
    expect(fake.pickCalls).toEqual(['Choose Switch install folder']);
  });

  it('scans on connection, keeps positive matches from a partial scan, and clears them on disconnect', async () => {
    const fake = fakeAdapter({ ...okStatus([storage()]), deviceId: 'switch-1', deviceCount: 1 });
    fake.listing = { state: 'partial', deviceId: 'switch-1', files: [
      { folderName: 'Hades', fileName: 'Hades [0100AABBCCDD0000][v0].nsp' },
    ], unidentifiedFiles: 1, message: 'One entry was not readable.' };
    const service = new MtpService({ adapter: fake.adapter });
    await service.getStatus({ refresh: true });
    const partial = await service.refreshInventory();
    expect(partial.state).toBe('partial');
    expect(partial.titles).toEqual([{ titleId: '0100AABBCCDD0000', type: 'base', rawVersion: 0 }]);
    expect(partial.unidentifiedFiles).toBe(1);

    fake.status = { ...okStatus([]), deviceId: null, deviceCount: 0 };
    await service.getStatus({ refresh: true });
    expect(service.getInventory()).toMatchObject({ state: 'disconnected', deviceId: null, titles: [] });
  });

  it('rejects ambiguous multiple devices without accepting an inventory', async () => {
    const fake = fakeAdapter({ ...okStatus([storage()]), deviceId: null, deviceCount: 2 });
    const service = new MtpService({ adapter: fake.adapter });
    await service.getStatus({ refresh: true });
    expect(service.getInventory()).toMatchObject({ state: 'unavailable', titles: [], deviceId: null });
    expect(service.getInventory().message).toMatch(/More than one/);
  });

  it('cancels an in-flight enumeration and discards its result on disconnect', async () => {
    const fake = fakeAdapter({ ...okStatus([storage()]), deviceId: 'switch-1', deviceCount: 1 });
    const finish: Array<(value: MtpInstalledListing) => void> = [];
    let aborted = false;
    fake.adapter.listInstalledTitles = (signal) => new Promise((resolve) => {
      finish.push(resolve);
      signal?.addEventListener('abort', () => { aborted = true; });
    });
    const service = new MtpService({ adapter: fake.adapter });
    await service.getStatus({ refresh: true });
    expect(service.getInventory().state).toBe('scanning');
    fake.status = { ...okStatus([]), deviceId: null, deviceCount: 0 };
    await service.getStatus({ refresh: true });
    expect(aborted).toBe(true);
    finish[0]?.({ state: 'ready', deviceId: 'switch-1', files: [
      { folderName: 'Old', fileName: 'Old [0100AABBCCDD0000].nsp' },
    ], unidentifiedFiles: 0, message: null });
    await Promise.resolve();
    expect(service.getInventory()).toMatchObject({ state: 'disconnected', titles: [] });
  });

  it('does not turn a failed status check into a claim that the Switch disconnected', async () => {
    const fake = fakeAdapter({ ...okStatus([storage()]), deviceId: 'switch-1', deviceCount: 1 });
    const service = new MtpService({ adapter: fake.adapter });
    await service.refreshInventory();
    fake.status = { ...okStatus([]), deviceId: null, deviceCount: 0,
      error: { code: 'MTP_NOT_CONNECTED', message: 'Shell timed out', retryable: true } };
    await service.getStatus({ refresh: true });
    expect(service.getInventory()).toMatchObject({ state: 'error', titles: [], message: 'Shell timed out' });
  });
});
