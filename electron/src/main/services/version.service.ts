import type { AppDatabase } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { AppPaths } from '../platform/paths';
import type { InstalledStatusDto, VersionInfoDto, VersionStatusDto } from '../../shared/types/domain';
import { deriveUpdateStatusKind } from '../../shared/format/versions';
import { isPathInsideFolder } from '../../shared/format/install';
import { latestCompletedInstall } from '../repositories/install-jobs.repository';
import { loadVersionRecords } from '../versions/version-cache';
import { versionStatusInput, type VersionRecords } from '../versions/version-records';

export interface VersionServiceOptions {
  db: AppDatabase;
  paths: AppPaths;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface InstalledStatusInput {
  gameId: number;
  baseFilePath: string | null;
  /** Packed versions detected on disk (base file plus its update files). */
  localVersions: number[];
  installFolder: string;
  installFolderLabel: string;
}

/**
 * Composes cached TitleDB data with the catalog so the UI can show
 * current-vs-released version state. A failed refresh keeps the previous cache
 * instead of breaking the library (spec 06/07).
 */
export class VersionService {
  private readonly db: AppDatabase;
  private readonly paths: AppPaths;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private records: VersionRecords = {};
  private loaded = false;

  constructor(options: VersionServiceOptions) {
    this.db = options.db;
    this.paths = options.paths;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Loads from cache, refreshing once the 24h staleness window has passed. */
  async load(options: { refresh?: boolean } = {}): Promise<VersionRecords> {
    const result = await loadVersionRecords({
      paths: { versionsJsonFile: this.paths.versionsJsonFile, versionsTxtFile: this.paths.versionsTxtFile },
      fetchImpl: this.fetchImpl,
      now: this.now(),
      refresh: options.refresh ?? false,
    });
    this.records = result.versions;
    this.loaded = true;
    if (result.error) {
      this.logger?.warn('versions.refreshFailed', { error: result.error.message });
    } else if (result.refreshed) {
      this.logger?.info('versions.refreshed', { titleIds: Object.keys(result.versions).length });
    }
    return this.records;
  }

  getRecords(): VersionRecords {
    return this.records;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  statusForTitleId(titleId: string, localVersions: number[]): VersionStatusDto {
    const input = versionStatusInput({ localVersions, titleId, versions: this.records });
    return { ...input, kind: deriveUpdateStatusKind(input.localVersion, input.latest) };
  }

  /**
   * Ports `ui.game_needs_update`: true when TitleDB knows a release newer than
   * everything on disk for that title ID.
   */
  hasNewerUpdate(titleId: string, localVersions: number[]): boolean {
    return this.statusForTitleId(titleId, localVersions).newer.length > 0;
  }

  newerVersionsFor(titleId: string, localVersions: number[]): VersionInfoDto[] {
    return this.statusForTitleId(titleId, localVersions).newer;
  }

  /**
   * Ports `ui.installed_status_text`: prefer recorded install history, otherwise
   * infer from a catalog path that already sits inside the install destination.
   */
  installedStatus(input: InstalledStatusInput): InstalledStatusDto | null {
    const job = latestCompletedInstall(this.db, input.gameId);
    if (job) {
      return {
        rawVersion: job.rawVersion,
        source: 'install-history',
        destinationLabel: job.destinationLabel,
        destinationFolder: job.destinationFolder,
        completedAt: job.completedAt,
      };
    }
    if (!input.baseFilePath || !input.installFolder) return null;
    if (!isPathInsideFolder(input.baseFilePath, input.installFolder)) return null;
    return {
      rawVersion: Math.max(0, ...input.localVersions),
      source: 'catalog-path',
      destinationLabel: input.installFolderLabel || null,
      destinationFolder: input.installFolder,
      completedAt: null,
    };
  }
}
