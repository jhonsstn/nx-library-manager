/**
 * DBI-compatible catalog HTTP server.
 *
 * Ports `CatalogHttpServer` from `switch_catalog/http_server.py`: Apache-style
 * directory listing, Awoo/DBI URL lists, downloads by catalog id or by file
 * name, HTTP Range support, and optional HTTP Basic authentication.
 *
 * A request only ever resolves to a row already indexed in the catalog: the
 * URL path is matched against `CatalogFileSource` and the on-disk path comes
 * from the record, never from the request.
 */

import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { appError } from '../../shared/errors/app-error';
import type { CatalogFileRecord, CatalogFileSource } from './catalog-file-source';
import { directoryListingHtml, quotePathComponent, unquotePathComponent, urlListText } from './directory-listing';
import { contentDisposition, parseByteRange } from './range';

const DOWNLOAD_PATH_PATTERN = /^\/dl\/(game|update)\/(\d+)(?:\/.*)?$/;
/** Bounded read chunk, mirroring the legacy `_CHUNK = 256 * 1024`. */
const CHUNK_SIZE = 256 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'text/xml',
  '.zip': 'application/zip',
  '.nsp': 'application/octet-stream',
  '.nsz': 'application/octet-stream',
  '.xci': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

type RouteCategory =
  | 'listing'
  | 'url-list'
  | 'download-id'
  | 'download-name'
  | 'not-found'
  | 'unauthorized'
  | 'method-not-allowed';

export interface DbiHttpServerOptions {
  /** Catalog lookup seam; only indexed rows can be served. */
  source: CatalogFileSource;
  /** Bind address; defaults to all interfaces to preserve LAN behaviour. */
  host?: string;
  /** Port to bind; `0` selects an ephemeral port. */
  port: number;
  username?: string;
  /** Empty/absent password disables authentication. */
  password?: string;
}

interface ResponseTracker {
  category: RouteCategory;
  bytesSent: number;
}

export class DbiHttpServer {
  private readonly source: CatalogFileSource;
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly username: string;
  private readonly password: string;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(options: DbiHttpServerOptions) {
    this.source = options.source;
    this.host = options.host ?? '0.0.0.0';
    this.configuredPort = options.port;
    // The Qt build trimmed the configured username before comparing credentials.
    this.username = (options.username ?? '').trim();
    this.password = options.password ?? '';
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Bound port while running; the configured port otherwise (`0` stays `0`). */
  get port(): number {
    const server = this.server;
    if (!server) return this.configuredPort;
    const address = server.address();
    return address && typeof address === 'object' ? address.port : this.configuredPort;
  }

  async start(): Promise<{ port: number }> {
    if (this.server) return { port: this.port };
    const server = createServer((request, response) => {
      this.handleRequest(request, response);
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('error', (error: Error) => {
      this.log(`server-error ${error.message}`);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(this.configuredPort, this.host);
      });
    } catch (error) {
      this.server = null;
      this.sockets.clear();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        throw appError('HTTP_PORT_IN_USE', `Port ${this.configuredPort} is already in use.`, { cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw appError('HTTP_SERVER_ERROR', `HTTP server failed to start: ${message}`, { cause: error });
    }
    return { port: this.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Drop keep-alive and in-flight sockets so shutdown completes promptly.
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? 'GET';
    const headOnly = method === 'HEAD';
    const rawRange = request.headers.range;
    const rangeHeader = rawRange && rawRange.length > 0 ? rawRange : undefined;
    const tracker: ResponseTracker = { category: 'not-found', bytesSent: 0 };
    let logged = false;
    const writeLog = (): void => {
      if (logged) return;
      logged = true;
      this.logRequest(method, tracker, response.statusCode, rawRange);
    };
    response.on('finish', writeLog);
    response.on('close', writeLog);

    if (method !== 'GET' && method !== 'HEAD') {
      tracker.category = 'method-not-allowed';
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
      response.end();
      return;
    }
    if (!this.isAuthorized(request)) {
      tracker.category = 'unauthorized';
      response.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Switch Catalog"',
        'Content-Length': '0',
      });
      response.end();
      return;
    }

    const path = requestPath(request);
    if (path === '/' || path === '/dir') {
      tracker.category = 'listing';
      const body = Buffer.from(directoryListingHtml(this.source.listFiles()), 'utf8');
      this.sendPayload(response, body, 'text/html; charset=utf-8', headOnly, rangeHeader, tracker);
      return;
    }
    if (path === '/list.txt' || path === '/awoo.txt') {
      tracker.category = 'url-list';
      const body = Buffer.from(urlListText(this.source.listFiles(), this.requestBaseUrl(request)), 'utf8');
      this.sendPayload(response, body, 'text/plain; charset=utf-8', headOnly, rangeHeader, tracker);
      return;
    }
    const download = DOWNLOAD_PATH_PATTERN.exec(path);
    if (download) {
      tracker.category = 'download-id';
      const kind = download[1] === 'update' ? 'update' : 'game';
      const record = this.source.findById(kind, Number(download[2]));
      if (!record) {
        this.sendNotFound(response, headOnly);
        return;
      }
      void this.sendFile(record, response, headOnly, rangeHeader, tracker);
      return;
    }
    if (path.startsWith('/dir/')) {
      tracker.category = 'download-name';
      const name = unquotePathComponent(path.slice('/dir/'.length));
      if (!name || name.includes('/') || name.includes('\\')) {
        this.sendNotFound(response, headOnly);
        return;
      }
      const record = this.source.findByName(name);
      if (!record) {
        this.sendNotFound(response, headOnly);
        return;
      }
      void this.sendFile(record, response, headOnly, rangeHeader, tracker);
      return;
    }
    this.sendNotFound(response, headOnly);
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.password) return true;
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = decodeBasicCredentials(header.slice('Basic '.length));
    if (decoded === null) return false;
    return constantTimeEquals(decoded, `${this.username}:${this.password}`);
  }

  private requestBaseUrl(request: IncomingMessage): string {
    let host = request.headers.host ?? `${this.host}:${this.port}`;
    if (this.password) {
      const user = quotePathComponent(this.username, '');
      const secret = quotePathComponent(this.password, '');
      host = `${user}:${secret}@${host}`;
    }
    return `http://${host}`;
  }

  private async sendFile(
    record: CatalogFileRecord,
    response: ServerResponse,
    headOnly: boolean,
    rangeHeader: string | undefined,
    tracker: ResponseTracker,
  ): Promise<void> {
    let size: number;
    let modifiedTime: number;
    try {
      const info = await stat(record.filePath);
      if (!info.isFile()) {
        this.sendNotFound(response, headOnly);
        return;
      }
      size = info.size;
      modifiedTime = info.mtimeMs;
    } catch {
      this.sendNotFound(response, headOnly);
      return;
    }

    let start = 0;
    let end = size - 1;
    const partial = rangeHeader !== undefined;
    if (rangeHeader !== undefined) {
      const parsed = parseByteRange(rangeHeader, size);
      if (!parsed) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
        response.end();
        return;
      }
      start = parsed.start;
      end = parsed.end;
    }
    const contentLength = end - start + 1;
    const headers: Record<string, string> = {
      'Content-Type': guessContentType(record.fileName),
      'Content-Length': String(contentLength),
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(modifiedTime).toUTCString(),
      'Content-Disposition': contentDisposition(record.fileName),
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(partial ? 206 : 200, headers);
    if (headOnly || contentLength < 1) {
      response.end();
      return;
    }

    const stream = createReadStream(record.filePath, { start, end, highWaterMark: CHUNK_SIZE });
    stream.on('error', () => {
      response.destroy();
    });
    response.on('close', () => {
      stream.destroy();
    });
    stream.pipe(response);
    // Registered in the same tick as `pipe`, so no chunk can slip past the counter.
    stream.on('data', (chunk: Buffer | string) => {
      tracker.bytesSent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    });
  }

  private sendPayload(
    response: ServerResponse,
    body: Buffer,
    contentType: string,
    headOnly: boolean,
    rangeHeader: string | undefined,
    tracker: ResponseTracker,
  ): void {
    const size = body.length;
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (rangeHeader !== undefined) {
      const parsed = parseByteRange(rangeHeader, size);
      if (!parsed) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
        response.end();
        return;
      }
      start = parsed.start;
      end = parsed.end;
      partial = true;
    }
    const chunk = body.subarray(start, end + 1);
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(chunk.length),
      'Accept-Ranges': 'bytes',
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(partial ? 206 : 200, headers);
    if (headOnly || chunk.length === 0) {
      response.end();
      return;
    }
    tracker.bytesSent += chunk.length;
    response.end(chunk);
  }

  private sendNotFound(response: ServerResponse, headOnly: boolean): void {
    const body = Buffer.from('Not Found', 'utf8');
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length) });
    response.end(headOnly ? undefined : body);
  }

  private logRequest(
    method: string,
    tracker: ResponseTracker,
    status: number,
    rangeHeader: string | undefined,
  ): void {
    this.log(
      `${new Date().toISOString()} ${method} ${tracker.category} ${status} Range=${rangeHeader ?? '-'} bytes=${tracker.bytesSent}`,
    );
  }

  private log(line: string): void {
    try {
      this.source.logServerEvent(line);
    } catch {
      // Logging must never break a response.
    }
  }
}

function requestPath(request: IncomingMessage): string {
  const target = request.url ?? '/';
  let pathname: string;
  try {
    pathname = new URL(target, 'http://localhost').pathname;
  } catch {
    pathname = target.split(/[?#]/, 1)[0] ?? '/';
  }
  return pathname.replace(/\/+$/, '') || '/';
}

function guessContentType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    // Compare anyway so the comparison cost does not leak the expected length.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Strict-ish `base64.b64decode(validate=True)`: canonical Base64 and UTF-8. */
function decodeBasicCredentials(token: string): string | null {
  if (token.length === 0 || token.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token)) return null;
  const buffer = Buffer.from(token, 'base64');
  if (buffer.toString('base64') !== token) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
