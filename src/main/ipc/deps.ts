import type { AppDatabase } from '../db/database';
import type { Logger } from '../lifecycle/logger';
import type { AppPaths } from '../platform/paths';
import type { SettingsStore } from '../settings/settings.store';
import type { CatalogService } from '../services/catalog.service';
import type { ScannerService } from '../services/scanner.service';
import type { MetadataService } from '../services/metadata.service';
import type { InstallService } from '../services/install.service';
import type { FileService } from '../services/file.service';
import type { MtpService } from '../services/mtp.service';
import type { HttpServerService } from '../services/http-server.service';
import type { AppUpdateService } from '../services/app-update.service';

/** Everything the IPC layer may touch; assembled once in `main/index.ts`. */
export interface IpcDeps {
  paths: AppPaths;
  db: AppDatabase;
  logger: Logger;
  settings: SettingsStore;
  catalog: CatalogService;
  scanner: ScannerService;
  metadata: MetadataService;
  install: InstallService;
  files: FileService;
  mtp: MtpService;
  httpServer: HttpServerService;
  appUpdate: AppUpdateService;
  currentVersion: string;
  emit: (channel: string, payload: unknown) => void;
}
