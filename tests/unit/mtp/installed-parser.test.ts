import { describe, expect, it } from 'vitest';
import { parseInstalledFile, parseInstalledListing } from '@main/mtp/installed-parser';
import { consoleGameStatus, consolePresence, patchTitleId } from '@main/mtp/console-status';
import { assessInstallFile } from '@main/mtp/install-assessment';
import type { MtpInventoryDto } from '@shared/types/domain';
import type { ContainedTitle } from '@main/repositories/title-catalog.repository';

const BASE = '01007EF00011E000';
const PATCH = '01007EF00011E800';
const DLC = '01007EF00011F001';

function inventory(titles: MtpInventoryDto['titles'], state: MtpInventoryDto['state'] = 'ready'): MtpInventoryDto {
  return { state, deviceId: 'device-1', revision: 1, checkedAt: new Date().toISOString(),
    titles, unidentifiedFiles: state === 'partial' ? 1 : 0, message: null };
}

function content(type: ContainedTitle['type'], titleId: string, version: number | null = 0,
  filePath = 'game.nsp'): ContainedTitle {
  return { titleId, baseTitleId: BASE, type, name: type, rawVersion: version,
    source: 'cnmt', filePath, provisional: false, inspectionError: null };
}

describe('DBI installed-games listing', () => {
  it('parses explicit IDs and raw versions, including E000/E800 title families', () => {
    expect(parseInstalledFile({ folderName: 'Game', fileName: `Game [${BASE}][v0].nsp` }))
      .toEqual({ titleId: BASE, type: 'base', rawVersion: 0 });
    expect(parseInstalledFile({ folderName: 'Game', fileName: `Game [${PATCH}][v131072].nsp` }))
      .toEqual({ titleId: PATCH, type: 'update', rawVersion: 131072 });
    expect(parseInstalledFile({ folderName: 'Game', fileName: `Pack [${DLC}].nsp` }))
      .toEqual({ titleId: DLC, type: 'dlc', rawVersion: null });
    expect(parseInstalledFile({ folderName: 'Game', fileName: `Combined [${BASE}][${DLC}].nsp` }))
      .toBeNull();
    expect(patchTitleId(BASE)).toBe(PATCH);
    expect(consolePresence(inventory([{ titleId: BASE, type: 'base', rawVersion: 0 }]),
      BASE.toLowerCase())).toBe('installed');
  });

  it('marks unknown or corrupt names partial instead of claiming absence', () => {
    const parsed = parseInstalledListing({ state: 'ready', deviceId: 'device-1', unidentifiedFiles: 0,
      message: null, files: [
        { folderName: 'Game', fileName: `Game [${BASE}].nsp` },
        { folderName: 'Game', fileName: 'Unknown DLC.nsp' },
        { folderName: 'Game', fileName: `Bad [${PATCH}][v99999999999999999999].nsp` },
      ] });
    expect(parsed).toMatchObject({ complete: false, unidentifiedFiles: 2,
      titles: [{ titleId: BASE, type: 'base', rawVersion: null }] });
    expect(consolePresence(inventory(parsed.titles, 'partial'), DLC)).toBe('unknown');
    expect(parseInstalledListing({ state: 'ready', deviceId: 'device-1', unidentifiedFiles: 0,
      message: null, files: [] }).complete).toBe(false);
  });

  it('keeps DLC versions out of patch comparisons', () => {
    const status = consoleGameStatus(inventory([
      { titleId: BASE, type: 'base', rawVersion: 0 },
      { titleId: PATCH, type: 'update', rawVersion: 65536 },
      { titleId: DLC, type: 'dlc', rawVersion: 999999 },
    ]), BASE, [content('base', BASE), content('update', PATCH, 131072)]);
    expect(status).toEqual({ base: 'installed', update: 'installed', updateVersion: 65536,
      localContentReady: true });
    expect(consoleGameStatus(inventory([{ titleId: PATCH, type: 'update', rawVersion: null }]),
      BASE, [content('base', BASE)])).toMatchObject({ base: 'not-installed',
        update: 'installed', updateVersion: null, localContentReady: true });
  });

  it('recommends needed combined files once, and skips fully installed or older files', () => {
    const live = inventory([{ titleId: BASE, type: 'base', rawVersion: 0 },
      { titleId: PATCH, type: 'update', rawVersion: 65536 }]);
    expect(assessInstallFile([content('base', BASE), content('update', PATCH, 131072)], live, 131072))
      .toMatchObject({ assessment: 'needed', selectedByDefault: true, includesAlreadyInstalled: true });
    expect(assessInstallFile([content('base', BASE)], live, 131072).assessment).toBe('already-installed');
    expect(assessInstallFile([content('update', PATCH, 32768)], live, 131072).assessment).toBe('older-update');
    expect(assessInstallFile([content('dlc', DLC)], live, 131072).assessment).toBe('needed');
    expect(assessInstallFile([content('dlc', DLC)], inventory(live.titles, 'partial'), 131072).assessment)
      .toBe('unknown');
    expect(assessInstallFile([content('base', BASE), content('update', PATCH, null)],
      inventory([]), 131072)).toMatchObject({ assessment: 'unknown', selectedByDefault: false });
    expect(assessInstallFile([content('dlc', DLC), content('update', PATCH, 32768)],
      inventory([]), 131072)).toMatchObject({ assessment: 'older-update', selectedByDefault: false });
  });
});
