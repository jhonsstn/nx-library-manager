import { z } from 'zod';
import { EVENTS, IPC } from '../../shared/contracts/ipc';
import { CreateInstallInputSchema } from '../../shared/schemas/inputs';
import { handle } from './handle';
import type { IpcDeps } from './deps';

export function registerInstallIpc(deps: IpcDeps): void {
  handle(IPC.install.create, z.tuple([CreateInstallInputSchema]), (input) => deps.install.create(input));
  handle(IPC.install.cancel, z.tuple([z.number().int().positive()]), (jobId) => deps.install.cancel(jobId));
  handle(IPC.install.retryFailed, z.tuple([]), () => deps.install.retryFailed());
  handle(IPC.install.list, z.tuple([]), () => deps.install.getJobs());
}

export function registerMtpIpc(deps: IpcDeps): void {
  handle(IPC.mtp.getStatus, z.tuple([]), () => deps.mtp.getStatus());
  handle(IPC.mtp.refresh, z.tuple([]), () => deps.mtp.getStatus({ refresh: true }));
}

/** Wires the queue's change events to the renderer event channel. */
export function installEventForwarder(deps: IpcDeps): (job: unknown) => void {
  return (job) => deps.emit(EVENTS.installChanged, job);
}
