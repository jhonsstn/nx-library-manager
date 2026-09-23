import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator } from '@main/lifecycle/shutdown';

describe('ShutdownCoordinator', () => {
  it('waits for cleanup, publishes status, and re-enters quit exactly once', async () => {
    let finishCleanup: (() => void) | undefined;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finishCleanup = resolve)));
    const quit = vi.fn();
    const onStatus = vi.fn();
    const coordinator = new ShutdownCoordinator({
      shutdown,
      quit,
      waitingMessage: () => 'Waiting for scanner and install work…',
      onStatus,
    });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    expect(coordinator.request(first)).toBe(false);
    expect(coordinator.request(second)).toBe(false);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith({
      phase: 'waiting',
      message: 'Waiting for scanner and install work…',
    });

    finishCleanup?.();
    await coordinator.whenComplete();

    expect(quit).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith({
      phase: 'closing',
      message: 'Closing NX Library Manager…',
    });
    const reentry = { preventDefault: vi.fn() };
    expect(coordinator.request(reentry)).toBe(true);
    expect(reentry.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });
});
