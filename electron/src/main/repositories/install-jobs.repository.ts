import type { AppDatabase } from '../db/database';
import type { AppErrorDto } from '../../shared/errors/codes';
import type { GameFileKind, InstallDestinationType, InstallJobDto, InstallJobStatus } from '../../shared/types/domain';
import { isShellPath } from '../../shared/format/install';

export interface InstallJobRow {
  id: number;
  game_id: number | null;
  source_path: string;
  destination_path: string | null;
  destination_folder: string;
  destination_label: string | null;
  destination_type: string | null;
  file_name: string;
  file_size: number;
  file_kind: string;
  detected_version: string | null;
  raw_version: number;
  transferred_bytes: number;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

const TERMINAL_STATUSES: InstallJobStatus[] = ['completed', 'failed', 'cancelled'];

const JOB_COLUMNS = `id, game_id, source_path, destination_path, destination_folder, destination_label,
  destination_type, file_name, file_size, file_kind, detected_version, raw_version, transferred_bytes,
  status, error, created_at, completed_at`;

export function isTerminalStatus(status: InstallJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Rows written by the Qt build only stored the destination folder. Infer the DTO
 * destination type from the stored shape so install history stays readable.
 */
export function inferDestinationType(row: Pick<InstallJobRow, 'destination_type' | 'destination_folder' | 'destination_label'>): InstallDestinationType {
  const stored = row.destination_type;
  if (stored === 'folder' || stored === 'mtp-sd' || stored === 'mtp-nand') return stored;
  if (!isShellPath(row.destination_folder)) return 'folder';
  const label = (row.destination_label ?? '').toLowerCase();
  if (label.includes('nand')) return 'mtp-nand';
  if (label.includes('sd')) return 'mtp-sd';
  return 'mtp-sd';
}

export function toInstallJobDto(row: InstallJobRow): InstallJobDto {
  return {
    id: row.id,
    gameId: row.game_id,
    sourcePath: row.source_path,
    displayName: row.file_name,
    destinationType: inferDestinationType(row),
    destinationFolder: row.destination_folder,
    destinationLabel: row.destination_label,
    destinationPath: row.destination_path,
    fileKind: row.file_kind as GameFileKind,
    detectedVersion: row.detected_version ?? '',
    rawVersion: row.raw_version,
    sizeBytes: row.file_size,
    transferredBytes: row.transferred_bytes,
    status: row.status as InstallJobStatus,
    error: parseStoredError(row.error),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Qt stored a plain message; the DTO carries a full envelope. */
function parseStoredError(value: string | null): AppErrorDto | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as AppErrorDto;
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') return parsed;
  } catch {
    /* plain message from the Qt build */
  }
  return { code: 'UNKNOWN_ERROR', message: value };
}

export interface InstallJobInsert {
  gameId: number | null;
  sourcePath: string;
  destinationFolder: string;
  destinationLabel: string | null;
  destinationType: InstallDestinationType;
  fileName: string;
  fileSize: number;
  fileKind: GameFileKind;
  detectedVersion: string;
  rawVersion: number;
}

export function insertInstallJob(db: AppDatabase, input: InstallJobInsert): number {
  const result = db
    .prepare(
      `
      INSERT INTO install_jobs(
        game_id, source_path, destination_folder, destination_label, destination_type, file_name,
        file_size, file_kind, detected_version, raw_version, transferred_bytes, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')
      `,
    )
    .run(
      input.gameId,
      input.sourcePath,
      input.destinationFolder,
      input.destinationLabel,
      input.destinationType,
      input.fileName,
      input.fileSize,
      input.fileKind,
      input.detectedVersion,
      input.rawVersion,
    );
  return Number(result.lastInsertRowid);
}

export interface InstallJobUpdate {
  status: InstallJobStatus;
  destinationPath?: string | null;
  error?: AppErrorDto | null;
  transferredBytes?: number;
}

export function updateInstallJob(db: AppDatabase, jobId: number, update: InstallJobUpdate): void {
  const completeTerminal = isTerminalStatus(update.status);
  db.prepare(
    `
    UPDATE install_jobs SET
      status = ?,
      destination_path = COALESCE(?, destination_path),
      error = ?,
      transferred_bytes = COALESCE(?, transferred_bytes),
      completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
    `,
  ).run(
    update.status,
    update.destinationPath ?? null,
    update.error ? JSON.stringify(update.error) : null,
    update.transferredBytes ?? null,
    completeTerminal ? 1 : 0,
    jobId,
  );
}

export function getInstallJob(db: AppDatabase, jobId: number): InstallJobDto | null {
  const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM install_jobs WHERE id = ?`).get(jobId) as
    | InstallJobRow
    | undefined;
  return row ? toInstallJobDto(row) : null;
}

export function listInstallJobs(db: AppDatabase, options: { limit?: number } = {}): InstallJobDto[] {
  const limit = options.limit ? `LIMIT ${Math.trunc(options.limit)}` : '';
  const rows = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM install_jobs ORDER BY id DESC ${limit}`)
    .all() as InstallJobRow[];
  return rows.map(toInstallJobDto);
}

export function listJobsByStatus(db: AppDatabase, statuses: InstallJobStatus[]): InstallJobDto[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM install_jobs WHERE status IN (${placeholders}) ORDER BY id`)
    .all(...statuses) as InstallJobRow[];
  return rows.map(toInstallJobDto);
}

/**
 * Startup recovery (spec 08): transfers interrupted by a crash must not look
 * active. Sources are never touched.
 */
export function markInterruptedJobsFailed(db: AppDatabase): number {
  const result = db
    .prepare(
      `
      UPDATE install_jobs
      SET status = 'failed',
          error = ?,
          completed_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
      `,
    )
    .run(
      JSON.stringify({
        code: 'UNKNOWN_ERROR',
        message: 'Transfer was interrupted when the application closed.',
        retryable: true,
      } satisfies AppErrorDto),
    );
  return result.changes;
}

/** Latest completed install for a game, used by the details pane. */
export function latestCompletedInstall(db: AppDatabase, gameId: number): InstallJobDto | null {
  const row = db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM install_jobs
       WHERE game_id = ? AND status = 'completed'
       ORDER BY raw_version DESC, completed_at DESC LIMIT 1`,
    )
    .get(gameId) as InstallJobRow | undefined;
  return row ? toInstallJobDto(row) : null;
}

export function countInstallJobs(db: AppDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM install_jobs').get() as { total: number };
  return row.total;
}
