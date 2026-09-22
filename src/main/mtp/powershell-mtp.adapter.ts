import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { MTP_STATUS_TIMEOUT_SECONDS, MTP_TRANSFER_TIMEOUT_SECONDS } from '../../shared/constants';
import { appError, type SwitchCatalogError } from '../../shared/errors/app-error';
import type { AppErrorDto } from '../../shared/errors/codes';
import type {
  MtpAdapter,
  MtpCopyInput,
  MtpStatus,
  MtpStorageDestination,
  ShellFolderSelection,
} from './mtp.adapter';
import {
  destinationForStorageName,
  installDestinationLabel,
  normalizeStorageName,
  toMtpStatus,
} from './mtp-status';
import {
  PowerShellError,
  cleanPowerShellMessage,
  readScript,
  runPowerShell,
  type PowerShellResult,
} from './powershell-runner';

const STATUS_SCRIPT = 'mtp-list-storage.ps1';
const COPY_SCRIPT = 'mtp-copy-file.ps1';
const PICKER_SCRIPT = 'mtp-pick-folder.ps1';

export interface PowerShellMtpAdapterOptions {
  /** Directory holding the `.ps1` programs; defaults to the resolved scripts dir. */
  scriptsDir?: string;
  /** Test seam; defaults to `runPowerShell`. */
  run?: typeof runPowerShell;
  /** Overrides the transfer timeout (`MTP_TRANSFER_TIMEOUT_SECONDS`). */
  timeoutSeconds?: number;
}

/**
 * PowerShell/Shell-COM implementation of `MtpAdapter` (spec 14). The device is
 * only ever reached through the shipped scripts; every failure becomes a
 * status/error envelope instead of an exception, because MTP is optional for
 * the rest of the app.
 */
export class PowerShellMtpAdapter implements MtpAdapter {
  private readonly scriptsDir: string | undefined;
  private readonly runFn: typeof runPowerShell;
  private readonly statusTimeoutSeconds: number;
  private readonly transferTimeoutSeconds: number;
  private pendingStatus: Promise<MtpStatus> | null = null;

  constructor(options: PowerShellMtpAdapterOptions = {}) {
    this.scriptsDir = options.scriptsDir;
    this.runFn = options.run ?? runPowerShell;
    this.statusTimeoutSeconds = MTP_STATUS_TIMEOUT_SECONDS;
    this.transferTimeoutSeconds = options.timeoutSeconds ?? MTP_TRANSFER_TIMEOUT_SECONDS;
  }

  async isAvailable(): Promise<boolean> {
    const status = await this.getStatus();
    return status.storages.length > 0;
  }

  async listInstallDestinations(options: { timeoutSeconds?: number } = {}): Promise<MtpStorageDestination[]> {
    const status = await this.getStatus(options);
    return status.storages;
  }

  /**
   * Overlapping polls (startup, 60s timer, manual refresh, pre-install check)
   * share a single PowerShell process.
   */
  getStatus(options: { timeoutSeconds?: number } = {}): Promise<MtpStatus> {
    const pending = this.pendingStatus;
    if (pending) return pending;
    const started = this.loadStatus(options.timeoutSeconds);
    this.pendingStatus = started;
    const clear = (): void => {
      if (this.pendingStatus === started) this.pendingStatus = null;
    };
    started.then(clear, clear);
    return started;
  }

  private async loadStatus(timeoutSeconds?: number): Promise<MtpStatus> {
    const seconds = timeoutSeconds ?? this.statusTimeoutSeconds;
    try {
      const script = readScript(STATUS_SCRIPT, { scriptsDir: this.scriptsDir });
      const result = await this.runFn({ script, timeoutMs: Math.round(seconds * 1000) });
      if (result.code !== 0) {
        return toMtpStatus([], statusError(scriptMessage(result)), new Date());
      }
      const storages = parseStoragePayload(result.stdout);
      if (storages === null) {
        return toMtpStatus(
          [],
          statusError('Could not read Switch MTP storage: unexpected PowerShell output.'),
          new Date(),
        );
      }
      return toMtpStatus(storages, null, new Date());
    } catch (error) {
      return toMtpStatus([], statusError(statusFailureMessage(error, seconds)), new Date());
    }
  }

  async copyFile(input: MtpCopyInput, signal?: AbortSignal): Promise<void> {
    const fileName = input.fileName || basename(input.sourcePath);
    if (signal?.aborted) {
      throw appError('JOB_CANCELLED', `MTP transfer of '${fileName}' was cancelled before it started.`);
    }
    if (!existsSync(input.sourcePath)) {
      throw appError('FILE_MISSING', `Source file is missing: ${input.sourcePath}`);
    }
    const timeoutSeconds = input.timeoutSeconds ?? this.transferTimeoutSeconds;

    input.onStateChange?.('preparing');
    let started: Promise<PowerShellResult>;
    try {
      const script = readScript(COPY_SCRIPT, { scriptsDir: this.scriptsDir });
      started = this.runFn({
        script,
        timeoutMs: Math.round(timeoutSeconds * 1000),
        env: {
          SWITCH_CATALOG_MTP_DESTINATION: input.destination.shellPath,
          SWITCH_CATALOG_MTP_SOURCE: input.sourcePath,
          SWITCH_CATALOG_MTP_TIMEOUT: String(timeoutSeconds),
        },
      });
    } catch (error) {
      throw copyFailure(error, fileName, timeoutSeconds);
    }
    input.onStateChange?.('copying');

    let result: PowerShellResult;
    try {
      result = await started;
    } catch (error) {
      throw copyFailure(error, fileName, timeoutSeconds);
    }
    if (result.code !== 0) {
      throw appError('MTP_COPY_FAILED', `MTP transfer failed for '${fileName}': ${scriptMessage(result)}`);
    }
    input.onStateChange?.('completed');
  }

  /**
   * The Windows Shell picker blocks until the user chooses, so it runs without a
   * runner deadline. `null` means "no selection" (cancel/empty output).
   */
  async pickShellFolder(title: string): Promise<ShellFolderSelection | null> {
    let result: PowerShellResult;
    try {
      const script = readScript(PICKER_SCRIPT, { scriptsDir: this.scriptsDir });
      result = await this.runFn({
        script,
        timeoutMs: 0,
        env: { SWITCH_CATALOG_MTP_PICKER_TITLE: title },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw appError('MTP_NOT_CONNECTED', `Could not open the folder picker: ${message}`, { retryable: true });
    }
    if (result.code === 2) return null;
    if (result.code !== 0) {
      const message =
        cleanPowerShellMessage(result.stderr) ||
        cleanPowerShellMessage(result.stdout) ||
        'Could not open the Windows Shell folder picker.';
      throw appError('MTP_NOT_CONNECTED', message, { retryable: true });
    }
    const output = result.stdout.trim();
    if (!output) return null;

    const lines = output.split(/\r?\n/);
    const lastLine = lines[lines.length - 1].trim();
    let path = lastLine;
    let label = '';
    try {
      const parsed = JSON.parse(lastLine) as { path?: unknown; label?: unknown };
      path = typeof parsed.path === 'string' ? parsed.path : '';
      label = typeof parsed.label === 'string' ? parsed.label : '';
    } catch {
      /* Python falls back to treating the raw line as the path. */
    }
    const trimmed = path.trim();
    if (!trimmed) return null;
    return { path: trimmed.startsWith('::{') ? `shell:${trimmed}` : trimmed, label };
  }
}

function statusError(message: string): AppErrorDto {
  return { code: 'MTP_NOT_CONNECTED', message, retryable: true };
}

function statusFailureMessage(error: unknown, seconds: number): string {
  if (error instanceof PowerShellError) {
    if (error.timedOut) return `MTP status check timed out after ${seconds} seconds.`;
    return error.message;
  }
  return `Could not read Switch MTP storage: ${error instanceof Error ? error.message : String(error)}`;
}

function copyFailure(error: unknown, fileName: string, timeoutSeconds: number): SwitchCatalogError {
  if (error instanceof PowerShellError && error.timedOut) {
    return appError(
      'MTP_COPY_FAILED',
      `MTP transfer timed out for '${fileName}' after ${timeoutSeconds} seconds.`,
      { retryable: true },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return appError('MTP_COPY_FAILED', `MTP transfer failed for '${fileName}': ${message}`);
}

/** Python reported either stream's cleaned message, with a code fallback. */
function scriptMessage(result: PowerShellResult): string {
  const message = cleanPowerShellMessage(result.stderr) || cleanPowerShellMessage(result.stdout);
  return message || `PowerShell exited with status ${result.code}.`;
}

function toPositiveBytes(value: unknown): number | null {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : null;
}

/** Row shape emitted by `ConvertTo-Json` in `mtp-list-storage.ps1`. */
interface RawStorageRow {
  name?: unknown;
  free_bytes?: unknown;
  total_bytes?: unknown;
  path?: unknown;
}

/**
 * Parses the script's trailing JSON line. `null` signals unparseable output;
 * an empty array means "no Switch attached", which is not an error.
 */
function parseStoragePayload(stdout: string): MtpStorageDestination[] | null {
  const output = stdout.trim();
  if (!output) return [];
  const lines = output.split(/\r?\n/);
  let payload: unknown;
  try {
    payload = JSON.parse(lines[lines.length - 1].trim());
  } catch {
    return null;
  }
  const items: unknown[] = Array.isArray(payload) ? payload : [payload];
  const storages: MtpStorageDestination[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as RawStorageRow;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const destination = destinationForStorageName(normalizeStorageName('', name));
    if (!destination) continue;
    const freeBytes = toPositiveBytes(row.free_bytes);
    const totalBytes = toPositiveBytes(row.total_bytes);
    if (freeBytes === null || totalBytes === null) continue;
    storages.push({
      id: destination,
      name,
      label: installDestinationLabel(destination),
      shellPath: typeof row.path === 'string' ? row.path.trim() : '',
      freeBytes,
      totalBytes,
    });
  }
  return storages;
}
