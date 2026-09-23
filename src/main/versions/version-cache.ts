import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  TITLEDB_CACHE_MAX_AGE_MS,
  TITLEDB_VERSIONS_TXT_URL,
  TITLEDB_VERSIONS_URL,
} from '../../shared/constants';
import type { AppErrorDto } from '../../shared/errors/codes';
import { mergeVersionRecords, parseVersionsTxt } from './version-records';
import type { VersionRecords } from './version-records';

/** TitleDB version cache with atomic, validated refreshes. */
export const VERSIONS_URL = TITLEDB_VERSIONS_URL;
export const VERSIONS_TXT_URL = TITLEDB_VERSIONS_TXT_URL;

const FETCH_TIMEOUT_MS = 20_000;

export interface VersionCachePaths {
  versionsJsonFile: string;
  versionsTxtFile: string;
}

export interface VersionCacheOptions {
  paths: VersionCachePaths;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: number;
  refresh?: boolean;
  knownPatchIds?: ReadonlySet<string> | null;
}

export interface VersionCacheResult {
  versions: VersionRecords;
  refreshed: boolean;
  error: AppErrorDto | null;
}

interface VersionCacheFileState {
  jsonMtimeMs: number | null;
  txtMtimeMs: number | null;
}

/** A missing file is stale; otherwise the cache is good for 24 hours. */
export function isCacheStale(fileMtimeMs: number | null, now: number = Date.now()): boolean {
  if (fileMtimeMs === null) return true;
  return now - fileMtimeMs > TITLEDB_CACHE_MAX_AGE_MS;
}

/** Either cache file being stale refreshes both sources (`versions_cache_is_stale`). */
export function versionCacheIsStale(files: VersionCacheFileState, now: number = Date.now()): boolean {
  return isCacheStale(files.jsonMtimeMs, now) || isCacheStale(files.txtMtimeMs, now);
}

function mtimeOrNull(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RefreshOutcome {
  refreshed: boolean;
  error: AppErrorDto | null;
  records: VersionRecords | null;
}

/** Downloads and validates `url`, then atomically replaces `file`. */
async function refreshCacheFile(
  file: string,
  url: string,
  fetchImpl: typeof fetch,
  parse: (text: string) => VersionRecords,
): Promise<RefreshOutcome> {
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    }
    const body = await response.text();
    const records = parse(body);
    const usableRecords = Object.values(records).some((versions) => Object.keys(versions).length > 0);
    if (!usableRecords) throw new Error('download did not contain any valid title records');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(partial, body, 'utf8');
    renameSync(partial, file);
    return { refreshed: true, error: null, records };
  } catch (error) {
    rmSync(partial, { force: true });
    return {
      refreshed: false,
      records: null,
      error: {
        code: 'NETWORK_ERROR',
        message: `Failed to refresh TitleDB version data from ${url}: ${errorMessage(error)}`,
        details: { url, file },
        retryable: true,
      },
    };
  }
}

/** Parses `versions.json`; anything unexpected degrades to no records. */
export function parseJsonVersions(text: string): VersionRecords {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const records: VersionRecords = {};
  for (const [titleId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const normalizedTitleId = titleId.trim().toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(normalizedTitleId)) continue;
    const titleRecords: Record<string, string> = {};
    for (const [version, releaseDate] of Object.entries(entry as Record<string, unknown>)) {
      if (!/^\d+$/.test(version)) continue;
      titleRecords[version] = typeof releaseDate === 'string' ? releaseDate : '';
    }
    if (Object.keys(titleRecords).length > 0) records[normalizedTitleId] = titleRecords;
  }
  return records;
}

function readCacheFile(file: string, parse: (text: string) => VersionRecords): VersionRecords {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  return parse(text);
}

interface SourceOutcome {
  records: VersionRecords;
  refreshed: boolean;
  error: AppErrorDto | null;
}

async function loadSource(options: {
  file: string;
  url: string;
  mustRefresh: boolean;
  fetchImpl: typeof fetch;
  parse: (text: string) => VersionRecords;
}): Promise<SourceOutcome> {
  const outcome = options.mustRefresh
    ? await refreshCacheFile(options.file, options.url, options.fetchImpl, options.parse)
    : { refreshed: false, error: null, records: null };
  return {
    records: outcome.records ?? readCacheFile(options.file, options.parse),
    refreshed: outcome.refreshed,
    error: outcome.error,
  };
}

/** Reads existing cache synchronously so startup can render immediately. */
export function readCachedVersionRecords(paths: VersionCachePaths, knownPatchIds?: ReadonlySet<string> | null): VersionRecords {
  return mergeVersionRecords(
    readCacheFile(paths.versionsJsonFile, parseJsonVersions),
    readCacheFile(paths.versionsTxtFile, (text) => parseVersionsTxt(text, knownPatchIds ?? undefined)),
  );
}

/**
 * Loads the merged version database, refreshing cache files that are stale (or
 * when `refresh` is set) and falling back to whatever is already on disk.
 */
export async function loadVersionRecords(options: VersionCacheOptions): Promise<VersionCacheResult> {
  const { paths, refresh = false, now = Date.now() } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const json = await loadSource({
    file: paths.versionsJsonFile,
    url: VERSIONS_URL,
    mustRefresh: refresh || isCacheStale(mtimeOrNull(paths.versionsJsonFile), now),
    fetchImpl,
    parse: parseJsonVersions,
  });
  const txt = await loadSource({
    file: paths.versionsTxtFile,
    url: VERSIONS_TXT_URL,
    mustRefresh: refresh || isCacheStale(mtimeOrNull(paths.versionsTxtFile), now),
    fetchImpl,
    parse: (text) => parseVersionsTxt(text, options.knownPatchIds ?? undefined),
  });

  return {
    versions: mergeVersionRecords(json.records, txt.records),
    refreshed: json.refreshed || txt.refreshed,
    error: json.error ?? txt.error,
  };
}
