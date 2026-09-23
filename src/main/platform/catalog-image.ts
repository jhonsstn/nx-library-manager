import { basename, resolve, sep } from 'node:path';
import { CATALOG_IMAGE_SCHEME } from '../../shared/constants';

export type CatalogImageKind = 'covers' | 'screenshots';

/**
 * Cached artwork is served through a dedicated scheme so the renderer never gets
 * a filesystem capability (`docs/backend/07-metadata-service.md`).
 */
export function catalogImageUrl(kind: CatalogImageKind, fileName: string): string {
  return `${CATALOG_IMAGE_SCHEME}://${kind}/${encodeURIComponent(fileName)}`;
}

/**
 * Prefers the locally cached copy and falls back to the origin URL, which keeps
 * the library usable before (or without) a cache download.
 */
export function displayImageUrl(
  localPath: string | null | undefined,
  originUrl: string | null | undefined,
  kind: CatalogImageKind,
): string | null {
  if (localPath) return catalogImageUrl(kind, basename(localPath));
  return originUrl ? originUrl : null;
}

export interface CatalogImageRoots {
  coversCacheDir: string;
  screenshotsCacheDir: string;
}

/**
 * Resolves a `catalog-image://` request to a file inside the cache. Traversal,
 * separators and unknown hosts are rejected, so the protocol handler can only
 * ever serve cached artwork.
 */
export function resolveCatalogImageRequest(requestUrl: string, roots: CatalogImageRoots): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${CATALOG_IMAGE_SCHEME}:`) return null;
  const kind = parsed.hostname === 'covers' ? 'covers' : parsed.hostname === 'screenshots' ? 'screenshots' : null;
  if (!kind) return null;

  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;

  const root = resolve(kind === 'covers' ? roots.coversCacheDir : roots.screenshotsCacheDir);
  const target = resolve(root, name);
  if (target !== resolve(root, basename(name))) return null;
  if (!target.startsWith(`${root}${sep}`)) return null;
  return target;
}
