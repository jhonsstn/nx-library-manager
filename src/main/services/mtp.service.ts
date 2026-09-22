import type { Logger } from '../lifecycle/logger';
import type { MtpAdapter, MtpStatus, MtpStorageDestination, ShellFolderSelection } from '../mtp/mtp.adapter';
import { formatMtpStorageStatus } from '../mtp/mtp-status';
import type { MtpStatusDto, MtpStorageInfoDto } from '../../shared/types/domain';
import type { AppErrorDto } from '../../shared/errors/codes';
import { MTP_STATUS_REFRESH_MS } from '../../shared/constants';

export interface MtpServiceOptions {
  adapter: MtpAdapter;
  logger?: Logger;
  onStatusChanged?: (status: MtpStatusDto) => void;
  pollIntervalMs?: number;
  /** Cached statuses younger than this are reused without another PowerShell call. */
  cacheTtlMs?: number;
}

/**
 * Owns MTP status polling (spec 14): an initial refresh, a ~60s cadence, a manual
 * refresh, and coalescing so overlapping PowerShell status jobs never stack up.
 */
export class MtpService {
  private readonly adapter: MtpAdapter;
  private readonly logger: Logger | undefined;
  private readonly onStatusChanged: ((status: MtpStatusDto) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly cacheTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cached: { at: number; dto: MtpStatusDto } | null = null;
  private inFlight: Promise<MtpStatusDto> | null = null;

  constructor(options: MtpServiceOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;
    this.onStatusChanged = options.onStatusChanged;
    this.pollIntervalMs = options.pollIntervalMs ?? MTP_STATUS_REFRESH_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? 5_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.getStatus({ refresh: true });
    }, this.pollIntervalMs);
    this.timer.unref?.();
    void this.getStatus({ refresh: true });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Windows Shell folder picker for MTP destinations (spec 11 folder chooser). */
  pickShellFolder(title: string): Promise<ShellFolderSelection | null> {
    return this.adapter.pickShellFolder(title);
  }

  /** `refresh` bypasses the short-lived cache; concurrent callers share one run. */
  async getStatus(options: { refresh?: boolean } = {}): Promise<MtpStatusDto> {
    if (!options.refresh && this.cached && Date.now() - this.cached.at < this.cacheTtlMs) {
      return this.cached.dto;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const status = await this.adapter.getStatus();
        const dto = toMtpStatusDto(status);
        this.cached = { at: Date.now(), dto };
        if (dto.error) {
          this.logger?.warn('mtp.statusFailed', { error: dto.error.message });
        } else {
          this.logger?.debug('mtp.status', { storages: dto.storages.length });
        }
        this.onStatusChanged?.(dto);
        return dto;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}

/** Maps the adapter's status onto the DTO, adding the display summary. */
export function toMtpStatusDto(status: MtpStatus): MtpStatusDto {
  return {
    available: status.available,
    adapter: status.adapter,
    storages: status.storages.map(toStorageInfoDto),
    statusText: formatMtpStorageStatus(status.storages),
    checkedAt: status.checkedAt,
    error: status.error as AppErrorDto | null,
  };
}

function toStorageInfoDto(storage: MtpStorageDestination): MtpStorageInfoDto {
  return {
    id: storage.id,
    label: storage.label,
    shellPath: storage.shellPath,
    freeBytes: storage.freeBytes > 0 ? storage.freeBytes : null,
    totalBytes: storage.totalBytes > 0 ? storage.totalBytes : null,
  };
}
