import type { AppDatabase } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { MetadataCandidateDto } from '../../shared/types/domain';
import { appError } from '../../shared/errors/app-error';
import {
  IGDB_API_URL,
  IGDB_SEARCH_CACHE_VERSION,
  IGDB_SWITCH_PLATFORM_ID,
  IGDB_TOKEN_URL,
  MIN_AUTO_MATCH_CONFIDENCE,
} from '../../shared/constants';
import { getCacheEntry, setCacheEntry } from '../repositories/metadata-cache.repository';
import { escapeIgdbQuery, metadataSearchQueries, titleSimilarity } from './metadata-search';

export { IGDB_SEARCH_CACHE_VERSION, MIN_AUTO_MATCH_CONFIDENCE };

const PROVIDER = 'igdb';
const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_LIMIT = 10;

/** Fields requested from IGDB. */
const SEARCH_FIELDS =
  'fields name,summary,first_release_date,' +
  'cover.url,screenshots.url,genres.name,videos.video_id,' +
  'involved_companies.developer,involved_companies.publisher,' +
  'involved_companies.company.name; ';

export interface IgdbClientOptions {
  db: AppDatabase;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * Ports `metadata.IgdbProvider`: Twitch client-credentials auth, SQLite-cached
 * search responses, and candidate mapping. Auth/search failures surface as
 * `AppError`s so callers can show a message instead of a raw fetch error.
 */
export class IgdbClient {
  private readonly db: AppDatabase;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  /** In-flight token request, so parallel searches share one auth round trip. */
  private pendingToken: Promise<string> | null = null;

  constructor(options: IgdbClientOptions) {
    this.db = options.db;
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /**
   * Ports `IgdbProvider.search`: cheap queries first, and the Switch platform
   * restriction is only dropped when that pass produced nothing at all.
   */
  async search(title: string): Promise<MetadataCandidateDto[]> {
    const queries = metadataSearchQueries(title);
    if (queries.length === 0 || !this.configured) return [];
    const seen = new Set<string>();
    const results: MetadataCandidateDto[] = [];
    for (const query of queries) {
      results.push(...(await this.searchOne(query, title, true, seen)));
    }
    if (results.length === 0) {
      for (const query of queries) {
        results.push(...(await this.searchOne(query, title, false, seen)));
      }
    }
    return results.sort((left, right) => right.confidence - left.confidence);
  }

  /** Ports `IgdbProvider._search_one`, including the versioned cache key. */
  private async searchOne(
    query: string,
    originalTitle: string,
    restrictToSwitch: boolean,
    seen: Set<string>,
  ): Promise<MetadataCandidateDto[]> {
    const cacheKey = `search:${IGDB_SEARCH_CACHE_VERSION}:${restrictToSwitch ? 'switch' : 'all'}:${query}`;
    let payload = getCacheEntry(this.db, PROVIDER, cacheKey) as { results?: unknown } | null;
    if (payload === null) {
      const where = restrictToSwitch ? `where platforms = (${IGDB_SWITCH_PLATFORM_ID}); ` : '';
      const body = `search "${escapeIgdbQuery(query)}"; ${SEARCH_FIELDS}${where}limit ${SEARCH_LIMIT};`;
      const response = await this.post(IGDB_API_URL, {
        method: 'POST',
        headers: await this.headers(),
        body,
      });
      payload = { results: await this.readJson(response, cacheKey) };
      setCacheEntry(this.db, PROVIDER, cacheKey, payload);
    }
    const results: MetadataCandidateDto[] = [];
    for (const item of asArray(payload.results)) {
      const providerId = String(asRecord(item).id ?? '');
      if (seen.has(providerId)) continue;
      seen.add(providerId);
      results.push(this.fromRaw(asRecord(item), originalTitle));
    }
    return results;
  }

  /** Ports `IgdbProvider._from_raw`. */
  private fromRaw(item: Record<string, unknown>, query: string): MetadataCandidateDto {
    const developers: string[] = [];
    const publishers: string[] = [];
    for (const entry of asArray(item.involved_companies)) {
      const company = asRecord(entry);
      const name = asString(asRecord(company.company).name);
      if (company.developer && name) developers.push(name);
      if (company.publisher && name) publishers.push(name);
    }
    const screenshots: string[] = [];
    for (const entry of asArray(item.screenshots)) {
      const url = asString(asRecord(entry).url);
      if (url) screenshots.push(igdbImageUrl(url, 't_1080p'));
    }
    const rawReleaseDate = item.first_release_date;
    const releaseDate = rawReleaseDate
      ? new Date(Math.trunc(Number(rawReleaseDate)) * 1000).toISOString().slice(0, 10)
      : '';
    const name = asString(item.name) || query;
    const genres: string[] = [];
    for (const entry of asArray(item.genres)) {
      const genre = asString(asRecord(entry).name);
      if (genre) genres.push(genre);
    }
    return {
      provider: PROVIDER,
      providerId: String(item.id ?? ''),
      title: name,
      description: asString(item.summary),
      releaseDate,
      developer: developers.join(', '),
      publisher: publishers.join(', '),
      genres,
      coverImageUrl: igdbImageUrl(asString(asRecord(item.cover).url), 't_cover_big_2x'),
      trailerUrl: igdbTrailerUrl(asArray(item.videos)),
      screenshots,
      confidence: titleSimilarity(name, query),
    };
  }

  /** Ports `IgdbProvider._headers`; the token is cached, never per-game. */
  private async headers(): Promise<Record<string, string>> {
    return {
      'Client-ID': this.clientId,
      Authorization: `Bearer ${await this.accessToken()}`,
      Accept: 'application/json',
    };
  }

  /** Twitch client-credentials flow, cached under `token:<clientId>`. */
  private async accessToken(): Promise<string> {
    const cacheKey = `token:${this.clientId}`;
    const cached = getCacheEntry(this.db, PROVIDER, cacheKey) as { access_token?: unknown } | null;
    const cachedToken = cached ? asString(cached.access_token) : '';
    if (cachedToken) return cachedToken;
    if (this.pendingToken) return this.pendingToken;

    const request = (async (): Promise<string> => {
      const response = await this.post(
        IGDB_TOKEN_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'client_credentials',
          }).toString(),
        },
        { authEndpoint: true },
      );
      const payload = await this.readJson(response, 'token');
      const token = asString(asRecord(payload).access_token);
      if (!token) {
        // Never retried: an unusable token means the stored secret is wrong.
        throw appError('METADATA_AUTH_ERROR', 'IGDB did not return an access token.', { retryable: false });
      }
      setCacheEntry(this.db, PROVIDER, cacheKey, payload);
      return token;
    })();
    this.pendingToken = request;
    try {
      return await request;
    } finally {
      this.pendingToken = null;
    }
  }

  /** Single transport entry point: timeouts, status codes and JSON all map to AppErrors. */
  private async post(
    url: string,
    init: RequestInit,
    options: { authEndpoint?: boolean } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      throw appError('NETWORK_ERROR', 'Could not reach IGDB.', { retryable: true, cause });
    }
    if (response.ok) return response;
    const status = response.status;
    if (status === 401 || status === 403 || (options.authEndpoint && status === 400)) {
      throw appError('METADATA_AUTH_ERROR', 'IGDB rejected the stored credentials.', {
        retryable: false,
        details: { status },
      });
    }
    if (status === 429) {
      throw appError('METADATA_RATE_LIMITED', 'IGDB rate limit reached; try again shortly.', {
        retryable: true,
        details: { status },
      });
    }
    throw appError('NETWORK_ERROR', `IGDB request failed with status ${status}.`, {
      retryable: true,
      details: { status },
    });
  }

  private async readJson(response: Response, key: string): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch (cause) {
      this.logger?.warn('igdb.invalidJson', { key });
      throw appError('NETWORK_ERROR', 'IGDB returned an unreadable response.', { retryable: true, cause });
    }
  }
}

/** Ports `_igdb_image_url`: swap the thumbnail size and force https. */
function igdbImageUrl(url: string, size: string): string {
  if (!url) return '';
  const sized = url.split('t_thumb').join(size);
  if (sized.startsWith('//')) return `https:${sized}`;
  if (sized.startsWith('http://')) return `https://${sized.slice('http://'.length)}`;
  return sized;
}

/** Ports `_igdb_trailer_url`: the first video id wins. */
function igdbTrailerUrl(videos: unknown[]): string {
  for (const entry of videos) {
    const videoId = asString(asRecord(entry).video_id).trim();
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
