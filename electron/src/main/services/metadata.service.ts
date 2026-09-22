import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { AppPaths } from '../platform/paths';
import type { BulkMetadataResultDto, MetadataBulkProgressDto, MetadataCandidateDto } from '../../shared/types/domain';
import { MIN_AUTO_MATCH_CONFIDENCE } from '../../shared/constants';
import { appError } from '../../shared/errors/app-error';
import {
  applyMetadataResult,
  getGame,
  listGamesForBulkRefresh,
  listGamesNeedingMetadata,
  setCoverImagePath,
  setNeedsReview,
} from '../repositories/games.repository';
import {
  listScreenshotsMissingCache,
  replaceScreenshots,
  setScreenshotLocalPath,
} from '../repositories/screenshots.repository';
import type { ImageCache } from '../metadata/image-cache';
import { IgdbClient } from '../metadata/igdb.client';

/** Bulk refresh concurrency and progress cadence (spec 07: rate limits). */
const BULK_CONCURRENCY = 3;
const PROGRESS_INTERVAL_MS = 250;
/** Screenshots cached per apply; IGDB returns plenty and the grid shows few. */
const MAX_CACHED_SCREENSHOTS = 8;

export interface MetadataServiceOptions {
  db: AppDatabase;
  paths: AppPaths;
  credentials: () => { clientId: string; clientSecret: string };
  imageCache: ImageCache;
  logger?: Logger;
  /** Test seam; the IGDB client falls back to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface BulkRefreshOptions {
  force?: boolean;
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: MetadataBulkProgressDto) => void;
}

export interface ApplyCandidateOptions {
  lock?: boolean;
  needsReview?: boolean;
}

/**
 * Ports the metadata workflow of `switch_catalog/metadata.py` and `ui.py`:
 * search candidates for a game, apply one, and refresh the library in bulk.
 *
 * Failures are typed (`AppError`) so the IPC layer can show a message, and image
 * caching never fails a metadata apply — a missing cover degrades to the origin
 * URL instead.
 */
export class MetadataService {
  private readonly db: AppDatabase;
  /** Resolved app roots this service was built against (cache dirs, database file). */
  readonly paths: AppPaths;
  private readonly credentials: () => { clientId: string; clientSecret: string };
  private readonly imageCache: ImageCache;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private client: IgdbClient | null = null;
  private clientKey = '';

  constructor(options: MetadataServiceOptions) {
    this.db = options.db;
    this.paths = options.paths;
    this.credentials = options.credentials;
    this.imageCache = options.imageCache;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl;
  }

  /** Both IGDB credentials stored; searching without them would just 401. */
  isConfigured(): boolean {
    const { clientId, clientSecret } = this.credentials();
    return Boolean(clientId.trim() && clientSecret.trim());
  }

  /**
   * Candidate list for a game. Without an explicit query the cleaned title is
   * used, which is what rescan reconciliation matched on.
   */
  async searchCandidates(gameId: number, query?: string): Promise<MetadataCandidateDto[]> {
    const game = getGame(this.db, gameId);
    if (!game) throw appError('NOT_FOUND', `No game with id ${gameId}.`);
    if (!this.isConfigured()) return [];
    const title = query ?? (game.cleanedTitle || game.displayTitle);
    return this.igdb().search(title);
  }

  /**
   * Ports the apply half of `metadata.apply_metadata_result` plus the image
   * cache step: the row and screenshot set are written first, then remote
   * images are pulled into the local cache.
   */
  async applyCandidate(gameId: number, candidate: MetadataCandidateDto, options: ApplyCandidateOptions = {}): Promise<void> {
    applyMetadataResult(this.db, gameId, candidate, {
      lock: options.lock ?? false,
      needsReview: options.needsReview ?? false,
    });
    replaceScreenshots(this.db, gameId, candidate.screenshots);

    if (candidate.coverImageUrl) {
      const coverPath = await this.cacheImage('cover', gameId, candidate.coverImageUrl);
      if (coverPath) setCoverImagePath(this.db, gameId, coverPath);
    }
    for (const screenshot of listScreenshotsMissingCache(this.db, gameId, MAX_CACHED_SCREENSHOTS)) {
      const localPath = await this.cacheImage('screenshot', gameId, screenshot.image_url);
      if (localPath) setScreenshotLocalPath(this.db, screenshot.id, localPath);
    }
  }

  /**
   * Ports `fetch_and_apply_metadata` for the manual refresh button: locked games
   * are left alone, low-confidence matches are flagged for review instead of
   * applied, and provider failures propagate so the user sees why.
   */
  async refreshGame(gameId: number): Promise<boolean> {
    const game = getGame(this.db, gameId);
    if (!game) throw appError('NOT_FOUND', `No game with id ${gameId}.`);
    if (game.metadataLocked) return false;

    const candidates = await this.searchCandidates(gameId);
    if (candidates.length === 0) {
      setNeedsReview(this.db, gameId, true);
      this.logger?.debug('metadata.refreshNoMatch', { gameId });
      return false;
    }
    const best = candidates.reduce((winner, candidate) =>
      candidate.confidence > winner.confidence ? candidate : winner,
    );
    if (best.confidence < MIN_AUTO_MATCH_CONFIDENCE) {
      setNeedsReview(this.db, gameId, true);
      this.logger?.debug('metadata.refreshLowConfidence', { gameId, confidence: best.confidence });
      return false;
    }
    await this.applyCandidate(gameId, best, { lock: false, needsReview: false });
    return true;
  }

  /** Ports `fetch_missing_metadata`: bounded concurrency, progress, cancellation. */
  async bulkRefresh(options: BulkRefreshOptions = {}): Promise<BulkMetadataResultDto> {
    const force = options.force ?? false;
    const games = force
      ? listGamesNeedingMetadata(this.db, { force: true, limit: options.limit })
      : listGamesForBulkRefresh(this.db, 'igdb', options.limit);

    const jobId = randomUUID();
    let processed = 0;
    let updated = 0;
    let noMatch = 0;
    let failed = 0;
    let cancelled = false;
    let currentTitle = '';
    let lastEmit = 0;

    const emit = (done: boolean): void => {
      if (!options.onProgress) return;
      const now = Date.now();
      if (!done && now - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastEmit = now;
      options.onProgress({
        jobId,
        total: games.length,
        processed,
        updated,
        noMatch,
        failed,
        currentTitle,
        done,
        cancelled,
      });
    };

    emit(false);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, games.length) }, async () => {
      while (cursor < games.length) {
        if (options.signal?.aborted) {
          cancelled = true;
          return;
        }
        const game = games[cursor];
        cursor += 1;
        currentTitle = game.displayTitle;
        try {
          if (await this.refreshGame(game.id)) updated += 1;
          else noMatch += 1;
        } catch (error) {
          failed += 1;
          setNeedsReview(this.db, game.id, true);
          this.logger?.warn('metadata.bulkRefreshItemFailed', {
            gameId: game.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        processed += 1;
        emit(false);
      }
    });
    await Promise.all(workers);
    emit(true);

    this.logger?.info('metadata.bulkRefreshDone', { jobId, total: games.length, processed, updated, noMatch, failed });
    return { attempted: processed, updated, noMatch, failed };
  }

  private async cacheImage(
    kind: 'cover' | 'screenshot',
    gameId: number,
    url: string,
  ): Promise<string | null> {
    try {
      return kind === 'cover'
        ? await this.imageCache.cacheCover(gameId, url)
        : await this.imageCache.cacheScreenshot(gameId, url);
    } catch (error) {
      // Caching is an optimization; the metadata apply already succeeded.
      this.logger?.warn('metadata.imageCacheFailed', {
        gameId,
        kind,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** One client per credential set, so the OAuth token is fetched once. */
  private igdb(): IgdbClient {
    const { clientId, clientSecret } = this.credentials();
    const key = `${clientId.trim()}\u0000${clientSecret.trim()}`;
    if (!this.client || this.clientKey !== key) {
      this.client = new IgdbClient({
        db: this.db,
        clientId,
        clientSecret,
        fetchImpl: this.fetchImpl,
        logger: this.logger?.child('igdb'),
      });
      this.clientKey = key;
    }
    return this.client;
  }
}
