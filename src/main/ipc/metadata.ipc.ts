import { z } from 'zod';
import { EVENTS, IPC } from '../../shared/contracts/ipc';
import { BulkRefreshInputSchema, GameIdSchema, MetadataCandidateSchema, MetadataSearchInputSchema } from '../../shared/schemas/inputs';
import { appError } from '../../shared/errors/app-error';
import { handle } from './handle';
import type { IpcDeps } from './deps';

export function registerMetadataIpc(deps: IpcDeps): void {
  let bulkCounter = 0;
  let bulkController: AbortController | null = null;

  handle(IPC.metadata.search, z.tuple([MetadataSearchInputSchema]), (input) =>
    deps.metadata.searchCandidates(input.gameId, input.query),
  );
  handle(IPC.metadata.apply, z.tuple([GameIdSchema, MetadataCandidateSchema]), async (gameId, candidate) => {
    // Manual choices lock the game so automated scans never overwrite them (Flow E).
    await deps.metadata.applyCandidate(gameId, candidate, { lock: true, needsReview: false });
    return deps.catalog.getGame(gameId);
  });
  handle(IPC.metadata.refresh, z.tuple([GameIdSchema]), async (gameId) => {
    const jobId = `metadata_refresh_${gameId}_${Date.now()}`;
    // Resolves after the refresh finishes so the renderer's refetch sees the new
    // metadata; the job id is reported for correlation/logging.
    const applied = await deps.metadata.refreshGame(gameId);
    deps.logger.info('metadata.refresh', { jobId, gameId, applied });
    return { jobId };
  });
  handle(IPC.metadata.bulkRefresh, z.tuple([BulkRefreshInputSchema.default({})]), (input) => {
    if (bulkController) throw appError('JOB_ALREADY_RUNNING', 'A metadata refresh is already running.');
    const jobId = `metadata_bulk_${(bulkCounter += 1)}`;
    const controller = new AbortController();
    bulkController = controller;

    void (async () => {
      try {
        await deps.metadata.bulkRefresh({
          force: input.force,
          limit: input.limit,
          signal: controller.signal,
          onProgress: (progress) => deps.emit(EVENTS.metadataBulkProgress, { ...progress, jobId }),
        });
      } catch (error) {
        deps.logger.error('metadata.bulkFailed', {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.emit(EVENTS.metadataBulkProgress, {
          jobId,
          total: 0,
          processed: 0,
          updated: 0,
          noMatch: 0,
          failed: 1,
          currentTitle: '',
          done: true,
          cancelled: false,
        });
      } finally {
        bulkController = null;
      }
    })();

    return { jobId };
  });
  handle(IPC.metadata.cancel, z.tuple([z.string().min(1)]), (jobId) => {
    if (!bulkController) throw appError('JOB_CANCELLED', `No metadata job is running (${jobId}).`);
    bulkController.abort();
  });
}
