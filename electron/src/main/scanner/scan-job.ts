import type { ScanCompletedDto, ScanPhase, ScanProgressDto } from '../../shared/types/domain';

/**
 * Scan job state machine and progress throttling (spec 05 "Job model",
 * "Cancellation", "Progress reporting").
 *
 * The job owns the counters the renderer sees; the service owns the I/O. The
 * throttle helpers are pure so they can be unit-tested with an injected clock.
 */

/** ~8 progress events per second; spec 05 asks for 5–10. */
export const PROGRESS_MIN_INTERVAL_MS = 125;

export interface ScanJobState {
  id: string;
  startedAt: number;
  cancelled: boolean;
  phase: ScanPhase;
  progress: ScanProgressDto;
}

export interface ScanJobOptions {
  id: string;
  startedAt: number;
}

/** Counter deltas reported while a scan runs; every field accumulates. */
export interface ScanRecordInput {
  checkedFiles?: number;
  candidateFiles?: number;
  gamesFound?: number;
  updatesFound?: number;
  currentPath?: string;
}

export interface ScanFinishInput {
  cancelled: boolean;
  unmatchedUpdates: number;
  elapsedMs: number;
}

/**
 * Whether a progress event may be sent at `nowMs`. `lastEmitMs <= 0` means
 * "nothing emitted yet", so the first event always goes out.
 */
export function shouldEmit(nowMs: number, lastEmitMs: number): boolean {
  return lastEmitMs <= 0 || nowMs - lastEmitMs >= PROGRESS_MIN_INTERVAL_MS;
}

/** Rate-limits progress events, keeping the last one for the caller to flush. */
export class ProgressFlusher {
  private lastEmitMs = 0;

  constructor(
    private readonly emit: (event: ScanProgressDto) => void,
    private readonly now: () => number,
  ) {}

  /** Sends `event` when the throttle window has passed, otherwise drops it. */
  tick(event: ScanProgressDto): void {
    if (shouldEmit(this.now(), this.lastEmitMs)) this.emitNow(event);
  }

  /** Always sends `event`; the terminal progress event is never throttled away. */
  flush(event: ScanProgressDto): void {
    this.emitNow(event);
  }

  private emitNow(event: ScanProgressDto): void {
    this.lastEmitMs = this.now();
    this.emit(event);
  }
}

export class ScanJob {
  readonly id: string;
  readonly startedAt: number;
  phase: ScanPhase = 'discovering';

  private cancelRequested = false;
  private checkedFiles = 0;
  private candidateFiles = 0;
  private gamesFound = 0;
  private updatesFound = 0;
  private currentPath: string | undefined;
  private totalFiles: number | undefined;

  constructor(options: ScanJobOptions) {
    this.id = options.id;
    this.startedAt = options.startedAt;
  }

  get cancelled(): boolean {
    return this.cancelRequested;
  }

  get isCancelled(): boolean {
    return this.cancelRequested;
  }

  setPhase(phase: ScanPhase): void {
    this.phase = phase;
  }

  record(input: ScanRecordInput): void {
    this.checkedFiles += input.checkedFiles ?? 0;
    this.candidateFiles += input.candidateFiles ?? 0;
    this.gamesFound += input.gamesFound ?? 0;
    this.updatesFound += input.updatesFound ?? 0;
    if (input.currentPath !== undefined) this.currentPath = input.currentPath;
  }

  requestCancel(): void {
    this.cancelRequested = true;
  }

  /**
   * Only callers that know the total up front set this; the streaming walk does
   * not, and `percent` stays absent in that case.
   */
  setTotalFiles(total: number): void {
    this.totalFiles = total > 0 ? total : undefined;
  }

  get progress(): ScanProgressDto {
    const progress: ScanProgressDto = {
      jobId: this.id,
      phase: this.phase,
      checkedFiles: this.checkedFiles,
      candidateFiles: this.candidateFiles,
      gamesFound: this.gamesFound,
      updatesFound: this.updatesFound,
    };
    if (this.currentPath !== undefined) progress.currentPath = this.currentPath;
    if (this.totalFiles !== undefined) {
      progress.percent = Math.min(100, Math.round((this.checkedFiles / this.totalFiles) * 100));
    }
    return progress;
  }

  get state(): ScanJobState {
    return {
      id: this.id,
      startedAt: this.startedAt,
      cancelled: this.cancelRequested,
      phase: this.phase,
      progress: this.progress,
    };
  }

  finish(input: ScanFinishInput): ScanCompletedDto {
    return {
      jobId: this.id,
      cancelled: input.cancelled || this.cancelRequested,
      checkedFiles: this.checkedFiles,
      gamesFound: this.gamesFound,
      updatesFound: this.updatesFound,
      unmatchedUpdates: input.unmatchedUpdates,
      elapsedMs: input.elapsedMs,
    };
  }
}
