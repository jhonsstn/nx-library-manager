import { describe, expect, it } from 'vitest';
import { verifyMtpBatch } from '@renderer/features/install/install-batch-status';
import type { ContainedTitleDto, MtpInventoryDto } from '@shared/types/domain';

const path = 'C:/games/Combined.nsp';
const contents: ContainedTitleDto[] = [
  { filePath: path, titleId: '0100000000010000', baseTitleId: '0100000000010000',
    type: 'base', name: 'Game', rawVersion: 0, source: 'cnmt', provisional: false, inspectionError: null },
  { filePath: path, titleId: '0100000000010800', baseTitleId: '0100000000010000',
    type: 'update', name: 'Game', rawVersion: 131072, source: 'cnmt', provisional: false, inspectionError: null },
  { filePath: path, titleId: '0100000000011001', baseTitleId: '0100000000010000',
    type: 'dlc', name: 'Pack', rawVersion: 0, source: 'cnmt', provisional: false, inspectionError: null },
];
const inventory: MtpInventoryDto = { state: 'partial', deviceId: 'switch-1', revision: 8,
  checkedAt: '2026-09-24T12:00:00Z', unidentifiedFiles: 1, message: null,
  titles: contents.map((item) => ({ titleId: item.titleId!, type: item.type, rawVersion: item.rawVersion })) };
const before: MtpInventoryDto = { ...inventory, state: 'ready', revision: 7, titles: [] };

describe('MTP batch verification', () => {
  it('confirms exact base, update version, and DLC IDs in a partial scan', () => {
    expect(verifyMtpBatch([path], contents, inventory, before, 'switch-1')).toBe('confirmed');
    expect(verifyMtpBatch([path], contents, inventory, { ...before, state: 'partial',
      titles: inventory.titles.filter((item) => item.type !== 'update').concat({
        titleId: '0100000000010800', type: 'update', rawVersion: 65536,
      }) }, 'switch-1')).toBe('confirmed');
  });

  it('waits when a title or required update version is absent', () => {
    expect(verifyMtpBatch([path], contents, { ...inventory, titles: inventory.titles.slice(0, 2) }, before, 'switch-1'))
      .toBe('waiting');
    expect(verifyMtpBatch([path], contents, { ...inventory, titles: inventory.titles.map((item) =>
      item.type === 'update' ? { ...item, rawVersion: 65536 } : item) }, before, 'switch-1')).toBe('waiting');
  });

  it('never confirms a different Switch or an unverified selected file', () => {
    expect(verifyMtpBatch([path], contents, inventory, before, 'switch-2')).toBe('waiting');
    expect(verifyMtpBatch([path, 'C:/games/Unknown.nsp'], contents, inventory, before, 'switch-1'))
      .toBe('unverifiable');
    expect(verifyMtpBatch([path], contents.map((item) => item.type === 'dlc'
      ? { ...item, provisional: true } : item), inventory, before, 'switch-1')).toBe('unverifiable');
    expect(verifyMtpBatch([path], contents, inventory, inventory, 'switch-1')).toBe('unverifiable');
  });
});
