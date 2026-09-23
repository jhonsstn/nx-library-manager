import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { ScannerService } from '@main/services/scanner.service';
import { cachedInspection } from '@main/repositories/title-catalog.repository';
import { INSPECTOR_VERSION } from '@main/scanner/package-inspector';
import { TEMP_ROOT } from '../../setup/vitest.setup';

function cnmt(id: string, type: number, parent: string, version: number): Buffer {
  const result = Buffer.alloc(0x40);
  result.writeBigUInt64LE(BigInt(`0x${id}`),0);
  result.writeUInt32LE(version,8);
  result[0xC] = type;
  result.writeUInt16LE(type === 0x80 ? 0x10 : 0x18,0xE);
  result.writeBigUInt64LE(BigInt(`0x${parent}`),0x20);
  return result;
}

function packageFile(path: string, entries: Array<[string,Buffer]>): void {
  const names = Buffer.from(entries.map(([name]) => `${name}\0`).join(''));
  const offset = 0x10+entries.length*0x18+names.length;
  const data = Buffer.alloc(offset+entries.reduce((sum,[,body]) => sum+body.length,0));
  data.write('PFS0',0,'ascii');
  data.writeUInt32LE(entries.length,4);
  data.writeUInt32LE(names.length,8);
  names.copy(data,0x10+entries.length*0x18);
  let contentAt = 0;
  let nameAt = 0;
  entries.forEach(([name,body],index) => {
    const at = 0x10+index*0x18;
    data.writeBigUInt64LE(BigInt(contentAt),at);
    data.writeBigUInt64LE(BigInt(body.length),at+8);
    data.writeUInt32LE(nameAt,at+16);
    body.copy(data,offset+contentAt);
    contentAt += body.length;
    nameAt += Buffer.byteLength(name)+1;
  });
  writeFileSync(path,data);
}

describe('scanner title inspection', () => {
  it('records combined content and keeps same-name games with distinct IDs across rescans', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT,'inspect-'));
    const folder = join(dir,'games');
    const other = join(folder,'other');
    mkdirSync(other,{ recursive:true });
    const firstId = '0100AABBCCDD0000';
    const secondId = '0100BBCCDDEE0000';
    const firstPath = join(folder,'Example.nsp');
    const secondPath = join(other,'Example.nsp');
    packageFile(firstPath,[
      ['base.cnmt',cnmt(firstId,0x80,firstId,0)],
      ['patch.cnmt',cnmt('0100AABBCCDD0800',0x81,firstId,65536)],
      ['dlc.cnmt',cnmt('0100AABBCCDD1000',0x82,firstId,0)],
    ]);
    packageFile(secondPath,[['base.cnmt',cnmt(secondId,0x80,secondId,0)]]);
    const dbFile = join(dir,'catalog.db');
    const db = openDatabase(dbFile);
    try {
      runMigrations(db,dbFile);
      const scanner = new ScannerService({ db });
      await scanner.start({ baseFolder:folder,recursive:true });
      await scanner.whenIdle();
      const titles = db.prepare("SELECT title_id,game_id,type FROM titles WHERE provisional=0 ORDER BY title_id")
        .all() as Array<{ title_id:string; game_id:number; type:string }>;
      expect(titles).toHaveLength(4);
      expect(new Set(titles.filter((row) => row.type === 'base').map((row) => row.game_id)).size).toBe(2);
      expect(db.prepare('SELECT count(*) AS n FROM local_files').get()).toMatchObject({ n:2 });
      expect(db.prepare('SELECT count(*) AS n FROM file_titles').get()).toMatchObject({ n:4 });
      const originalGameId = titles.find((row) => row.title_id === firstId)?.game_id;
      db.prepare("UPDATE games SET favorite=1, metadata_locked=1, display_title='My title' WHERE id=?")
        .run(originalGameId);
      db.prepare("UPDATE titles SET display_name='My title',name_source='manual' WHERE title_id=?")
        .run(firstId);
      utimesSync(firstPath, new Date(Date.now()+3000), new Date(Date.now()+3000));
      await scanner.start({ baseFolder:folder,recursive:true });
      await scanner.whenIdle();
      expect(db.prepare('SELECT favorite,metadata_locked,display_title FROM games WHERE id=?').get(originalGameId))
        .toMatchObject({ favorite:1,metadata_locked:1,display_title:'My title' });
      expect(db.prepare('SELECT display_name,name_source FROM titles WHERE title_id=?').get(firstId))
        .toMatchObject({ display_name:'My title',name_source:'manual' });
      expect(db.prepare('SELECT count(*) AS n FROM games').get()).toMatchObject({ n:2 });
      const stat = (await import('node:fs')).statSync(firstPath);
      expect(cachedInspection(db,firstPath,stat.size,stat.mtimeMs,INSPECTOR_VERSION,0)).toBe(true);
    } finally { closeDatabase(db); }
  });
});
