import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMP_ROOT } from '../../setup/vitest.setup';
import type { ScanInput } from '@shared/contracts/api';
import { TITLE_ID_MATCH_CONFIDENCE } from '@shared/constants';
import type { ScanCompletedDto, ScanProgressDto } from '@shared/types/domain';
import { closeDatabase, openDatabase, type AppDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { getGame, listGames, setFavorite } from '@main/repositories/games.repository';
import { listGameFiles, type GameFileRecord } from '@main/repositories/game-files.repository';
import { assignManualMatch, listAllUpdates, type UpdateRecord } from '@main/repositories/updates.repository';
import { ScannerService } from '@main/services/scanner.service';

const ALPHA_BASE = 'Alpha Game [0100000000000000][v0].nsp';
const BETA_BASE = 'Beta Game [0100000000010000][v0].nsz';
const GAMMA_BASE = 'Gamma Game [0100000000020000][v0].xci';
const ALPHA_UPDATE = 'Alpha Game [0100000000000800][v65536].nsp';
const ORPHAN_UPDATE = 'Unrelated Expansive Title [0100000000FF0800][v1].nsz';

const PHASE_ORDER = ['discovering', 'classifying', 'matching', 'reconciling'] as const;

let workdir: string;
let baseDir: string;
let updatesDir: string;
let dbFile: string;
let db: AppDatabase;
let service: ScannerService;
let progress: ScanProgressDto[];
let completions: ScanCompletedDto[];
let waiting: Array<(summary: ScanCompletedDto) => void>;

function place(directory: string, fileName: string, contents: Buffer): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, contents);
  return path;
}

function createLibrary(): void {
  place(baseDir, ALPHA_BASE, Buffer.from('placeholder alpha base payload'));
  place(baseDir, BETA_BASE, Buffer.from('placeholder beta base payload'));
  place(baseDir, GAMMA_BASE, Buffer.from('placeholder gamma base payload'));
  place(updatesDir, ALPHA_UPDATE, Buffer.from('placeholder alpha update payload'));
  place(updatesDir, ORPHAN_UPDATE, Buffer.from('placeholder orphan update payload'));
}

/** A tree wide enough that a scan is still walking when the test cancels it. */
function createWideTree(directory: string, directoryCount: number): number {
  let files = 0;
  for (let folder = 0; folder < directoryCount; folder += 1) {
    for (let index = 0; index < 3; index += 1) {
      place(join(directory, `folder-${folder}`), `Game ${folder} ${index}.nsp`, Buffer.from(`payload ${folder} ${index}`));
      files += 1;
    }
  }
  return files;
}

function createService(options: {
  onProgress: (event: ScanProgressDto) => void;
  onCompleted: (event: ScanCompletedDto) => void;
  now?: () => number;
}): ScannerService {
  return new ScannerService({ db, ...options });
}

function nextCompletion(): Promise<ScanCompletedDto> {
  const { promise, resolve } = Promise.withResolvers<ScanCompletedDto>();
  waiting.push(resolve);
  return promise;
}

async function runScan(input: ScanInput): Promise<{ jobId: string; summary: ScanCompletedDto }> {
  const completion = nextCompletion();
  const { jobId } = await service.start(input);
  return { jobId, summary: await completion };
}

function gameByTitle(title: string): ReturnType<typeof listGames>[number] {
  const game = listGames(db).find((row) => row.displayTitle === title);
  if (!game) throw new Error(`No game titled "${title}" in the catalog`);
  return game;
}

function updateByName(fileName: string): UpdateRecord {
  const update = listAllUpdates(db).find((row) => row.fileName === fileName);
  if (!update) throw new Error(`No update named "${fileName}" in the catalog`);
  return update;
}

function gameFileFor(gameId: number): GameFileRecord {
  const files = listGameFiles(db, gameId);
  if (files.length === 0) throw new Error(`Game ${gameId} has no base file`);
  return files[0];
}

function countRows(sql: string): number {
  return (db.prepare(sql).get() as { total: number }).total;
}

/** Spec 05 reconciliation invariants, asserted after every scan. */
function expectConsistentDatabase(): void {
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(countRows('SELECT COUNT(*) AS total FROM (SELECT file_path FROM game_files GROUP BY file_path HAVING COUNT(*) > 1)')).toBe(0);
  expect(countRows('SELECT COUNT(*) AS total FROM (SELECT file_path FROM updates GROUP BY file_path HAVING COUNT(*) > 1)')).toBe(0);
  expect(countRows('SELECT COUNT(*) AS total FROM game_files f LEFT JOIN games g ON g.id = f.game_id WHERE g.id IS NULL')).toBe(0);
  expect(countRows('SELECT COUNT(*) AS total FROM games g WHERE NOT EXISTS (SELECT 1 FROM game_files f WHERE f.game_id = g.id)')).toBe(0);
  expect(countRows('SELECT COUNT(*) AS total FROM updates u LEFT JOIN games g ON g.id = u.game_id WHERE u.game_id IS NOT NULL AND g.id IS NULL')).toBe(0);
}

beforeEach(() => {
  workdir = mkdtempSync(join(TEMP_ROOT, 'scanner-service-'));
  baseDir = join(workdir, 'base');
  updatesDir = join(workdir, 'updates');
  dbFile = join(workdir, 'catalog.sqlite');
  db = openDatabase(dbFile);
  runMigrations(db, dbFile);

  progress = [];
  completions = [];
  waiting = [];
  service = createService({
    onProgress: (event) => progress.push(event),
    onCompleted: (event) => {
      completions.push(event);
      waiting.shift()?.(event);
    },
  });
  createLibrary();
});

afterEach(() => {
  closeDatabase(db);
  rmSync(workdir, { recursive: true, force: true });
});

describe('ScannerService', () => {
  it('classifies base files, matches updates by title ID and reports the same counts', async () => {
    const { jobId, summary } = await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });

    expect(summary).toMatchObject({
      jobId,
      cancelled: false,
      checkedFiles: 5,
      gamesFound: 3,
      updatesFound: 2,
      unmatchedUpdates: 1,
    });
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(listGames(db).map((game) => game.displayTitle)).toEqual(['Alpha Game', 'Beta Game', 'Gamma Game']);

    const alpha = gameByTitle('Alpha Game');
    const alphaFile = gameFileFor(alpha.id);
    expect(alphaFile).toMatchObject({
      filePath: join(baseDir, ALPHA_BASE),
      fileName: ALPHA_BASE,
      fileExtension: '.nsp',
      fileType: 'NSP',
      fileSize: statSync(join(baseDir, ALPHA_BASE)).size,
      isBaseGame: true,
    });
    expect(gameFileFor(gameByTitle('Beta Game').id)).toMatchObject({ fileExtension: '.nsz', fileType: 'NSZ' });
    expect(gameFileFor(gameByTitle('Gamma Game').id)).toMatchObject({ fileExtension: '.xci', fileType: 'XCI' });

    const matched = updateByName(ALPHA_UPDATE);
    expect(matched.gameId).toBe(alpha.id);
    expect(matched.matchConfidence).toBeCloseTo(TITLE_ID_MATCH_CONFIDENCE, 10);
    expect(matched.detectedVersion).toBe('65536');
    expect(matched.fileSize).toBe(statSync(join(updatesDir, ALPHA_UPDATE)).size);
    expect(updateByName(ORPHAN_UPDATE).gameId).toBeNull();
    expect(countRows('SELECT COUNT(*) AS total FROM updates WHERE game_id IS NULL')).toBe(1);
    expectConsistentDatabase();
  });

  it('splits a single folder into base games and updates', async () => {
    const mixedDir = join(workdir, 'mixed');
    place(mixedDir, ALPHA_BASE, Buffer.from('placeholder base payload'));
    place(mixedDir, ALPHA_UPDATE, Buffer.from('placeholder update payload'));

    const { summary } = await runScan({ baseFolder: mixedDir });

    expect(summary).toMatchObject({ gamesFound: 1, updatesFound: 1, unmatchedUpdates: 0, checkedFiles: 2 });
    expect(updateByName(ALPHA_UPDATE).gameId).toBe(gameByTitle('Alpha Game').id);
    expectConsistentDatabase();
  });

  it('preserves favourites, metadata and manual matches while refreshing file sizes', async () => {
    await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });
    const alpha = gameByTitle('Alpha Game');
    setFavorite(db, alpha.id, true);
    db.prepare('UPDATE games SET description = ?, metadata_provider = ? WHERE id = ?').run(
      'A preserved description',
      'igdb',
      alpha.id,
    );
    const orphan = updateByName(ORPHAN_UPDATE);
    assignManualMatch(db, [orphan.id], alpha.id);

    const alphaPath = join(baseDir, ALPHA_BASE);
    const orphanPath = join(updatesDir, ORPHAN_UPDATE);
    appendFileSync(alphaPath, ' grown');
    appendFileSync(orphanPath, ' grown');

    const { summary } = await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });

    expect(summary).toMatchObject({ gamesFound: 3, updatesFound: 2, unmatchedUpdates: 0 });
    const rescanned = gameByTitle('Alpha Game');
    expect(rescanned.id).toBe(alpha.id);
    expect(rescanned.favorite).toBe(true);
    expect(rescanned.description).toBe('A preserved description');
    expect(rescanned.metadataProvider).toBe('igdb');
    expect(gameFileFor(alpha.id).fileSize).toBe(statSync(alphaPath).size);

    const manual = updateByName(ORPHAN_UPDATE);
    expect(manual.manualMatch).toBe(true);
    expect(manual.gameId).toBe(alpha.id);
    expect(manual.matchConfidence).toBe(1);
    expect(manual.fileSize).toBe(statSync(orphanPath).size);
    expect(listGames(db)).toHaveLength(3);
    expectConsistentDatabase();
  });

  it('drops rows for deleted files and keeps rows outside the scanned roots', async () => {
    const otherRoot = join(workdir, 'other-library');
    place(otherRoot, 'Elsewhere Game [0100000000030000][v0].nsp', Buffer.from('placeholder elsewhere payload'));
    await runScan({ baseFolder: otherRoot });

    await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });
    const beta = gameByTitle('Beta Game');
    unlinkSync(join(baseDir, BETA_BASE));
    unlinkSync(join(updatesDir, ALPHA_UPDATE));

    await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });

    expect(getGame(db, beta.id)).toBeNull();
    expect(listGameFiles(db, beta.id)).toEqual([]);
    expect(listGames(db).map((game) => game.displayTitle)).toEqual(['Alpha Game', 'Elsewhere Game', 'Gamma Game']);
    expect(listAllUpdates(db).map((update) => update.fileName)).toEqual([ORPHAN_UPDATE]);
    expectConsistentDatabase();
  });

  it('clears favourites and manual matches when resetLibrary is requested', async () => {
    await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });
    const alpha = gameByTitle('Alpha Game');
    setFavorite(db, alpha.id, true);
    db.prepare('UPDATE games SET description = ? WHERE id = ?').run('discarded by reset', alpha.id);
    assignManualMatch(db, [updateByName(ORPHAN_UPDATE).id], alpha.id);

    await runScan({ baseFolder: baseDir, updatesFolder: updatesDir, resetLibrary: true });

    const rescanned = gameByTitle('Alpha Game');
    expect(rescanned.favorite).toBe(false);
    expect(rescanned.description).toBe('');
    expect(listAllUpdates(db).every((update) => !update.manualMatch)).toBe(true);
    expect(updateByName(ORPHAN_UPDATE).gameId).toBeNull();
    expectConsistentDatabase();
  });

  it('returns the running job id for the same scope and rejects a different scope', async () => {
    const wideRoot = join(workdir, 'wide-library');
    createWideTree(wideRoot, 60);
    const completion = nextCompletion();

    const first = await service.start({ baseFolder: wideRoot });
    expect(await service.start({ baseFolder: wideRoot })).toEqual({ jobId: first.jobId });
    await expect(service.start({ baseFolder: baseDir })).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });

    await service.cancel(first.jobId);
    const summary = await completion;
    expect(summary).toMatchObject({ jobId: first.jobId, cancelled: true });
    expectConsistentDatabase();
  });

  it('cancels a running scan and still produces a complete catalog afterwards', async () => {
    const wideRoot = join(workdir, 'cancel-library');
    const fileCount = createWideTree(wideRoot, 60);
    const completion = nextCompletion();

    const { jobId } = await service.start({ baseFolder: wideRoot });
    await service.cancel(jobId);
    const summary = await completion;

    expect(summary.cancelled).toBe(true);
    // Cancelled during discovery: nothing was written, so the catalog is intact.
    expect(summary.gamesFound).toBe(0);
    expect(summary.updatesFound).toBe(0);
    expect(await service.getStatus(jobId)).toMatchObject({ jobId, running: false, cancelled: true, summary });
    expectConsistentDatabase();

    // Unknown and already finished jobs are no-ops.
    await expect(service.cancel('does-not-exist')).resolves.toBeUndefined();
    await expect(service.cancel(jobId)).resolves.toBeUndefined();

    const { summary: full } = await runScan({ baseFolder: wideRoot });
    expect(full.cancelled).toBe(false);
    expect(full.gamesFound).toBe(fileCount);
    expectConsistentDatabase();
  });

  it('cancels the active scan on shutdown and refuses further scans', async () => {
    const wideRoot = join(workdir, 'shutdown-library');
    createWideTree(wideRoot, 60);
    const completion = nextCompletion();

    const { jobId } = await service.start({ baseFolder: wideRoot });
    service.shutdown();
    const summary = await completion;

    expect(summary.cancelled).toBe(true);
    expect(summary.gamesFound).toBe(0);
    expect(await service.getStatus(jobId)).toMatchObject({ running: false, cancelled: true });
    await expect(service.start({ baseFolder: baseDir })).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expectConsistentDatabase();
    expect(() => service.shutdown()).not.toThrow();

    // Shutdown only stops this instance: nothing was closed or deleted.
    service = createService({
      onProgress: (event) => progress.push(event),
      onCompleted: (event) => {
        completions.push(event);
        waiting.shift()?.(event);
      },
    });
    const { summary: rescan } = await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });
    expect(rescan).toMatchObject({ cancelled: false, gamesFound: 3, updatesFound: 2 });
  });

  it('rejects unknown jobs and invalid scan inputs', async () => {
    await expect(service.getStatus('missing-job')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(service.start({})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.start({ baseFolder: join(workdir, 'missing') })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(
      service.start({ baseFolder: baseDir, updatesFolder: join(workdir, 'missing') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.start({ baseFolder: baseDir, threshold: 2 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('throttles progress events but always delivers the terminal event', async () => {
    const frozenProgress: ScanProgressDto[] = [];
    service = createService({
      onProgress: (event) => frozenProgress.push(event),
      onCompleted: (event) => waiting.shift()?.(event),
      now: () => 1_700_000_000_000,
    });

    const { jobId, summary } = await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });

    expect(frozenProgress).toHaveLength(2);
    expect(frozenProgress[0].jobId).toBe(jobId);
    const terminal = frozenProgress[frozenProgress.length - 1];
    expect(terminal).toMatchObject({
      jobId,
      phase: 'reconciling',
      checkedFiles: summary.checkedFiles,
      gamesFound: summary.gamesFound,
      updatesFound: summary.updatesFound,
    });
    // No reliable total is known while walking, so `percent` stays absent.
    expect(terminal.percent).toBeUndefined();
    expect(terminal.currentPath).toBe(updatesDir);
  });

  it('reports forward-moving phases as the clock advances', async () => {
    const events: ScanProgressDto[] = [];
    let clock = 1_700_000_000_000;
    service = createService({
      onProgress: (event) => events.push(event),
      onCompleted: (event) => waiting.shift()?.(event),
      now: () => {
        clock += 500;
        return clock;
      },
    });

    const { summary } = await runScan({ baseFolder: baseDir, updatesFolder: updatesDir });

    expect(events.length).toBeGreaterThan(2);
    let lastPhase = 0;
    for (const event of events) {
      const phase = PHASE_ORDER.indexOf(event.phase);
      expect(phase).toBeGreaterThanOrEqual(lastPhase);
      lastPhase = phase;
    }
    expect(lastPhase).toBe(PHASE_ORDER.length - 1);
    expect(events[events.length - 1]).toMatchObject({
      gamesFound: summary.gamesFound,
      updatesFound: summary.updatesFound,
      checkedFiles: summary.checkedFiles,
    });
    expect(summary.elapsedMs).toBeGreaterThan(0);
  });
});
