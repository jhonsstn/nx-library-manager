import { z } from 'zod';
import { IPC } from '../../shared/contracts/ipc';
import type { ScanInput } from '../../shared/contracts/api';
import type { AppSettings } from '../../shared/types/settings';
import { ScanInputSchema } from '../../shared/schemas/inputs';
import { handle } from './handle';
import type { IpcDeps } from './deps';

/**
 * Fills an explicit scan request from the stored settings, so a plain "Rescan"
 * always uses the configured folders (the Qt build behaved the same way).
 */
export function resolveScanInput(settings: AppSettings, input: ScanInput): ScanInput {
  return {
    baseFolder: input.baseFolder ?? settings.baseGamesFolder,
    updatesFolder: input.updatesFolder ?? settings.updatesFolder,
    recursive: input.recursive ?? settings.scanRecursively,
    threshold: input.threshold ?? settings.fuzzyMatchThreshold,
    resetLibrary: input.resetLibrary ?? false,
  };
}

export function registerScanIpc(deps: IpcDeps): void {
  handle(IPC.scan.start, z.tuple([ScanInputSchema.default({})]), (input) =>
    deps.scanner.start(resolveScanInput(deps.settings.getFull(), input)),
  );
  handle(IPC.scan.cancel, z.tuple([z.string().min(1)]), (jobId) => deps.scanner.cancel(jobId));
  handle(IPC.scan.getStatus, z.tuple([z.string().min(1)]), (jobId) => deps.scanner.getStatus(jobId));
}
