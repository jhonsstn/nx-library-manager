import { MTP_INSTALL_DESTINATIONS } from '../../shared/constants';
import type { AppErrorDto } from '../../shared/errors/codes';
import { formatBytes } from '../../shared/format/bytes';
import type { MtpStorageInfoDto } from '../../shared/types/domain';
import type { MtpStatus, MtpStorageDestination } from './mtp.adapter';

/** The two install destinations Windows exposes for a connected Switch. */
export type MtpInstallDestination = 'sd' | 'nand';

/** Canonical names emitted by the PowerShell `Normalize-StorageName` helper. */
export const SD_STORAGE_NAME = 'SD install';
export const NAND_STORAGE_NAME = 'NAND install';

/**
 * Ports `_normalize_shell_compare_path`: shell paths compare case-insensitively
 * and ignore the `shell:` prefix plus trailing separators, so
 * `shell:::20D0...\SD install\` and `::{20D0...}\SD install` match.
 */
export function normalizeShellComparePath(value: string): string {
  let text = String(value ?? '')
    .trim()
    .replace(/\//g, '\\');
  if (text.toLowerCase().startsWith('shell:')) text = text.slice(6);
  return text.replace(/\\+$/, '').toLowerCase();
}

/**
 * Ports `_mtp_storage_sort_key`: NAND is listed before SD, everything else last.
 */
export function storageSortKey(name: string): [number, string] {
  const lowered = String(name ?? '').toLowerCase();
  if (lowered.includes('nand')) return [0, lowered];
  if (lowered === 'sd' || lowered.includes('sd')) return [1, lowered];
  return [2, lowered];
}

/** Ports `_format_mtp_storage_status`: `"SD install: 10.0 GB free / 30.0 GB"`. */
export function formatMtpStorageStatus(storages: MtpStorageDestination[]): string {
  if (storages.length === 0) return '';
  const ordered = [...storages].sort((left, right) => {
    const [leftRank, leftName] = storageSortKey(left.name);
    const [rightRank, rightName] = storageSortKey(right.name);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  return ordered
    .map((storage) => `${storage.name}: ${formatBytes(storage.freeBytes)} free / ${formatBytes(storage.totalBytes)}`)
    .join(' | ');
}

/**
 * Ports `_normalize_mtp_install_destination`. Accepts the user-facing labels the
 * renderer sends (`sd`, `SD Card`, `NAND`) and returns the storage id.
 */
export function normalizeInstallDestination(destination: string): MtpInstallDestination | '' {
  const text = String(destination ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/-/g, ' ');
  if (text.includes('nand')) return 'nand';
  if (text === 'sd' || text === 'sd card' || text.includes('sd card') || text.includes('sd install')) return 'sd';
  return text === 'nand' ? 'nand' : '';
}

/** Friendly label from `MTP_INSTALL_DESTINATIONS`, e.g. `SD Card install`. */
export function installDestinationLabel(destination: MtpInstallDestination): string {
  return MTP_INSTALL_DESTINATIONS[destination].label;
}

/** Windows storage name from `MTP_INSTALL_DESTINATIONS`, e.g. `SD install`. */
export function installDestinationStorageName(destination: MtpInstallDestination): string {
  return MTP_INSTALL_DESTINATIONS[destination].storageName;
}

/** Maps a Windows storage name (any casing) back to its destination id. */
export function destinationForStorageName(storageName: string): MtpInstallDestination | null {
  const lowered = String(storageName ?? '').trim().toLowerCase();
  if (!lowered) return null;
  for (const destination of ['sd', 'nand'] as const) {
    if (MTP_INSTALL_DESTINATIONS[destination].storageName.toLowerCase() === lowered) return destination;
  }
  return null;
}

/** Ports `mtp_install_destination_info`'s storage match: name equality, case-insensitive. */
export function findStorageForDestination(
  storages: MtpStorageDestination[],
  destination: MtpInstallDestination,
): MtpStorageDestination | null {
  const expected = installDestinationStorageName(destination).toLowerCase();
  for (const storage of storages) {
    if (String(storage.name ?? '').trim().toLowerCase() === expected) return storage;
  }
  return null;
}

/**
 * Ports `mtp_destination_storage_info`: the deepest storage whose shell path
 * contains the selected folder wins, so `...\SD install\games` resolves to the
 * SD storage rather than the device root.
 */
export function findStorageForShellPath(
  storages: MtpStorageDestination[],
  folder: string,
): MtpStorageDestination | null {
  const destination = normalizeShellComparePath(folder);
  let best: MtpStorageDestination | null = null;
  let bestLength = -1;
  for (const storage of storages) {
    const storagePath = normalizeShellComparePath(storage.shellPath ?? '');
    if (!storagePath) continue;
    if (destination !== storagePath && !destination.startsWith(`${storagePath}\\`)) continue;
    if (storagePath.length > bestLength) {
      best = storage;
      bestLength = storagePath.length;
    }
  }
  return best;
}

/**
 * Ports the PowerShell `Normalize-StorageName` function: only the two install
 * locations are recognised. `deviceName` is part of the original signature and
 * is deliberately unused there too.
 */
export function normalizeStorageName(_deviceName: string, storageName: string): string {
  const name = String(storageName ?? '').trim();
  if (!name) return '';
  const isInstall = /install/i.test(name);
  if (isInstall && /(?:\bsd\b|sd card|microsd)/i.test(name)) return SD_STORAGE_NAME;
  if (isInstall && /nand/i.test(name)) return NAND_STORAGE_NAME;
  return '';
}

/** Builds the `MtpStatus` envelope consumed by the renderer (specs 08/14). */
export function toMtpStatus(
  storages: MtpStorageDestination[],
  error: AppErrorDto | null,
  now: Date = new Date(),
  deviceId: string | null = null,
  deviceCount = 0,
): MtpStatus {
  return {
    available: storages.length > 0,
    adapter: 'powershell',
    storages,
    checkedAt: now.toISOString(),
    error,
    deviceId,
    ...(deviceCount > 1 ? { deviceCount } : {}),
  };
}

/** Renderer-facing projection of a storage destination. */
export function toStorageInfoDto(storage: MtpStorageDestination): MtpStorageInfoDto {
  return {
    id: storage.id,
    label: storage.label,
    shellPath: storage.shellPath,
    freeBytes: storage.freeBytes,
    totalBytes: storage.totalBytes,
  };
}
