import type { ContainedTitleDto, MtpInventoryDto } from '@shared/types/domain';

export type BatchVerification = 'confirmed' | 'waiting' | 'unverifiable';

/** Positive DBI title-ID matches can confirm an install even when the scan is partial. */
export function verifyMtpBatch(
  paths: string[], contents: ContainedTitleDto[], inventory: MtpInventoryDto,
  before: MtpInventoryDto | null,
  deviceId: string | null,
): BatchVerification {
  if (!deviceId || inventory.deviceId !== deviceId) return 'waiting';
  const selected = new Set(paths);
  const expected = contents.filter((item) => selected.has(item.filePath));
  if (paths.some((path) => !expected.some((item) => item.filePath === path))) return 'unverifiable';
  if (expected.some((item) => item.provisional || item.source !== 'cnmt' || !item.titleId
    || (item.type === 'update' && item.rawVersion === null))) return 'unverifiable';
  if (inventory.state !== 'ready' && inventory.state !== 'partial') return 'waiting';
  const allPresent = expected.every((item) => inventory.titles.some((installed) =>
    installed.titleId.toUpperCase() === item.titleId!.toUpperCase()
      && installed.type === item.type
      && (item.type !== 'update' || (installed.rawVersion !== null
        && installed.rawVersion >= item.rawVersion!))));
  if (!allPresent) return 'waiting';
  if (!before || before.deviceId !== deviceId || !['ready', 'partial'].includes(before.state))
    return 'unverifiable';
  // A title that was already present cannot prove its file's copy has ended.
  // A combined file only needs one newly visible title or newer patch to prove
  // DBI processed that physical package, while all its titles must be present.
  for (const path of selected) {
    const changed = expected.filter((item) => item.filePath === path).some((item) => {
      const previous = before.titles.find((title) => title.titleId.toUpperCase() === item.titleId!.toUpperCase()
        && title.type === item.type);
      if (item.type === 'update' && previous) return previous.rawVersion !== null
        && previous.rawVersion < item.rawVersion!;
      return !previous && before.state === 'ready';
    });
    if (!changed) return 'unverifiable';
  }
  return 'confirmed';
}
