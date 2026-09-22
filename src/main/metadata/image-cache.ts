import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { Logger } from '../lifecycle/logger';

/**
 * Local cache for IGDB cover/screenshot images.
 *
 * The renderer displays these through the `catalog-image://` protocol, so the
 * database stores absolute cache paths and remote loads only happen on a miss.
 * Downloads are best effort: a failure degrades the UI to the origin URL, it
 * never fails a metadata refresh.
 */

/** Image extensions a cached file may carry; anything else falls back to `.jpg`. */
const ALLOWED_IMAGE_EXTENSIONS: Record<string, true> = {
  '.jpg': true,
  '.jpeg': true,
  '.png': true,
  '.webp': true,
  '.gif': true,
};

const DEFAULT_IMAGE_EXTENSION = '.jpg';
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Deterministic cache name for a remote image: `<sha1 of url><extension>`.
 * Hashing keeps distinct URLs distinct while staying filesystem-safe and
 * bounded, which raw IGDB paths (query strings, long folders) are not.
 */
export function imageCacheFileName(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex');
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Protocol-relative URLs (`//images.igdb.com/...`) have no base to parse.
    path = url.split(/[?#]/)[0];
  }
  const extension = extname(path).toLowerCase();
  return `${hash}${ALLOWED_IMAGE_EXTENSIONS[extension] ? extension : DEFAULT_IMAGE_EXTENSION}`;
}

export interface ImageCacheOptions {
  coversDir: string;
  screenshotsDir: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class ImageCache {
  private readonly coversDir: string;
  private readonly screenshotsDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: ImageCacheOptions) {
    this.coversDir = options.coversDir;
    this.screenshotsDir = options.screenshotsDir;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  /** Absolute cached cover path, or null when nothing usable could be stored. */
  cacheCover(gameId: number, url: string): Promise<string | null> {
    return this.cache(this.coversDir, gameId, url);
  }

  /** Absolute cached screenshot path, or null when nothing usable could be stored. */
  cacheScreenshot(gameId: number, url: string): Promise<string | null> {
    return this.cache(this.screenshotsDir, gameId, url);
  }

  private async cache(dir: string, gameId: number, url: string): Promise<string | null> {
    if (!url) return null;
    const target = resolve(join(dir, imageCacheFileName(url)));
    if (existsSync(target)) return target;

    const remote = downloadUrl(url);
    if (!remote) {
      this.logger?.warn('metadata.image.unsupportedScheme', { gameId, file: target });
      return null;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(remote, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      this.logger?.warn('metadata.image.downloadFailed', {
        gameId,
        file: target,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!response.ok) {
      this.logger?.warn('metadata.image.downloadFailed', { gameId, file: target, status: response.status });
      return null;
    }

    const temporary = `${target}.${randomUUID()}.part`;
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) return null;
      mkdirSync(dir, { recursive: true });
      writeFileSync(temporary, bytes);
      // Rename last: a partial download can never become the cached image.
      renameSync(temporary, target);
      return target;
    } catch (error) {
      this.logger?.warn('metadata.image.writeFailed', {
        gameId,
        file: target,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
}

/**
 * Only absolute `http(s)` URLs are fetched; IGDB serves through `http://` on a
 * shared host, which is upgraded so cached bytes always arrive encrypted.
 */
function downloadUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol !== 'http:') return null;
  if (parsed.hostname === 'images.igdb.com') {
    parsed.protocol = 'https:';
    return parsed.toString();
  }
  return parsed.toString();
}
