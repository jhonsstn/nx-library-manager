import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppDatabase } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { AppPaths } from '../platform/paths';
import { detectLanIp, switchDirectoryUrl } from '../platform/lan';
import { createCatalogFileSource } from '../repositories/catalog-files.repository';
import { DbiHttpServer } from '../server/dbi-http-server';
import type { AppSettings } from '../../shared/types/settings';
import type { HttpServerStatusDto } from '../../shared/types/domain';
import type { AppErrorDto } from '../../shared/errors/codes';
import { SwitchCatalogError } from '../../shared/errors/app-error';

export interface HttpServerServiceOptions {
  db: AppDatabase;
  paths: AppPaths;
  settings: () => AppSettings;
  logger?: Logger;
  onStatusChanged?: (status: HttpServerStatusDto) => void;
}

/**
 * Owns the DBI-compatible server lifecycle: one instance, started/stopped from
 * Settings or at startup, with the LAN directory URL reported to the renderer.
 */
export class HttpServerService {
  private readonly db: AppDatabase;
  private readonly paths: AppPaths;
  private readonly settings: () => AppSettings;
  private readonly logger: Logger | undefined;
  private readonly onStatusChanged: ((status: HttpServerStatusDto) => void) | undefined;
  private server: DbiHttpServer | null = null;
  private lastError: AppErrorDto | null = null;
  private lanIp = '127.0.0.1';

  constructor(options: HttpServerServiceOptions) {
    this.db = options.db;
    this.paths = options.paths;
    this.settings = options.settings;
    this.logger = options.logger;
    this.onStatusChanged = options.onStatusChanged;
  }

  async getStatus(): Promise<HttpServerStatusDto> {
    const settings = this.settings();
    const port = this.server?.port ?? settings.httpServerPort;
    return this.buildStatus(settings, port);
  }

  async start(): Promise<HttpServerStatusDto> {
    const settings = this.settings();
    await this.stop();
    this.lanIp = await detectLanIp();
    try {
      const server = new DbiHttpServer({
        source: createCatalogFileSource(this.db, (line) => this.appendServerLog(line)),
        port: settings.httpServerPort,
        username: settings.httpServerUsername,
        password: settings.httpServerPassword ?? '',
      });
      const started = await server.start();
      this.server = server;
      this.lastError = null;
      this.logger?.info('httpServer.started', { port: started.port, auth: Boolean(settings.httpServerPassword) });
      return this.publish(this.buildStatus(settings, started.port));
    } catch (error) {
      this.server = null;
      this.lastError =
        error instanceof SwitchCatalogError
          ? error.toDto()
          : { code: 'HTTP_SERVER_ERROR', message: error instanceof Error ? error.message : String(error) };
      this.logger?.error('httpServer.startFailed', { error: this.lastError.message, port: settings.httpServerPort });
      this.publish(this.buildStatus(settings, settings.httpServerPort));
      throw error;
    }
  }

  async stop(): Promise<HttpServerStatusDto> {
    const settings = this.settings();
    if (this.server) {
      const port = this.server.port;
      await this.server.stop();
      this.server = null;
      this.logger?.info('httpServer.stopped', { port });
    }
    return this.publish(this.buildStatus(settings, settings.httpServerPort));
  }

  /** Applies the current settings: enabled -> start, disabled -> stop. */
  async applySettings(): Promise<HttpServerStatusDto> {
    const settings = this.settings();
    if (!settings.httpServerEnabled) return this.stop();
    try {
      return await this.start();
    } catch {
      // `start` already published the failure status; Settings surfaces the error.
      return this.getStatus();
    }
  }

  private buildStatus(settings: AppSettings, port: number): HttpServerStatusDto {
    const running = this.server?.running ?? false;
    return {
      running,
      port,
      directoryUrl: running ? switchDirectoryUrl(this.lanIp, port) : '',
      authEnabled: running && Boolean(settings.httpServerPassword),
      error: this.lastError,
    };
  }

  private publish(status: HttpServerStatusDto): HttpServerStatusDto {
    this.onStatusChanged?.(status);
    return status;
  }

  /** Structured request log; never includes authorization headers (spec 09). */
  private appendServerLog(line: string): void {
    try {
      mkdirSync(dirname(this.paths.serverLogFile), { recursive: true });
      appendFileSync(this.paths.serverLogFile, `${line}\n`, 'utf8');
    } catch {
      /* request logging must never break a download */
    }
  }
}
