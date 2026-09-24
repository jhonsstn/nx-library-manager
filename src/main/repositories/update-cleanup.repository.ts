import type { UpdateCleanupFileDto, UpdateCleanupPreviewDto } from '../../shared/types/domain';
import type { AppDatabase } from '../db/database';

interface PackageTitleRow {
  file_path: string;
  file_name: string;
  file_size: number;
  modified_time: number;
  inspection_error: string | null;
  inspection_version: number | null;
  title_id: string | null;
  base_title_id: string | null;
  type: 'base' | 'update' | 'dlc';
  provisional: number;
  raw_version: number | null;
  detection_source: string;
}

/** Only verified patch versions for one unambiguous base Title ID can drive cleanup. */
export function previewOldUpdates(db: AppDatabase, gameId: number): UpdateCleanupPreviewDto {
  const empty: UpdateCleanupPreviewDto = { latestLocalVersion: null, keepFiles: [], deleteFiles: [] };
  const bases = db.prepare(`SELECT DISTINCT title_id FROM titles
    WHERE game_id=? AND type='base' AND provisional=0 AND title_id IS NOT NULL`).all(gameId) as
    Array<{ title_id: string }>;
  if (bases.length !== 1) return empty;
  const baseTitleId = bases[0].title_id;

  const rows = db.prepare(`SELECT lf.file_path, lf.file_name, lf.file_size, lf.modified_time,
    lf.inspection_error, lf.inspection_version, t.title_id, t.base_title_id, t.type,
    t.provisional, ft.raw_version, ft.detection_source
    FROM local_files lf JOIN file_titles ft ON ft.local_file_id=lf.id
    JOIN titles t ON t.id=ft.title_id
    WHERE lf.id IN (SELECT ft2.local_file_id FROM file_titles ft2
      JOIN titles t2 ON t2.id=ft2.title_id
      WHERE t2.type='update' AND t2.base_title_id=? AND t2.provisional=0)
    ORDER BY lf.file_path`).all(baseTitleId) as PackageTitleRow[];
  const byPath = new Map<string, PackageTitleRow[]>();
  for (const row of rows) {
    const titles = byPath.get(row.file_path) ?? [];
    titles.push(row);
    byPath.set(row.file_path, titles);
  }

  const matchedPaths = new Set((db.prepare('SELECT file_path FROM updates WHERE game_id=?').all(gameId) as
    Array<{ file_path: string }>).map((row) => row.file_path));
  const findBasePath = db.prepare('SELECT 1 FROM game_files WHERE file_path=? LIMIT 1');

  let latestLocalVersion: number | null = null;
  const packages: Array<{ file: UpdateCleanupFileDto; removable: boolean }> = [];
  for (const [path, titles] of byPath) {
    const first = titles[0];
    if (first.inspection_version === null || first.inspection_error) continue;
    const isBasePath = Boolean(findBasePath.get(path));
    if (!matchedPaths.has(path) && !isBasePath) continue;
    const patches = titles.filter((title) => title.type === 'update' && !title.provisional &&
      title.detection_source !== 'filename' && title.detection_source !== 'migration' &&
      title.base_title_id === baseTitleId && title.title_id &&
      title.raw_version !== null && Number.isSafeInteger(title.raw_version) && title.raw_version > 0);
    if (patches.length === 0) continue;
    for (const patch of patches) latestLocalVersion = Math.max(latestLocalVersion ?? 0, patch.raw_version!);
    const removable = matchedPaths.has(path) && !isBasePath &&
      titles.length === 1 && patches.length === 1 &&
      titles.every((title) => !title.provisional && title.detection_source !== 'filename' &&
        title.detection_source !== 'migration');
    packages.push({
      file: { filePath: path, fileName: first.file_name, fileSize: first.file_size,
        modifiedTime: first.modified_time,
        rawVersion: Math.max(...patches.map((patch) => patch.raw_version!)) },
      removable,
    });
  }
  if (latestLocalVersion === null) return empty;
  return {
    latestLocalVersion,
    keepFiles: packages.filter(({ file }) => file.rawVersion === latestLocalVersion).map(({ file }) => file),
    deleteFiles: packages.filter(({ file, removable }) => removable && file.rawVersion < latestLocalVersion)
      .map(({ file }) => file),
  };
}
