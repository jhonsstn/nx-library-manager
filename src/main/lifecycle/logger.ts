import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATION_MAX_BYTES, LOG_ROTATION_MAX_FILES } from '../../shared/constants';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  jobId?: string;
  gameId?: number;
  updateId?: number;
  [key: string]: unknown;
}

export interface Logger {
  child(subsystem: string): Logger;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * Keys that must never reach a log file (spec 04). Matching is by substring so
 * `igdbClientSecret`, `httpServerPassword`, `authorization` and bearer tokens
 * are all covered.
 */
const SENSITIVE_KEY_FRAGMENTS = ['secret', 'password', 'token', 'authorization', 'credential'];

export function scrubLogFields(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lowered = key.toLowerCase();
    if (SENSITIVE_KEY_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
      safe[key] = '[redacted]';
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  logsDir: string;
  subsystem?: string;
  level?: LogLevel;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Structured, size-rotated file logger for the main process. Writes are
 * synchronous on purpose: log volume is low and ordering matters more than
 * throughput during shutdown.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const fileName = options.fileName ?? 'app.log';
  const maxBytes = options.maxBytes ?? LOG_ROTATION_MAX_BYTES;
  const maxFiles = options.maxFiles ?? LOG_ROTATION_MAX_FILES;
  const now = options.now ?? Date.now;
  const basePath = join(options.logsDir, fileName);

  const rotateIfNeeded = (): void => {
    try {
      if (!existsSync(basePath) || statSync(basePath).size < maxBytes) return;
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const source = index === 1 ? basePath : `${basePath}.${index - 1}`;
        const target = `${basePath}.${index}`;
        if (!existsSync(source)) continue;
        if (existsSync(target)) unlinkSync(target);
        renameSync(source, target);
      }
    } catch {
      /* rotation must never break the application */
    }
  };

  const write = (subsystem: string, levelName: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVELS[levelName] < LEVELS[level]) return;
    const record = {
      timestamp: new Date(now()).toISOString(),
      level: levelName,
      subsystem,
      event,
      ...scrubLogFields(fields ?? {}),
    };
    try {
      rotateIfNeeded();
      appendFileSync(basePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* logging must never break the application */
    }
  };

  const make = (subsystem: string): Logger => ({
    child: (childSubsystem: string) => make(`${subsystem}.${childSubsystem}`),
    debug: (event, fields) => write(subsystem, 'debug', event, fields),
    info: (event, fields) => write(subsystem, 'info', event, fields),
    warn: (event, fields) => write(subsystem, 'warn', event, fields),
    error: (event, fields) => write(subsystem, 'error', event, fields),
  });

  return make(options.subsystem ?? 'app');
}
