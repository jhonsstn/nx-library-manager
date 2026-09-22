import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  TITLEDB_CACHE_MAX_AGE_MS,
  TITLEDB_VERSIONS_TXT_URL,
  TITLEDB_VERSIONS_URL,
} from '../../shared/constants';
import type { AppErrorDto } from '../../shared/errors/codes';
import { mergeVersionRecords, parseVersionsTxt } from './version-records';
import type { VersionRecords } from './version-records';

/**
 * TitleDB version cache. Ports `load_versions` / `_load_json_versions` /
 * `_load_txt_versions` from `switch_catalog/versions.py`: the cache survives
 * network failures, and a failing refresh only means the previous snapshot is
 * reused.
 */
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
}

/** Downloads `url` into `file`; failures are reported, never thrown. */
async function refreshCacheFile(
  file: string,
  url: string,
  fetchImpl: typeof fetch,
): Promise<RefreshOutcome> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    }
    const body = await response.text();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf8');
    return { refreshed: true, error: null };
  } catch (error) {
    return {
      refreshed: false,
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
function parseJsonVersions(text: string): VersionRecords {
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
    const titleRecords: Record<string, string> = {};
    for (const [version, releaseDate] of Object.entries(entry as Record<string, unknown>)) {
      titleRecords[version] = typeof releaseDate === 'string' ? releaseDate : '';
    }
    records[titleId] = titleRecords;
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
    ? await refreshCacheFile(options.file, options.url, options.fetchImpl)
    : { refreshed: false, error: null };
  return {
    records: readCacheFile(options.file, options.parse),
    refreshed: outcome.refreshed,
    error: outcome.error,
  };
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
    parse: parseVersionsTxt,
  });

  return {
    versions: mergeVersionRecords(json.records, txt.records),
    refreshed: json.refreshed || txt.refreshed,
    error: json.error ?? txt.error,
  };
}
