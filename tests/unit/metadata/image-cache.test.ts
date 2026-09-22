import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { TEMP_ROOT } from '../../setup/vitest.setup';
import { ImageCache, imageCacheFileName } from '../../../src/main/metadata/image-cache';

const COVER_URL = 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg';
const SHOT_URL = 'https://images.igdb.com/igdb/image/upload/t_1080p/sc1.png';

interface FetchStub {
  urls: string[];
  impl: typeof fetch;
}

function createFetchStub(
  handler: (url: string) => Response | Promise<Response> = () => new Response(''),
): FetchStub {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return { urls, impl };
}

function imageResponse(type = 'image/jpeg'): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': type } });
}

describe('imageCacheFileName', () => {
  it('is deterministic for the same URL', () => {
    expect(imageCacheFileName(COVER_URL)).toBe(imageCacheFileName(COVER_URL));
  });

  it('separates different URLs', () => {
    expect(imageCacheFileName(COVER_URL)).not.toBe(imageCacheFileName(SHOT_URL));
    expect(imageCacheFileName(`${COVER_URL}?v=2`)).not.toBe(imageCacheFileName(COVER_URL));
  });

  it('keeps a safe extension and defaults to .jpg', () => {
    expect(imageCacheFileName(SHOT_URL)).toMatch(/^[0-9a-f]{40}\.png$/);
    expect(imageCacheFileName('https://images.igdb.com/igdb/image/upload/t_cover_big_2x')).toMatch(
      /^[0-9a-f]{40}\.jpg$/,
    );
    expect(imageCacheFileName('https://example.com/image.bmp')).toMatch(/^[0-9a-f]{40}\.jpg$/);
    expect(imageCacheFileName(`${COVER_URL}?size=2`)).toMatch(/^[0-9a-f]{40}\.jpg$/);
  });

  it('handles protocol-relative URLs', () => {
    expect(imageCacheFileName('//images.igdb.com/igdb/image/upload/t_thumb/co1.jpg')).toMatch(
      /^[0-9a-f]{40}\.jpg$/,
    );
  });
});

describe('ImageCache', () => {
  let dir: string;
  let coversDir: string;
  let screenshotsDir: string;
  let stub: FetchStub;

  beforeEach(() => {
    dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
    coversDir = join(dir, 'covers');
    screenshotsDir = join(dir, 'screenshots');
    stub = createFetchStub();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function cache(fetchImpl: typeof fetch = stub.impl): ImageCache {
    return new ImageCache({ coversDir, screenshotsDir, fetchImpl });
  }

  it('downloads a cover and returns its absolute path', async () => {
    stub = createFetchStub(() => imageResponse());
    const path = await cache().cacheCover(7, COVER_URL);

    expect(path).toBe(join(coversDir, imageCacheFileName(COVER_URL)));
    expect(isAbsolute(path as string)).toBe(true);
    expect(existsSync(path as string)).toBe(true);
    expect(readFileSync(path as string)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(stub.urls).toEqual([COVER_URL]);
  });

  it('stores screenshots beside covers and never refetches a cached URL', async () => {
    stub = createFetchStub(() => imageResponse('image/png'));
    const subject = cache();
    const first = await subject.cacheScreenshot(7, SHOT_URL);
    const second = await subject.cacheScreenshot(7, SHOT_URL);

    expect(first).toBe(join(screenshotsDir, imageCacheFileName(SHOT_URL)));
    expect(second).toBe(first);
    expect(stub.urls).toHaveLength(1);
    expect(readdirSync(screenshotsDir)).toEqual([imageCacheFileName(SHOT_URL)]);
  });

  it('returns null and writes nothing on a non-OK response', async () => {
    stub = createFetchStub(() => new Response('missing', { status: 404 }));

    await expect(cache().cacheCover(7, COVER_URL)).resolves.toBeNull();
    expect(existsSync(coversDir)).toBe(false);
  });

  it('returns null when the download rejects', async () => {
    stub = createFetchStub(() => {
      throw new Error('socket hang up');
    });

    await expect(cache().cacheCover(7, COVER_URL)).resolves.toBeNull();
    expect(existsSync(coversDir)).toBe(false);
  });

  it('returns null for URLs the cache never downloads', async () => {
    const subject = cache();

    await expect(subject.cacheCover(7, 'file:///etc/passwd')).resolves.toBeNull();
    await expect(subject.cacheCover(7, 'ftp://images.igdb.com/co1.jpg')).resolves.toBeNull();
    await expect(subject.cacheCover(7, 'not a url')).resolves.toBeNull();
    await expect(subject.cacheCover(7, '')).resolves.toBeNull();
    expect(stub.urls).toEqual([]);
  });

  it('upgrades plain http IGDB URLs to https', async () => {
    stub = createFetchStub(() => imageResponse());
    const path = await cache().cacheCover(7, 'http://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg');

    expect(stub.urls).toEqual(['https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg']);
    expect(path).toBe(
      join(coversDir, imageCacheFileName('http://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg')),
    );
  });

  it('leaves no partial file behind when the body is unusable', async () => {
    stub = createFetchStub(() => new Response(new Uint8Array([]), { status: 200 }));

    await expect(cache().cacheCover(7, COVER_URL)).resolves.toBeNull();
    expect(existsSync(coversDir) ? readdirSync(coversDir) : []).toEqual([]);
  });
});
