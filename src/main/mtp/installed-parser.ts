import type { MtpInstalledListing, MtpVirtualFile } from './mtp.adapter';
import type { MtpInstalledTitleDto } from '../../shared/types/domain';

const ID = /\[([0-9a-f]{16})\]/gi;
const VERSION = /\[v(\d+)\]/gi;

/** DBI virtual file names are evidence of installed content, never a local package to open. */
export function parseInstalledFile(file: MtpVirtualFile): MtpInstalledTitleDto | null {
  if (!/\.nsp$/i.test(file.fileName)) return null;
  const ids = [...file.fileName.matchAll(ID)];
  if (ids.length !== 1) return null;
  const id = ids[0][1].toUpperCase();
  const suffix = BigInt(`0x${id}`) & 0xFFFn;
  const type = suffix === 0n ? 'base' : suffix === 0x800n ? 'update' : 'dlc';
  const versions = [...file.fileName.matchAll(VERSION)];
  if (versions.length > 1) return null;
  const versionText = versions[0]?.[1];
  const number = versionText === undefined ? null : Number(versionText);
  if (versionText !== undefined && (!Number.isSafeInteger(number) || number! < 0)) return null;
  return { titleId: id, type, rawVersion: number };
}

export function parseInstalledListing(listing: MtpInstalledListing): {
  titles: MtpInstalledTitleDto[]; unidentifiedFiles: number; complete: boolean;
} {
  let unidentifiedFiles = listing.unidentifiedFiles;
  const byId = new Map<string, MtpInstalledTitleDto>();
  for (const file of listing.files) {
    const item = parseInstalledFile(file);
    if (!item) { unidentifiedFiles++; continue; }
    const current = byId.get(item.titleId);
    if (!current || (item.rawVersion ?? -1) > (current.rawVersion ?? -1)) byId.set(item.titleId, item);
  }
  // An empty virtual folder cannot validate DBI's filename layout. Until at
  // least one real record has matched it, an absence claim would be a guess.
  return { titles: [...byId.values()], unidentifiedFiles,
    complete: listing.state === 'ready' && unidentifiedFiles === 0 && byId.size > 0 };
}
