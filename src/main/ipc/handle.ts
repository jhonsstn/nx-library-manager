import { BrowserWindow, ipcMain } from 'electron';
import { toAppErrorDto } from '../../shared/errors/app-error';
import type { IpcResult } from '../../shared/contracts/ipc';

function isZodError(value: unknown): value is { issues: Array<{ path?: Array<string | number>; message: string }> } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('issues' in value)) return false;
  return Array.isArray(value.issues);
}

/** Structural parser shape: avoids Zod version-specific variance in `handle`. */
export interface InputParser<TArgs extends unknown[]> {
  parse(input: unknown): TArgs;
}

/**
 * Registers one IPC channel. Handlers never reject: every outcome is serialized
 * into `IpcResult` so failures cross the process boundary with a stable code
 * instead of a stringified stack (spec 03).
 *
 * `parser` validates the raw argument tuple, so `handler` only ever sees
 * validated input.
 */
export function handle<TArgs extends unknown[], TResult>(
  channel: string,
  parser: InputParser<TArgs>,
  handler: (...args: TArgs) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<TResult>> => {
    try {
      const parsed = parser.parse(args);
      const value = await handler(...parsed);
      return { ok: true, value };
    } catch (error) {
      if (isZodError(error)) {
        const message = error.issues
          .map((issue) => `${issue.path?.join('.') || 'input'}: ${issue.message}`)
          .join('; ');
        return { ok: false, error: { code: 'VALIDATION_ERROR', message } };
      }
      return { ok: false, error: toAppErrorDto(error) };
    }
  });
}

/** Pushes a main-process event to every live renderer. */
export function emitToRenderers(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}
