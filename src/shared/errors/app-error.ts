import type { AppErrorCode, AppErrorDto } from './codes';

/**
 * Error type shared by main, preload, and renderer. Main serializes failures to
 * `AppErrorDto`; the preload bridge rehydrates them into this class so renderer
 * code can branch on `error.code` instead of parsing messages.
 */
export class SwitchCatalogError extends Error {
  readonly code: AppErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(dto: AppErrorDto) {
    super(dto.message);
    this.name = 'SwitchCatalogError';
    this.code = dto.code;
    this.details = dto.details;
    this.retryable = dto.retryable ?? false;
  }

  toDto(): AppErrorDto {
    const dto: AppErrorDto = { code: this.code, message: this.message };
    if (this.details !== undefined) dto.details = this.details;
    if (this.retryable) dto.retryable = true;
    return dto;
  }
}

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

export function appError(code: AppErrorCode, message: string, options: AppErrorOptions = {}): SwitchCatalogError {
  const dto: AppErrorDto = { code, message };
  if (options.details !== undefined) dto.details = options.details;
  if (options.retryable) dto.retryable = true;
  const error = new SwitchCatalogError(dto);
  if (options.cause !== undefined) error.cause = options.cause;
  return error;
}

/** Normalizes unknown thrown values (including raw SQLite/Node errors) into an envelope. */
export function toAppErrorDto(error: unknown): AppErrorDto {
  if (error instanceof SwitchCatalogError) return error.toDto();
  if (error instanceof Error) {
    return {
      code: classifyError(error),
      message: error.message || error.name,
    };
  }
  return { code: 'UNKNOWN_ERROR', message: String(error) };
}

function classifyError(error: Error): AppErrorCode {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOENT':
      return 'FILE_MISSING';
    case 'EACCES':
    case 'EPERM':
      return 'PERMISSION_DENIED';
    case 'EADDRINUSE':
      return 'HTTP_PORT_IN_USE';
    default:
      break;
  }
  if (error.name === 'AbortError') return 'JOB_CANCELLED';
  return 'UNKNOWN_ERROR';
}
