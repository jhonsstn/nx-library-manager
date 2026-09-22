/**
 * Stable, user-facing error codes. Mirrors `migration-spec/architecture/03-ipc-contract.md`.
 */
export const APP_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'FILE_MISSING',
  'PERMISSION_DENIED',
  'PATH_NOT_ALLOWED',
  'JOB_ALREADY_RUNNING',
  'JOB_CANCELLED',
  'DATABASE_ERROR',
  'NETWORK_ERROR',
  'METADATA_AUTH_ERROR',
  'METADATA_RATE_LIMITED',
  'MTP_NOT_CONNECTED',
  'MTP_DESTINATION_NOT_FOUND',
  'MTP_COPY_FAILED',
  'HTTP_PORT_IN_USE',
  'HTTP_SERVER_ERROR',
  'UPDATE_CHECK_FAILED',
  'UNKNOWN_ERROR',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** Wire representation of a failure crossing the preload bridge. */
export interface AppErrorDto {
  code: AppErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
}
