import type { Dir } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { SUPPORTED_EXTENSIONS } from './filename-parser';

/**
 * Filesystem discovery for the scan pipeline (spec 05, phase 1).
 *
 * Port of `switch_catalog.scanner.iter_game_files`: directory contents are read
 * with `fs.promises.opendir`, file contents are never touched, and a root that
 * cannot be opened yields an empty list instead of throwing.
 */

/** One discovered catalog candidate; sizes/times come from the directory entry's `stat`. */
export interface LibraryFileEntry {
  /** Absolute, resolved path. */
  path: string;
  fileName: string;
  /** Lower-cased extension without the leading dot (`nsp`). */
  extension: string;
  sizeBytes: number;
  modifiedTime: number;
}

export interface WalkLibraryOptions {
  root: string;
  recursive: boolean;
  /** Roots whose entries are skipped, `iter_game_files(exclude_roots=...)` style. */
  excludeRoots?: string[];
  signal?: AbortSignal;
  /** Called with the number of directory entries examined since the last batch. */
  onBatch?: (count: number) => void;
}

/** Entries examined between progress reports and cancellation checks. */
export const WALK_BATCH_SIZE = 256;

export async function walkLibrary(options: WalkLibraryOptions): Promise<LibraryFileEntry[]> {
  const { recursive, signal, onBatch } = options;
  if (signal?.aborted) return [];

  const root = resolve(options.root);
  const excluded = resolveExcludes(options.excludeRoots);
  const entries: LibraryFileEntry[] = [];

  // Breadth-first over directories that stay inside the root. `cursor` keeps the
  // queue array-indexed so a large tree does not pay `shift()` costs.
  const directories: string[] = [root];
  let cursor = 0;
  let pending = 0;

  const flushBatch = (): void => {
    if (pending === 0) return;
    const count = pending;
    pending = 0;
    onBatch?.(count);
  };

  while (cursor < directories.length) {
    if (signal?.aborted) return entries;
    const directory = directories[cursor];
    cursor += 1;

    let handle: Dir;
    try {
      handle = await opendir(directory);
    } catch {
      // Missing/unreadable root or subdirectory: skip it, never abort the walk.
      continue;
    }

    try {
      for await (const dirent of handle) {
        if (signal?.aborted) return entries;
        pending += 1;

        const childPath = join(directory, dirent.name);
        if (isExcluded(childPath, excluded)) continue;

        if (dirent.isDirectory()) {
          if (recursive && childPath.startsWith(root + sep)) directories.push(childPath);
        } else if (dirent.isFile()) {
          const extension = extname(dirent.name).slice(1).toLowerCase();
          if (SUPPORTED_EXTENSIONS.includes(`.${extension}`)) {
            const entry = await readEntry(childPath, dirent.name, extension);
            if (entry) entries.push(entry);
          }
        }

        if (pending >= WALK_BATCH_SIZE) {
          flushBatch();
          if (signal?.aborted) return entries;
        }
      }
    } catch {
      // The directory became unreadable mid-iteration: keep the rest of the walk.
    }

    flushBatch();
  }

  return entries;
}

/** `stat` is only paid for supported files; a vanished file is simply skipped. */
async function readEntry(path: string, fileName: string, extension: string): Promise<LibraryFileEntry | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return {
      path,
      fileName,
      extension,
      sizeBytes: info.size,
      modifiedTime: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

function resolveExcludes(excludeRoots: string[] | undefined): string[] {
  const resolved: string[] = [];
  for (const excludeRoot of excludeRoots ?? []) {
    if (!excludeRoot) continue;
    try {
      resolved.push(resolve(excludeRoot));
    } catch {
      // Unresolvable exclude roots are ignored, like `iter_game_files`.
    }
  }
  return resolved;
}

/** `resolved == exclude or exclude in resolved.parents`. */
function isExcluded(path: string, excludeRoots: string[]): boolean {
  for (const exclude of excludeRoots) {
    if (path === exclude || path.startsWith(exclude + sep)) return true;
  }
  return false;
}
