import { describe, expect, it } from 'vitest';
import { compileDlcIndex, extractPatchIds } from '@main/versions/dlc-index';

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
});
