import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { resolveAppPaths, ensureAppPaths, type AppPaths } from '@main/platform/paths';
import { CatalogService } from '@main/services/catalog.service';
import { VersionService } from '@main/services/version.service';
import {
  getGame,
  setFavorite,
  upsertGameByCleanedTitle,
} from '@main/repositories/games.repository';
import { getBaseFile, upsertBaseGameFile } from '@main/repositories/game-files.repository';
import { assignManualMatch, getUpdate, listUnmatchedUpdates, upsertUpdate } from '@main/repositories/updates.repository';
import { replaceScreenshots } from '@main/repositories/screenshots.repository';
import { recordInspection } from '@main/repositories/title-catalog.repository';
import { defaultAppSettings } from '@shared/schemas/settings';
import { TEMP_ROOT } from '../../setup/vitest.setup';

const TITLE_ID = '0100000000010000';

let db: AppDatabase;
let paths: AppPaths;
let catalog: CatalogService;
let hadesBaseFileId: number;
let zeldaBaseFileId: number;

function seed(): void {
  const hadesId = upsertGameByCleanedTitle(db, { displayTitle: 'Hades', cleanedTitle: 'Hades' });
  db.prepare(
    `UPDATE games SET description = ?, genres = ?, favorite = 1, metadata_provider = 'igdb',
       cover_image_url = 'https://images.igdb.com/igdb/image/upload/t_cover_big/hades.jpg' WHERE id = ?`,
  ).run('A rogue-like dungeon crawler', JSON.stringify(['Action', 'Indie']), hadesId);
  hadesBaseFileId = upsertBaseGameFile(db, {
    gameId: hadesId,
    filePath: 'C:/games/Hades.nsp',
    fileName: 'Hades.nsp',
    fileExtension: '.nsp',
    fileSize: 4_000_000_000,
    modifiedTime: 1000,
    fileType: 'NSP',
  });
  const hadesUpdate = upsertUpdate(db, {
    gameId: hadesId,
    filePath: 'C:/updates/Hades [v131072].nsp',
    fileName: 'Hades [v131072].nsp',
    detectedVersion: '131072',
    fileSize: 500_000_000,
    modifiedTime: 2000,
    matchConfidence: 0.99,
  });
  void hadesUpdate;
  replaceScreenshots(db, hadesId, ['https://images.igdb.com/igdb/image/upload/t_1080p/hades-1.jpg']);

  const zeldaId = upsertGameByCleanedTitle(db, { displayTitle: 'Zelda', cleanedTitle: 'Zelda' });
  db.prepare('UPDATE games SET needs_review = 1, genres = ? WHERE id = ?').run(JSON.stringify(['Adventure']), zeldaId);
  zeldaBaseFileId = upsertBaseGameFile(db, {
    gameId: zeldaId,
    filePath: `C:/games/Zelda [${TITLE_ID}][v65536].nsp`,
    fileName: `Zelda [${TITLE_ID}][v65536].nsp`,
    fileExtension: '.nsp',
    fileSize: 8_000_000_000,
    modifiedTime: 3000,
    fileType: 'NSP',
  });
  recordInspection(db, {
    path: `C:/games/Zelda [${TITLE_ID}][v65536].nsp`, size: 8_000_000_000,
    mtime: 3000, parserVersion: 1, keysRevision: 1, error: null,
    titles: [
      { titleId: TITLE_ID, baseTitleId: TITLE_ID, type: 'base', rawVersion: 0,
        name: null, publisher: null, source: 'cnmt' },
      { titleId: '0100000000010800', baseTitleId: TITLE_ID, type: 'update', rawVersion: 65536,
        name: null, publisher: null, source: 'cnmt' },
      { titleId: '0100000000011000', baseTitleId: TITLE_ID, type: 'dlc', rawVersion: 999999,
        name: 'Bonus content', publisher: null, source: 'cnmt' },
    ],
  });
  upsertUpdate(db, {
    gameId: null,
    filePath: 'C:/updates/Unknown [v131072].nsp',
    fileName: 'Unknown [v131072].nsp',
    detectedVersion: '131072',
    fileSize: 100_000_000,
    modifiedTime: 4000,
    matchConfidence: 0.12,
  });
}

beforeEach(async () => {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  paths = resolveAppPaths(dir, dir);
  ensureAppPaths(paths);
  db = openDatabase(paths.databaseFile);
  runMigrations(db, paths.databaseFile);
  seed();

  // A fresh version cache avoids any network access during the test run.
  writeFileSync(paths.versionsJsonFile, JSON.stringify({ [TITLE_ID]: { '65536': '2020-01-01', '131072': '2021-01-01' } }));
  writeFileSync(paths.versionsTxtFile, 'id|name|version\n');
  writeFileSync(join(paths.versionsCacheDir,'dlc-index.json'), JSON.stringify({
    refreshedAt:new Date().toISOString(), entries:Array.from({ length:100 },(_,i) => ({
      titleId:i===0 ? '0100000000011000' : i===1 ? '0100000000011001'
        : `${i.toString(16).padStart(16,'0').toUpperCase()}`,
      baseTitleId:TITLE_ID,name:i===0 ? 'Bonus content' : null,
    })),
    patchIds:['0100000000010800',...Array.from({ length:100 },(_,i) =>
      (i+1000).toString(16).padStart(16,'0').toUpperCase())],
  }));

  const versions = new VersionService({ db, paths });
  await versions.load();
  catalog = new CatalogService({
    db,
    versions,
    settings: () => defaultAppSettings(),
  });
});

afterEach(() => {
  closeDatabase(db);
});

describe('CatalogService.listGames', () => {
  it('returns summaries ordered by title with version state per game', () => {
    const page = catalog.listGames();
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.displayTitle)).toEqual(['Hades', 'Zelda']);

    const [hades, zelda] = page.items;
    expect(hades).toMatchObject({
      favorite: true,
      needsReview: false,
      updateCount: 1,
      hasNewerUpdate: false,
      genres: ['Action', 'Indie'],
      coverDisplayUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/hades.jpg',
    });
    expect(hades.baseFile?.filePath).toBe('C:/games/Hades.nsp');
    // The combined package contains a verified base ID and patch version.
    expect(zelda.hasNewerUpdate).toBe(true);
  });

  it('filters by prefix search, genre, favorites, review flag and update state', () => {
    expect(catalog.listGames({ search: 'Had' }).items.map((item) => item.displayTitle)).toEqual(['Hades']);
    expect(catalog.listGames({ search: 'Zelda' }).total).toBe(1);
    expect(catalog.listGames({ genre: 'Adventure' }).total).toBe(1);
    expect(catalog.listGames({ genre: 'All Genres' }).total).toBe(2);
    expect(catalog.listGames({ favoritesOnly: true }).total).toBe(1);
    expect(catalog.listGames({ needsReview: true }).total).toBe(1);
    expect(catalog.listGames({ needsUpdate: true }).items.map((item) => item.displayTitle)).toEqual(['Zelda']);
  });

  it('pages the filtered result set without losing the total', () => {
    const first = catalog.listGames({ limit: 1 });
    expect(first.total).toBe(2);
    expect(first.items.map((item) => item.displayTitle)).toEqual(['Hades']);
    const second = catalog.listGames({ limit: 1, offset: 1 });
    expect(second.total).toBe(2);
    expect(second.items.map((item) => item.displayTitle)).toEqual(['Zelda']);
  });
});

describe('CatalogService.getGame', () => {
  it('assembles files, grouped updates, screenshots, version status and install state', () => {
    const details = catalog.getGame(1);
    expect(details.displayTitle).toBe('Hades');
    expect(details.files.map((file) => file.fileName)).toEqual(['Hades.nsp']);
    expect(details.updates).toHaveLength(1);
    expect(details.updates[0]).toMatchObject({ group: 'Updates', manualMatch: false });
    expect(details.screenshots[0].displayUrl).toBe(
      'https://images.igdb.com/igdb/image/upload/t_1080p/hades-1.jpg',
    );
    // No title ID on the base file means no TitleDB comparison is possible.
    expect(details.versionStatus.kind).toBe('unknown');
    expect(details.installed).toBeNull();
  });

  it('reports an available update for a game with a known title ID', () => {
    const details = catalog.getGame(2);
    expect(details.versionStatus.kind).toBe('update-available');
    expect(details.versionStatus.localVersion).toBe(65536);
    expect(details.versionStatus.latest).toEqual({ version: 131072, releaseDate: '2021-01-01' });
    expect(details.versionStatus.newer.map((entry) => entry.version)).toEqual([131072]);
    expect(details.knownDlc?.find((entry) => entry.titleId === '0100000000011000'))
      .toMatchObject({ name:'Bonus content',filePresent:true });
    expect(details.knownDlc?.find((entry) => entry.titleId === '0100000000011001'))
      .toMatchObject({ name:'0100000000011001',nameSource:'title-id',filePresent:false });
  });

  it('uses a matching local DLC filename when TitleDB has no name', () => {
    const name = 'Zelda [DLC Hero Costume] [0100000000011001][v0].nsp';
    recordInspection(db, {
      path: `C:/updates/${name}`, size: 100, mtime: 5000, parserVersion: 1,
      keysRevision: 1, error: null,
      titles: [{ titleId: '0100000000011001', baseTitleId: TITLE_ID,
        type: 'dlc', rawVersion: 0, name: null, publisher: null, source: 'cnmt' }],
    });
    expect(catalog.getGame(2).knownDlc?.find((entry) => entry.titleId === '0100000000011001'))
      .toMatchObject({ name: 'Hero Costume', nameSource: 'filename', filePresent: true });
    expect(catalog.getGame(2).knownDlc?.find((entry) => entry.titleId === '0100000000011000'))
      .toMatchObject({ name: 'Bonus content', nameSource: 'titledb' });
  });

  it('prefers a specific package name over a filename and rejects a conflicting filename ID', () => {
    const wrongFile = 'Zelda [DLC Wrong Costume] [0100000000011002][v0].nsp';
    recordInspection(db, {
      path: `C:/updates/${wrongFile}`, size: 100, mtime: 5000, parserVersion: 1,
      keysRevision: 1, error: null,
      titles: [{ titleId: '0100000000011001', baseTitleId: TITLE_ID,
        type: 'dlc', rawVersion: 0, name: null, publisher: null, source: 'cnmt' }],
    });
    expect(catalog.getGame(2).knownDlc?.find((entry) => entry.titleId === '0100000000011001'))
      .toMatchObject({ name: '0100000000011001', nameSource: 'title-id', filePresent: true });

    const namedFile = 'Zelda [DLC Filename Costume] [0100000000011001][v0].nsp';
    recordInspection(db, {
      path: `C:/updates/${namedFile}`, size: 100, mtime: 5001, parserVersion: 1,
      keysRevision: 1, error: null,
      titles: [{ titleId: '0100000000011001', baseTitleId: TITLE_ID,
        type: 'dlc', rawVersion: 0, name: 'Package Costume', publisher: null, source: 'cnmt' }],
    });
    expect(catalog.getGame(2).knownDlc?.find((entry) => entry.titleId === '0100000000011001'))
      .toMatchObject({ name: 'Package Costume', nameSource: 'package', filePresent: true });
  });

  it('rejects unknown game ids with NOT_FOUND', () => {
    expect(() => catalog.getGame(999)).toThrowError(/No game with id 999/);
  });
});

describe('CatalogService mutations', () => {
  it('hides and restores games without deleting their files or metadata', () => {
    const before = catalog.getGame(1);
    catalog.setHidden(1, true);
    expect(catalog.listGames().items.map((game) => game.id)).not.toContain(1);
    expect(catalog.listGames({ hiddenOnly: true }).items.map((game) => game.id)).toContain(1);
    expect(catalog.getGame(1)).toMatchObject({ hidden: true, description: before.description });
    expect(getBaseFile(db, hadesBaseFileId)).not.toBeNull();

    catalog.setHidden(1, false);
    expect(catalog.listGames().items.map((game) => game.id)).toContain(1);
    expect(catalog.listGames({ hiddenOnly: true }).total).toBe(0);
  });

  it('toggles favorites and genre filters accordingly', () => {
    catalog.setFavorite(1, false);
    expect(catalog.listGames({ favoritesOnly: true }).total).toBe(0);
    expect(() => catalog.setFavorite(999, true)).toThrowError(/No game with id 999/);
  });

  it('marks a game as an unmatched update and drops it from the library', () => {
    catalog.markAsUpdate(1);

    expect(() => catalog.getGame(1)).toThrowError(/No game with id 1/);
    const unmatched = catalog.listUpdates({ unmatchedOnly: true });
    // Deleting the game releases its update too (foreign key sets game_id NULL).
    expect(unmatched.map((entry) => entry.fileName).sort()).toEqual([
      'Hades [v131072].nsp',
      'Hades.nsp',
      'Unknown [v131072].nsp',
    ]);
    expect(unmatched.every((entry) => entry.gameTitle === null)).toBe(true);
  });

  it('assigns unmatched updates to a game as a manual match', () => {
    const [unmatched] = catalog.listUpdates({ unmatchedOnly: true });
    catalog.assignUpdates({ gameId: 2, updateIds: [unmatched.id] });

    const record = getUpdate(db, unmatched.id);
    expect(record).toMatchObject({ gameId: 2, manualMatch: true, matchConfidence: 1 });
    expect(catalog.listUpdates({ unmatchedOnly: true })).toHaveLength(0);

    const all = catalog.listUpdates({});
    const assigned = all.find((entry) => entry.id === unmatched.id);
    expect(assigned?.gameTitle).toBe('Zelda');
  });

  it('unmatches updates back into the unmatched list', () => {
    const [update] = catalog.listUpdates({}).slice(0, 1);
    catalog.unmatchUpdates([update.id]);
    expect(getUpdate(db, update.id)).toMatchObject({ gameId: null, manualMatch: false });
    expect(listUnmatchedUpdates(db)).toHaveLength(2);
  });

  it('rejects assigning updates to a game that does not exist', () => {
    const [unmatched] = catalog.listUpdates({ unmatchedOnly: true });
    expect(() => catalog.assignUpdates({ gameId: 999, updateIds: [unmatched.id] })).toThrowError(/No game with id 999/);
  });

  it('keeps manually matched updates after a reassignment of the same rows', () => {
    const [unmatched] = catalog.listUpdates({ unmatchedOnly: true });
    assignManualMatch(db, [unmatched.id], 2);
    const stored = getUpdate(db, unmatched.id);
    if (!stored) throw new Error('expected the update row to exist');

    // A later automatic scan must not steal the manual match back.
    upsertUpdate(db, {
      gameId: 1,
      filePath: stored.filePath,
      fileName: stored.fileName,
      detectedVersion: stored.detectedVersion,
      fileSize: stored.fileSize,
      modifiedTime: stored.modifiedTime,
      matchConfidence: 0.99,
    });
    expect(getUpdate(db, unmatched.id)).toMatchObject({ gameId: 2, manualMatch: true });
  });

  it('resets the library including favorites and manual matches', () => {
    catalog.resetLibrary();
    expect(catalog.listGames().total).toBe(0);
    expect(getGame(db, 1)).toBeNull();
    expect(getBaseFile(db, hadesBaseFileId)).toBeNull();
    expect(getBaseFile(db, zeldaBaseFileId)).toBeNull();
    expect(() => setFavorite(db, 1, true)).toThrow();
  });
});
