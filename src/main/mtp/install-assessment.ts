import type { InstallPreviewItemDto, MtpInventoryDto } from '../../shared/types/domain';
import type { ContainedTitle } from '../repositories/title-catalog.repository';
import { consolePresence } from './console-status';

export function assessInstallFile(contents: ContainedTitle[], inventory: MtpInventoryDto,
  latestLocalPatch: number): Pick<InstallPreviewItemDto,
    'assessment' | 'reason' | 'selectedByDefault' | 'includesAlreadyInstalled'> {
  if (contents.length === 0 || contents.some((item) => item.provisional || !item.titleId
    || item.source !== 'cnmt' || item.inspectionError))
    return unknown('Package contents could not be verified from CNMT.');
  if (inventory.state !== 'ready' && inventory.state !== 'partial')
    return unknown('Switch inventory is unavailable; duplicates cannot be checked.');

  let needed = 0;
  let installed = 0;
  let uncertain = 0;
  for (const item of contents) {
    const presence = consolePresence(inventory, item.titleId);
    if (presence === 'unknown') { uncertain++; continue; }
    if (item.type === 'update') {
      if (item.rawVersion === null || !Number.isSafeInteger(item.rawVersion)) { uncertain++; continue; }
      const current = inventory.titles.find((title) => title.titleId.toUpperCase() === item.titleId!.toUpperCase());
      if (presence === 'installed' && current?.rawVersion === null) { uncertain++; continue; }
      if (presence === 'installed' && (current?.rawVersion ?? 0) >= item.rawVersion) installed++;
      else needed++;
    } else if (presence === 'installed') installed++;
    else needed++;
  }
  const containsOlderPatch = contents.some((item) => item.type === 'update'
    && item.rawVersion !== null && item.rawVersion < latestLocalPatch)
    && !contents.some((item) => item.type === 'update' && item.rawVersion === latestLocalPatch);
  if (containsOlderPatch) return { assessment: 'older-update',
    reason: 'This package contains an older patch than another verified library file.',
    selectedByDefault: false, includesAlreadyInstalled: installed > 0 };
  if (uncertain > 0) return { assessment: 'unknown',
    reason: 'Some contained titles or versions could not be compared. Select this file manually to install it.',
    selectedByDefault: false, includesAlreadyInstalled: installed > 0 };
  if (needed > 0) return { assessment: 'needed', reason: `${needed} contained title${needed === 1 ? '' : 's'} not current on the Switch.`,
    selectedByDefault: true, includesAlreadyInstalled: installed > 0 };
  return { assessment: 'already-installed', reason: 'All contained titles are already installed at this version or newer.',
    selectedByDefault: false, includesAlreadyInstalled: true };
}

function unknown(reason: string): Pick<InstallPreviewItemDto,
  'assessment' | 'reason' | 'selectedByDefault' | 'includesAlreadyInstalled'> {
  return { assessment: 'unknown', reason, selectedByDefault: false, includesAlreadyInstalled: false };
}
