import { net, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATALOG_IMAGE_SCHEME } from '../../shared/constants';
import { resolveCatalogImageRequest, type CatalogImageRoots } from '../platform/catalog-image';

/** Renderer bundle scheme; keeps a real origin so CSP `'self'` works. */
export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://bundle`;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Must run before `app.ready`. Both schemes are privileged and secure so the
 * renderer can keep a strict CSP without `file://` exceptions.
 */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
    {
      scheme: CATALOG_IMAGE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Serves the built renderer from `rendererDir`, rejecting path traversal. */
export function registerAppProtocol(rendererDir: string): void {
  const root = resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'bundle') return new Response('Not found', { status: 404 });

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = resolve(root, normalize(relative));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const body = await readFile(target);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream' },
      });
    } catch {
      // Unknown route: fall back to the SPA entry point.
      try {
        const fallback = await readFile(join(root, 'index.html'));
        return new Response(fallback, { status: 200, headers: { 'content-type': CONTENT_TYPES['.html'] } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
  });
}

/** Serves cached cover/screenshot files; only the cache directories are reachable. */
export function registerCatalogImageProtocol(roots: CatalogImageRoots): void {
  protocol.handle(CATALOG_IMAGE_SCHEME, async (request) => {
    const target = resolveCatalogImageRequest(request.url, roots);
    if (!target) return new Response('Forbidden', { status: 403 });
    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
