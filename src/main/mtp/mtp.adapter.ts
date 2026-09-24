import type { AppErrorDto } from '../../shared/errors/codes';

/**
 * Platform-neutral MTP boundary (`docs/platform/14-windows-mtp.md`).
 *
 * No renderer or catalog service may shell out to PowerShell directly; the only
 * current implementation is the PowerShell
 * adapter, and a future WPD/native adapter must be swappable without touching
 * services or React code.
 */
export interface MtpStorageDestination {
  id: 'sd' | 'nand';
  /** Friendly storage name as reported by Windows, e.g. `SD install`. */
  name: string;
  label: string;
  shellPath: string;
  freeBytes: number;
  totalBytes: number;
}

export interface MtpStatus {
  available: boolean;
  adapter: 'powershell';
  storages: MtpStorageDestination[];
  checkedAt: string;
  error: AppErrorDto | null;
  deviceId?: string | null;
  deviceCount?: number;
}

export interface MtpVirtualFile { folderName: string; fileName: string }
export interface MtpInstalledListing {
  state: 'ready' | 'partial' | 'unavailable';
  deviceId: string | null;
  files: MtpVirtualFile[];
  unidentifiedFiles: number;
  message: string | null;
}

export const MTP_TRANSFER_STATES = ['preparing', 'copying', 'completed'] as const;

/**
 * The PowerShell mechanism cannot report reliable byte progress, so transfers
 * report state transitions instead of fabricated percentages (spec 08).
 */
export type MtpTransferState = (typeof MTP_TRANSFER_STATES)[number];

export interface MtpCopyInput {
  sourcePath: string;
  destination: MtpStorageDestination;
  fileName: string;
  totalBytes: number;
  timeoutSeconds?: number;
  onStateChange?: (state: MtpTransferState) => void;
}

export interface ShellFolderSelection {
  path: string;
  label: string;
}

export interface MtpAdapter {
  isAvailable(): Promise<boolean>;
  /** Enumerates the SD/NAND install destinations, never overlapping calls. */
  listInstallDestinations(options?: { timeoutSeconds?: number }): Promise<MtpStorageDestination[]>;
  getStatus(options?: { timeoutSeconds?: number }): Promise<MtpStatus>;
  copyFile(input: MtpCopyInput, signal?: AbortSignal): Promise<void>;
  /** Windows Shell folder picker (used for MTP install folder selection). */
  pickShellFolder(title: string): Promise<ShellFolderSelection | null>;
  listInstalledTitles(signal?: AbortSignal): Promise<MtpInstalledListing>;
}
