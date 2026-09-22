import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isCacheStale, loadVersionRecords, versionCacheIsStale } from '@main/versions/version-cache';
import type { VersionCachePaths } from '@main/versions/version-cache';
import {
  TITLEDB_CACHE_MAX_AGE_MS,
  TITLEDB_VERSIONS_TXT_URL,
  TITLEDB_VERSIONS_URL,
} from '@shared/constants';

import { TEMP_ROOT } from '../../../tests/setup/vitest.setup';

const JSON_BODY = JSON.stringify({
  '0100A3A0149EC000': { '0': '2020-09-17', '131072': '2021-01-01' },
});
const TXT_BODY = ['id|name|version', '0100A3A0149EC800|Hades Update|262144'].join('\n');

/** The merged database both remote bodies produce. */
const MERGED = {
  '0100A3A0149EC000': { '0': '2020-09-17', '131072': '2021-01-01', '262144': '' },
  '0100A3A0149EC800': { '262144': '' },
};

const CACHED_JSON = JSON.stringify({ '0100A3A0149EC000': { '65536': '2019-01-01' } });
const CACHED_TXT = ['id|name|version', '0100A3A0149EC800|Old Hades Update|131072'].join('\n');
const MERGED_CACHED = {
  '0100A3A0149EC000': { '65536': '2019-01-01', '131072': '' },
  '0100A3A0149EC800': { '131072': '' },
};

/** Isolated cache paths; the parent directories are created on demand. */
function casePaths(): VersionCachePaths {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  return {
    versionsJsonFile: join(dir, 'versions', 'versions.json'),
    versionsTxtFile: join(dir, 'versions', 'versions.txt'),
  };
}

interface FetchRecorder {
  impl: typeof fetch;
  urls: string[];
  inits: Array<RequestInit | undefined>;
}

function recordingFetch(handler: (url: string) => Promise<Response>): FetchRecorder {
  const urls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    inits.push(init);
    return handler(url);
  }) as unknown as typeof fetch;
  return { impl, urls, inits };
}

function remoteFetch(): FetchRecorder {
  const bodies: Record<string, string> = {
    [TITLEDB_VERSIONS_URL]: JSON_BODY,
    [TITLEDB_VERSIONS_TXT_URL]: TXT_BODY,
  };
  return recordingFetch(async (url) => {
    const body = bodies[url];
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
    return new Response(body, { status: 200 });
  });
}

function writeCacheFile(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
}

function ageCacheFile(file: string, ageMs: number): void {
  const stamp = new Date(Date.now() - ageMs);
  utimesSync(file, stamp, stamp);
}

function writeFreshCache(paths: VersionCachePaths, json: string, txt: string): void {
  writeCacheFile(paths.versionsJsonFile, json);
  writeCacheFile(paths.versionsTxtFile, txt);
}

describe('isCacheStale', () => {
  const now = 1_700_000_000_000;

  it('treats a missing cache file as stale', () => {
    expect(isCacheStale(null, now)).toBe(true);
  });

  it('accepts a cache file that is still within the max age', () => {
    expect(isCacheStale(now, now)).toBe(false);
    expect(isCacheStale(now - TITLEDB_CACHE_MAX_AGE_MS, now)).toBe(false);
  });

  it('expires a cache file older than the max age', () => {
    expect(isCacheStale(now - TITLEDB_CACHE_MAX_AGE_MS - 1, now)).toBe(true);
  });
});

describe('versionCacheIsStale', () => {
  const now = 1_700_000_000_000;

  it('is stale when either file is stale', () => {
    expect(versionCacheIsStale({ jsonMtimeMs: now, txtMtimeMs: null }, now)).toBe(true);
    expect(versionCacheIsStale({ jsonMtimeMs: null, txtMtimeMs: now }, now)).toBe(true);
    expect(versionCacheIsStale({ jsonMtimeMs: now, txtMtimeMs: now }, now)).toBe(false);
  });
});

describe('loadVersionRecords', () => {
  it('uses a fresh cache without fetching', async () => {
    const paths = casePaths();
    writeFreshCache(paths, CACHED_JSON, CACHED_TXT);
    const fetch = recordingFetch(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(fetch.urls).toEqual([]);
    expect(result.refreshed).toBe(false);
    expect(result.error).toBeNull();
    expect(result.versions).toEqual(MERGED_CACHED);
  });

  it('refreshes and rewrites a stale cache', async () => {
    const paths = casePaths();
    writeFreshCache(paths, CACHED_JSON, CACHED_TXT);
    ageCacheFile(paths.versionsJsonFile, TITLEDB_CACHE_MAX_AGE_MS * 2);
    ageCacheFile(paths.versionsTxtFile, TITLEDB_CACHE_MAX_AGE_MS * 2);
    const fetch = remoteFetch();

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(fetch.urls).toEqual([TITLEDB_VERSIONS_URL, TITLEDB_VERSIONS_TXT_URL]);
    expect(result.refreshed).toBe(true);
    expect(result.error).toBeNull();
    expect(result.versions).toEqual(MERGED);
    expect(readFileSync(paths.versionsJsonFile, 'utf8')).toBe(JSON_BODY);
    expect(readFileSync(paths.versionsTxtFile, 'utf8')).toBe(TXT_BODY);
  });

  it('forces a refresh when asked even though the cache is fresh', async () => {
    const paths = casePaths();
    writeFreshCache(paths, CACHED_JSON, CACHED_TXT);
    const fetch = remoteFetch();

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl, refresh: true });

    expect(fetch.urls).toEqual([TITLEDB_VERSIONS_URL, TITLEDB_VERSIONS_TXT_URL]);
    expect(result.refreshed).toBe(true);
    expect(result.versions).toEqual(MERGED);
  });

  it('honours an injected clock when deciding staleness', async () => {
    const paths = casePaths();
    writeFreshCache(paths, CACHED_JSON, CACHED_TXT);
    const fetch = remoteFetch();

    const result = await loadVersionRecords({
      paths,
      fetchImpl: fetch.impl,
      now: Date.now() + TITLEDB_CACHE_MAX_AGE_MS + 60_000,
    });

    expect(fetch.urls).toEqual([TITLEDB_VERSIONS_URL, TITLEDB_VERSIONS_TXT_URL]);
    expect(result.refreshed).toBe(true);
    expect(result.versions).toEqual(MERGED);
  });

  it('keeps the previous cache contents when the refresh fails', async () => {
    const paths = casePaths();
    writeFreshCache(paths, CACHED_JSON, CACHED_TXT);
    ageCacheFile(paths.versionsJsonFile, TITLEDB_CACHE_MAX_AGE_MS * 2);
    ageCacheFile(paths.versionsTxtFile, TITLEDB_CACHE_MAX_AGE_MS * 2);
    const fetch = recordingFetch(async () => {
      throw new Error('offline');
    });

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(fetch.urls).toEqual([TITLEDB_VERSIONS_URL, TITLEDB_VERSIONS_TXT_URL]);
    expect(result.refreshed).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
    expect(result.error?.message).toContain(TITLEDB_VERSIONS_URL);
    expect(result.versions).toEqual(MERGED_CACHED);
    expect(readFileSync(paths.versionsJsonFile, 'utf8')).toBe(CACHED_JSON);
    expect(readFileSync(paths.versionsTxtFile, 'utf8')).toBe(CACHED_TXT);
  });

  it('treats a non-2xx response as a refresh failure', async () => {
    const paths = casePaths();
    writeFreshCache(paths, CACHED_JSON, CACHED_TXT);
    ageCacheFile(paths.versionsJsonFile, TITLEDB_CACHE_MAX_AGE_MS * 2);
    ageCacheFile(paths.versionsTxtFile, TITLEDB_CACHE_MAX_AGE_MS * 2);
    const fetch = recordingFetch(async () => new Response('server exploded', { status: 500 }));

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(result.refreshed).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
    expect(result.error?.message).toContain('500');
    expect(readFileSync(paths.versionsJsonFile, 'utf8')).toBe(CACHED_JSON);
    expect(result.versions).toEqual(MERGED_CACHED);
  });

  it('populates a missing cache from both sources', async () => {
    const paths = casePaths();
    const fetch = remoteFetch();

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(result.refreshed).toBe(true);
    expect(result.error).toBeNull();
    expect(result.versions).toEqual(MERGED);
    expect(readFileSync(paths.versionsJsonFile, 'utf8')).toBe(JSON_BODY);
    expect(readFileSync(paths.versionsTxtFile, 'utf8')).toBe(TXT_BODY);
    expect(fetch.inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetch.inits[0]?.signal?.aborted).toBe(false);
  });

  it('contributes nothing when a source is missing and its fetch fails', async () => {
    const paths = casePaths();
    const fetch = recordingFetch(async () => {
      throw new Error('offline');
    });

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(result.versions).toEqual({});
    expect(result.refreshed).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
  });

  it('degrades an unparsable JSON cache to an empty contribution', async () => {
    const paths = casePaths();
    writeFreshCache(paths, '{not json', TXT_BODY);
    const fetch = recordingFetch(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await loadVersionRecords({ paths, fetchImpl: fetch.impl });

    expect(fetch.urls).toEqual([]);
    expect(result.error).toBeNull();
    expect(result.versions).toEqual({
      '0100A3A0149EC000': { '262144': '' },
      '0100A3A0149EC800': { '262144': '' },
    });
  });

  it('degrades unusable cache files to an empty database', async () => {
    const paths = casePaths();
    writeFreshCache(paths, '[]', 'id|name|version\nthis line has no pipes');

    const result = await loadVersionRecords({
      paths,
      fetchImpl: recordingFetch(async (url) => {
        throw new Error(`unexpected fetch: ${url}`);
      }).impl,
    });

    expect(result.versions).toEqual({});
    expect(result.error).toBeNull();
  });
});
