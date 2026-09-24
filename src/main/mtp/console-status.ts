import type { MtpInventoryDto, SwitchGameStatusDto, SwitchPresence } from '../../shared/types/domain';
import type { ContainedTitle } from '../repositories/title-catalog.repository';

export function consolePresence(inventory: MtpInventoryDto, titleId: string | null | undefined): SwitchPresence {
  if (!titleId) return 'unknown';
  if (inventory.titles.some((title) => title.titleId.toUpperCase() === titleId.toUpperCase())) return 'installed';
  return inventory.state === 'ready' ? 'not-installed' : 'unknown';
}

export function patchTitleId(baseTitleId: string): string {
  return (BigInt(`0x${baseTitleId}`) + 0x800n).toString(16).toUpperCase().padStart(16, '0');
}

export function consoleGameStatus(inventory: MtpInventoryDto, baseTitleId: string,
  contents: ContainedTitle[]): SwitchGameStatusDto | null {
  if (inventory.state === 'disconnected') return null;
  const patchId = baseTitleId ? patchTitleId(baseTitleId) : null;
  const patch = inventory.titles.find((title) => title.titleId === patchId && title.type === 'update');
  const base = consolePresence(inventory, baseTitleId);
  const update = consolePresence(inventory, patchId);
  const localPatch = Math.max(0, ...contents.filter((item) => item.type === 'update'
    && item.baseTitleId === baseTitleId && !item.provisional && item.source === 'cnmt'
    && item.rawVersion !== null).map((item) => item.rawVersion as number));
  const localDlcMissing = contents.some((item) => item.type === 'dlc' && !item.provisional
    && item.source === 'cnmt'
    && item.titleId && consolePresence(inventory, item.titleId) === 'not-installed');
  const localContentReady = inventory.state === 'ready' && Boolean(baseTitleId) && (
    base === 'not-installed' ||
    (localPatch > 0 && (update === 'not-installed' || (patch?.rawVersion !== null
      && patch?.rawVersion !== undefined && localPatch > patch.rawVersion))) || localDlcMissing);
  return { base, update, updateVersion: patch?.rawVersion ?? null, localContentReady };
}
