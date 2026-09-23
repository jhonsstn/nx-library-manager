import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from './db/database';
import { runMigrations } from './db/migrations';
import { inspectInWorker } from './scanner/inspect-worker';
import { INSPECTOR_VERSION } from './scanner/package-inspector';
import { contentsForGame, recordInspection } from './repositories/title-catalog.repository';

/** Headless check used after Windows packaging. Exercises native SQLite, the
 * migration, and the packaged inspection worker without opening a window. */
export async function runPackagedSmoke(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(),'switch-catalog-smoke-'));
  const databaseFile = join(dir,'catalog.sqlite3');
  const packageFile = join(dir,'smoke.nsp');
  const titleId = '0100AABBCCDD0000';
  const cnmt = Buffer.alloc(0x40);
  cnmt.writeBigUInt64LE(BigInt(`0x${titleId}`),0);
  cnmt[0xC] = 0x80;
  cnmt.writeUInt16LE(0x10,0xE);
  const name = Buffer.from('smoke.cnmt\0');
  const pfs0 = Buffer.alloc(0x10+0x18+name.length+cnmt.length);
  pfs0.write('PFS0',0,'ascii');
  pfs0.writeUInt32LE(1,4);
  pfs0.writeUInt32LE(name.length,8);
  pfs0.writeBigUInt64LE(BigInt(cnmt.length),0x18);
  name.copy(pfs0,0x28);
  cnmt.copy(pfs0,0x28+name.length);
  writeFileSync(packageFile,pfs0);
  const db = openDatabase(databaseFile);
  try {
    runMigrations(db,databaseFile);
    const titles = await inspectInWorker(packageFile,null,new AbortController().signal);
    if (titles.length !== 1 || titles[0].titleId !== titleId || titles[0].source !== 'cnmt')
      throw new Error('Packaged inspector failed to identify the synthetic game');
    recordInspection(db,{ path:packageFile,size:pfs0.length,mtime:1,parserVersion:INSPECTOR_VERSION,
      keysRevision:0,titles,error:null });
    const game = db.prepare('SELECT game_id FROM titles WHERE title_id=?').get(titleId) as
      | { game_id: number } | undefined;
    if (!game || contentsForGame(db,game.game_id).length !== 1)
      throw new Error('Packaged catalog did not store the inspected title');
  } finally {
    closeDatabase(db);
    rmSync(dir,{ recursive:true,force:true });
  }
}
