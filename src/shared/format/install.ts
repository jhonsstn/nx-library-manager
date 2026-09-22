import { formatBytes } from './bytes';

/** Ports `ui._install_size_text`. */
export function installSizeText(summary: {
  baseSize: number;
  selectedUpdateCount: number;
  selectedUpdateSize: number;
}): string {
  const base = Number(summary.baseSize || 0);
  const updateSize = Number(summary.selectedUpdateSize || 0);
  return (
    `Install size: Base ${formatBytes(base)} + ` +
    `${summary.selectedUpdateCount} update/DLC file(s) ${formatBytes(updateSize)} = ` +
    `Total size ${formatBytes(base + updateSize)}`
  );
}

/** Ports `ui._display_folder`: shell paths show their friendly label instead. */
export function displayFolder(value: string, displayValue = ''): string {
  if (displayValue && isShellPath(value)) return displayValue;
  return value;
}

export function isShellPath(value: string | null | undefined): boolean {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text.startsWith('shell:::') || text.startsWith('::{');
}

/** Ports `ui._path_is_install_destination`. */
export function isPathInsideFolder(path: string, folder: string): boolean {
  if (!path || !folder) return false;
  if (isShellPath(path) || isShellPath(folder)) {
    return path.toLowerCase().startsWith(folder.toLowerCase());
  }
  const normalize = (value: string) => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const normalizedPath = normalize(path);
  const normalizedFolder = normalize(folder);
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}
