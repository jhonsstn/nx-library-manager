import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileDlcIndex, DlcIndexCache, extractPatchIds } from '@main/versions/dlc-index';
import { TEMP_ROOT } from '../../setup/vitest.setup';

describe('TitleDB known DLC index', () => {
  it('joins DLC to its parent and uses Title IDs when no catalog name exists', () => {
    const entries = compileDlcIndex({
      '0100AABBCCDD0001': { '0': { titleType:130,otherApplicationId:'0100AABBCCDD0000' } },
      '0100AABBCCDD0800': { '65536': { titleType:129,otherApplicationId:'0100AABBCCDD0000' } },
      '0100AABBCCDD0000': { '0': { titleType:128,otherApplicationId:'0100AABBCCDD0800' } },
      '0100AABBCCDD0002': { '0': { titleType:130,otherApplicationId:'0100AABBCCDD0000' } },
    },{
      '70010000000025': { id:'0100AABBCCDD0001',name:'Bonus Pack' },
    });
    expect(entries).toEqual([
      { titleId:'0100AABBCCDD0001',baseTitleId:'0100AABBCCDD0000',name:'Bonus Pack' },
      { titleId:'0100AABBCCDD0002',baseTitleId:'0100AABBCCDD0000',name:null },
    ]);
    expect(extractPatchIds({
      '0100AABBCCDD0800': { '65536': { titleType:129 } },
      '0100AABBCCDD1800': { '0': { titleType:130 } },
    })).toEqual(['0100AABBCCDD0800']);
  });

  it('reports loading until the first index download finishes', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dlc-index-'));
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      titleId: index.toString(16).padStart(16, '0').toUpperCase(),
      baseTitleId: '0100000000010000',
      name: null,
    }));
    const patchIds = Array.from({ length: 1000 }, (_, index) =>
      (index + 1000).toString(16).padStart(16, '0').toUpperCase());
    let finishDownload!: (data: { entries: typeof entries; patchIds: string[] }) => void;
    const cache = new DlcIndexCache(dir, () => new Promise((resolve) => { finishDownload = resolve; }));

    expect(cache.availability).toBe('loading');
    const refresh = cache.refresh();
    expect(cache.availability).toBe('loading');
    finishDownload({ entries, patchIds });
    await expect(refresh).resolves.toBe(true);
    expect(cache.availability).toBe('ready');
    expect(new DlcIndexCache(dir).loadCached()?.patchIds).toHaveLength(1000);
  });

  it('reports unavailable after a failed first download', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'dlc-index-'));
    const cache = new DlcIndexCache(dir, async () => { throw new Error('offline'); });

    await expect(cache.refresh()).rejects.toThrow('offline');
    expect(cache.availability).toBe('unavailable');
    expect(cache.patchIds).toBeNull();
  });
});
