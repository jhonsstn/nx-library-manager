/**
 * Byte formatting. Ports `_format_bytes` from the Qt implementation so displayed
 * sizes stay identical after migration.
 */
export function formatBytes(value: number | null | undefined): string {
  let size = Number(value ?? 0);
  if (!Number.isFinite(size)) size = 0;
  for (const unit of ['B', 'KB', 'MB', 'GB'] as const) {
    if (size < 1024) return `${size.toFixed(1)} ${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(1)} TB`;
}
