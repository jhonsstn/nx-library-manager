import type { Logger } from '../lifecycle/logger';
import type { MtpAdapter, MtpStatus, MtpStorageDestination, ShellFolderSelection } from '../mtp/mtp.adapter';
import { formatMtpStorageStatus } from '../mtp/mtp-status';
import type { MtpStatusDto, MtpStorageInfoDto, MtpInventoryDto } from '../../shared/types/domain';
import type { AppErrorDto } from '../../shared/errors/codes';
import { MTP_STATUS_REFRESH_MS } from '../../shared/constants';
import { parseInstalledListing } from '../mtp/installed-parser';

export interface MtpServiceOptions {
  adapter: MtpAdapter;
  logger?: Logger;
  onStatusChanged?: (status: MtpStatusDto) => void;
  onInventoryChanged?: (inventory: MtpInventoryDto) => void;
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
  private readonly onInventoryChanged: ((inventory: MtpInventoryDto) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly cacheTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cached: { at: number; dto: MtpStatusDto } | null = null;
  private inFlight: Promise<MtpStatusDto> | null = null;
  private inventory: MtpInventoryDto = { state: 'disconnected', deviceId: null, revision: 0,
    checkedAt: null, titles: [], unidentifiedFiles: 0, message: null };
  private inventoryRun: Promise<MtpInventoryDto> | null = null;
  private inventoryAbort: AbortController | null = null;
  private inventoryEpoch = 0;

  constructor(options: MtpServiceOptions) {
    this.adapter = options.adapter;
    this.logger = options.logger;
    this.onStatusChanged = options.onStatusChanged;
    this.onInventoryChanged = options.onInventoryChanged;
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inventoryAbort?.abort();
  }

  getInventory(): MtpInventoryDto { return this.inventory; }

  async refreshInventory(): Promise<MtpInventoryDto> {
    await this.getStatus({ refresh: true });
    if (!this.inventory.deviceId) return this.inventory;
    if (this.inventoryRun) return this.inventoryRun;
    return this.scanInventory(this.inventory.deviceId);
  }

  private publishInventory(next: MtpInventoryDto): MtpInventoryDto {
    this.inventory = next;
    this.onInventoryChanged?.(next);
    return next;
  }

  private observeDevice(deviceId: string | null): void {
    if (!deviceId) {
      this.inventoryEpoch++;
      this.inventoryAbort?.abort();
      if (this.inventory.state !== 'disconnected') this.publishInventory({ state: 'disconnected',
        deviceId: null, revision: this.inventory.revision + 1, checkedAt: null,
        titles: [], unidentifiedFiles: 0, message: null });
      return;
    }
    if (this.inventory.deviceId === deviceId) return;
    this.inventoryEpoch++;
    this.inventoryAbort?.abort();
    void this.scanInventory(deviceId);
  }

  private scanInventory(deviceId: string): Promise<MtpInventoryDto> {
    const epoch = ++this.inventoryEpoch;
    const controller = new AbortController();
    this.inventoryAbort = controller;
    this.publishInventory({ state: 'scanning', deviceId, revision: this.inventory.revision + 1,
      checkedAt: null, titles: [], unidentifiedFiles: 0, message: null });
    const run = (async () => {
      try {
        const listing = await this.adapter.listInstalledTitles(controller.signal);
        if (epoch !== this.inventoryEpoch) return this.inventory;
        if (listing.state !== 'unavailable' && (!listing.deviceId
          || listing.deviceId.toLowerCase() !== deviceId.toLowerCase()))
          throw new Error('The connected Switch changed during the inventory scan.');
        const parsed = parseInstalledListing(listing);
        return this.publishInventory({
          state: listing.state === 'unavailable' ? 'unavailable' : parsed.complete ? 'ready' : 'partial',
          deviceId, revision: this.inventory.revision + 1, checkedAt: new Date().toISOString(),
          titles: listing.state === 'unavailable' ? [] : parsed.titles,
          unidentifiedFiles: parsed.unidentifiedFiles, message: listing.message
            ?? (parsed.titles.length === 0 ? 'No installed titles could be identified in DBI.' : null),
        });
      } catch (error) {
        if (epoch !== this.inventoryEpoch) return this.inventory;
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn('mtp.inventoryFailed', { message });
        return this.publishInventory({ state: 'error', deviceId, revision: this.inventory.revision + 1,
          checkedAt: new Date().toISOString(), titles: [], unidentifiedFiles: 0, message });
      } finally {
        if (epoch === this.inventoryEpoch) { this.inventoryRun = null; this.inventoryAbort = null; }
      }
    })();
    this.inventoryRun = run;
    return run;
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
        if (status.error) {
          this.inventoryEpoch++;
          this.inventoryAbort?.abort();
          if (this.inventory.state !== 'error' || this.inventory.message !== status.error.message)
            this.publishInventory({ state: 'error', deviceId: null,
              revision: this.inventory.revision + 1, checkedAt: new Date().toISOString(),
              titles: [], unidentifiedFiles: 0, message: status.error.message });
          this.logger?.warn('mtp.statusFailed', { error: dto.error?.message });
          this.onStatusChanged?.(dto);
          return dto;
        }
        if ((status.deviceCount ?? 0) > 1) {
          this.inventoryEpoch++;
          this.inventoryAbort?.abort();
          if (this.inventory.state !== 'unavailable'
            || this.inventory.message !== 'More than one Switch MTP device was found.')
            this.publishInventory({ state: 'unavailable', deviceId: null,
              revision: this.inventory.revision + 1, checkedAt: new Date().toISOString(),
              titles: [], unidentifiedFiles: 0, message: 'More than one Switch MTP device was found.' });
          this.onStatusChanged?.(dto);
          return dto;
        }
        const deviceId = status.deviceId === undefined
          ? (status.storages[0]?.shellPath ?? null) : status.deviceId;
        this.observeDevice(deviceId);
        this.logger?.debug('mtp.status', { storages: dto.storages.length });
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
    deviceId: status.deviceId ?? null,
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
