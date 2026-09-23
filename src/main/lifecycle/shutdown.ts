import type { ShutdownStatusDto } from '../../shared/types/domain';

export interface PreventableQuitEvent {
  preventDefault(): void;
}

export interface ShutdownCoordinatorOptions {
  shutdown(): Promise<void>;
  quit(): void;
  waitingMessage(): string;
  onStatus?(status: ShutdownStatusDto): void;
}

/** Serializes close/quit requests and only re-enters quit after cleanup. */
export class ShutdownCoordinator {
  private phase: 'idle' | 'running' | 'complete' = 'idle';
  private work: Promise<void> | null = null;

  constructor(private readonly options: ShutdownCoordinatorOptions) {}

  request(event: PreventableQuitEvent): boolean {
    if (this.phase === 'complete') return true;
    event.preventDefault();
    if (this.phase === 'idle') {
      this.phase = 'running';
      this.options.onStatus?.({ phase: 'waiting', message: this.options.waitingMessage() });
      this.work = this.options.shutdown().finally(() => {
        this.phase = 'complete';
        this.options.onStatus?.({ phase: 'closing', message: 'Closing NX Library Manager…' });
        this.options.quit();
      });
    }
    return false;
  }

  get isShuttingDown(): boolean {
    return this.phase !== 'idle';
  }

  async whenComplete(): Promise<void> {
    if (this.work) await this.work;
  }
}
