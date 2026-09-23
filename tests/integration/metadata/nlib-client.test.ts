import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { NlibClient, mapNlibRecord } from '@main/metadata/nlib.client';
import { TEMP_ROOT } from '../../setup/vitest.setup';

const ID = '0100AABBCCDD0000';
const raw = {
  id: ID, name: 'Example', description: 'Description', publisher: 'Publisher',
  developer: 'Developer', releaseDate: '2024-01-02', category: ['Action'],
  nsuId: '70010000000025', icon: `http://api.nlib.cc/nx/${ID}/icon`,
  banner: `http://api.nlib.cc/nx/${ID}/banner`,
  screens: { screenshots: [`http://api.nlib.cc/nx/${ID}/screen/1`] },
};

describe('Nlib exact-ID catalog', () => {
  it('maps all supported fields and upgrades media URLs to HTTPS', () => {
    expect(mapNlibRecord(ID,raw)).toMatchObject({ provider:'nlib',providerId:ID,
      title:'Example',description:'Description',publisher:'Publisher',developer:'Developer',
      releaseDate:'2024-01-02',genres:['Action'],nsuId:'70010000000025',
      coverImageUrl:`https://api.nlib.cc/nx/${ID}/icon`,
      bannerUrl:`https://api.nlib.cc/nx/${ID}/banner`,
      screenshots:[`https://api.nlib.cc/nx/${ID}/screen/1`] });
    expect(mapNlibRecord('FFFFFFFFFFFFFFFF',raw)).toBeNull();
  });

  it('caches exact hits and 404s, retaining a validated stale hit during an outage', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT,'nlib-'));
    const file = join(dir,'library.sqlite3');
    const db = openDatabase(file);
    try {
      runMigrations(db,file);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(raw));
      const client = new NlibClient(db,fetchImpl);
      expect((await client.lookup(ID))?.title).toBe('Example');
      expect((await client.lookup(ID))?.title).toBe('Example');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      db.prepare("UPDATE metadata_cache SET cached_at='2020-01-01' WHERE provider='nlib'").run();
      fetchImpl.mockRejectedValueOnce(new Error('offline'));
      expect((await client.lookup(ID))?.title).toBe('Example');
      fetchImpl.mockResolvedValueOnce(new Response(null,{ status:404 }));
      expect(await client.lookup('0100AABBCCDD1000')).toBeNull();
      expect(await client.lookup('0100AABBCCDD1000')).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally { closeDatabase(db); }
  });
});
