import { describe, expect, it } from 'vitest';

import type { MtpStorageDestination } from '@main/mtp/mtp.adapter';
import {
  destinationForStorageName,
  findStorageForDestination,
  findStorageForShellPath,
  formatMtpStorageStatus,
  installDestinationLabel,
  installDestinationStorageName,
  normalizeInstallDestination,
  normalizeShellComparePath,
  normalizeStorageName,
  toMtpStatus,
  toStorageInfoDto,
} from '@main/mtp/mtp-status';

const GB5 = 5_368_709_120;
const TB3 = 3_298_534_883_328;

function destination(overrides: Partial<MtpStorageDestination> & { name: string }): MtpStorageDestination {
  return {
    id: 'sd',
    label: 'SD Card install',
    shellPath: '',
    freeBytes: 0,
    totalBytes: 0,
    ...overrides,
  };
}

describe('normalizeShellComparePath', () => {
  it('strips the shell: prefix, unifies separators and folds case', () => {
    expect(normalizeShellComparePath('shell:::{20D0-1}\\SD Install\\')).toBe('::{20d0-1}\\sd install');
    expect(normalizeShellComparePath('::{20D0-1}/SD Install/Games//')).toBe('::{20d0-1}\\sd install\\games');
    expect(normalizeShellComparePath('   ')).toBe('');
  });
});

describe('formatMtpStorageStatus', () => {
  it('orders NAND before SD before other stores and formats sizes', () => {
    const text = formatMtpStorageStatus([
      destination({ name: 'Other volume', freeBytes: 512, totalBytes: 1023 }),
      destination({ id: 'sd', name: 'SD install', freeBytes: GB5, totalBytes: TB3 }),
      destination({ id: 'nand', name: 'NAND install', freeBytes: 1_048_576, totalBytes: 1536 }),
    ]);
    expect(text).toBe(
      [
        'NAND install: 1.0 MB free / 1.5 KB',
        'SD install: 5.0 GB free / 3.0 TB',
        'Other volume: 512.0 B free / 1023.0 B',
      ].join(' | '),
    );
  });

  it('breaks ties between unrecognised names with the lowercased name', () => {
    expect(
      formatMtpStorageStatus([
        destination({ name: 'Zeta volume', freeBytes: 1, totalBytes: 1 }),
        destination({ name: 'alpha volume', freeBytes: 1, totalBytes: 1 }),
      ]),
    ).toBe('alpha volume: 1.0 B free / 1.0 B | Zeta volume: 1.0 B free / 1.0 B');
  });

  it('is empty when nothing is connected', () => {
    expect(formatMtpStorageStatus([])).toBe('');
  });
});

describe('normalizeInstallDestination', () => {
  it('maps renderer labels onto the two storage ids', () => {
    expect(normalizeInstallDestination('sd')).toBe('sd');
    expect(normalizeInstallDestination('SD Card')).toBe('sd');
    expect(normalizeInstallDestination('sd_card')).toBe('sd');
    expect(normalizeInstallDestination('SD install')).toBe('sd');
    expect(normalizeInstallDestination('NAND')).toBe('nand');
    expect(normalizeInstallDestination('nand install')).toBe('nand');
    expect(normalizeInstallDestination('nand-install')).toBe('nand');
  });

  it('rejects unrelated text', () => {
    expect(normalizeInstallDestination('Switch internal storage')).toBe('');
    expect(normalizeInstallDestination('')).toBe('');
  });
});

describe('install destination labels', () => {
  it('exposes the friendly label and the Windows storage name', () => {
    expect(installDestinationLabel('sd')).toBe('SD Card install');
    expect(installDestinationStorageName('sd')).toBe('SD install');
    expect(installDestinationLabel('nand')).toBe('NAND install');
    expect(installDestinationStorageName('nand')).toBe('NAND Install');
    expect(destinationForStorageName('sd install')).toBe('sd');
    expect(destinationForStorageName('NAND Install')).toBe('nand');
    expect(destinationForStorageName('Games')).toBeNull();
  });
});

describe('normalizeStorageName', () => {
  it('recognises only the two install locations', () => {
    expect(normalizeStorageName('Nintendo Switch', 'SD install')).toBe('SD install');
    expect(normalizeStorageName('Nintendo Switch', 'microSD install')).toBe('SD install');
    expect(normalizeStorageName('Nintendo Switch', 'NAND Install')).toBe('NAND install');
    expect(normalizeStorageName('Nintendo Switch', 'SD Card')).toBe('');
    expect(normalizeStorageName('Nintendo Switch', 'This PC')).toBe('');
    expect(normalizeStorageName('Nintendo Switch', '')).toBe('');
  });
});

describe('findStorageForShellPath', () => {
  const deviceRoot = destination({
    id: 'nand',
    name: 'NAND Install',
    shellPath: '::{20D0-1}',
  });
  const sd = destination({ name: 'SD install', shellPath: '::{20D0-1}\\SD install' });

  it('picks the deepest matching storage regardless of order', () => {
    expect(findStorageForShellPath([deviceRoot, sd], 'shell:::{20D0-1}\\SD install\\games')).toBe(sd);
    expect(findStorageForShellPath([sd, deviceRoot], 'shell:::{20D0-1}\\SD install\\games')).toBe(sd);
    expect(findStorageForShellPath([deviceRoot, sd], 'shell:::{20D0-1}')).toBe(deviceRoot);
  });

  it('ignores separator style, trailing separators and case', () => {
    expect(findStorageForShellPath([deviceRoot, sd], '::{20D0-1}/SD Install/Games/')).toBe(sd);
  });

  it('returns null for an unrelated folder', () => {
    expect(findStorageForShellPath([deviceRoot, sd], 'shell:::{OTHER}\\SD install')).toBeNull();
    expect(findStorageForShellPath([], 'shell:::{20D0-1}')).toBeNull();
  });
});

describe('findStorageForDestination', () => {
  it('matches the Windows storage name case-insensitively', () => {
    const sd = destination({ name: 'sd install' });
    const nand = destination({ id: 'nand', name: 'NAND Install' });
    expect(findStorageForDestination([sd, nand], 'sd')).toBe(sd);
    expect(findStorageForDestination([sd, nand], 'nand')).toBe(nand);
    expect(findStorageForDestination([sd], 'nand')).toBeNull();
  });
});

describe('toMtpStatus', () => {
  const now = new Date('2026-09-22T10:00:00.000Z');

  it('reports availability from the storage list', () => {
    const sd = destination({ name: 'SD install', freeBytes: GB5, totalBytes: TB3 });
    expect(toMtpStatus([sd], null, now)).toEqual({
      available: true,
      adapter: 'powershell',
      storages: [sd],
      checkedAt: '2026-09-22T10:00:00.000Z',
      error: null,
      deviceId: null,
    });
  });

  it('keeps the error envelope when nothing was found', () => {
    const status = toMtpStatus([], { code: 'MTP_NOT_CONNECTED', message: 'No device', retryable: true }, now);
    expect(status.available).toBe(false);
    expect(status.adapter).toBe('powershell');
    expect(status.storages).toEqual([]);
    expect(status.error).toEqual({ code: 'MTP_NOT_CONNECTED', message: 'No device', retryable: true });
  });
});

describe('toStorageInfoDto', () => {
  it('projects the destination onto the renderer DTO', () => {
    const sd = destination({ name: 'SD install', shellPath: 'shell:::{20D0-1}\\SD install', freeBytes: GB5, totalBytes: TB3 });
    expect(toStorageInfoDto(sd)).toEqual({
      id: 'sd',
      label: 'SD Card install',
      shellPath: 'shell:::{20D0-1}\\SD install',
      freeBytes: GB5,
      totalBytes: TB3,
    });
  });
});
