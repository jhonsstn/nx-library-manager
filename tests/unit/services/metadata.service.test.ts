import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TEMP_ROOT } from '../../setup/vitest.setup';
import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { runMigrations } from '../../../src/main/db/migrations';
import { ensureAppPaths, resolveAppPaths, type AppPaths } from '../../../src/main/platform/paths';
import { ImageCache } from '../../../src/main/metadata/image-cache';
import { MetadataService } from '../../../src/main/services/metadata.service';
import { getGame } from '../../../src/main/repositories/games.repository';
import { listScreenshots } from '../../../src/main/repositories/screenshots.repository';
import type { MetadataBulkProgressDto, MetadataCandidateDto } from '../../../src/shared/types/domain';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const GAMES_URL = 'https://api.igdb.com/v4/games';
const TOKEN_PAYLOAD = { access_token: 'test-token', expires_in: 5_000_000 };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function imageResponse(): Response {
  return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
}

/** Name the IGDB stub answers with, read straight off the request body. */
function searchedName(body: string): string {
  return /search "(.*?)";/.exec(body)?.[1] ?? '';
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function rawGame(name: string, id: number): Record<string, unknown> {
  return {
    id,
    name,
    summary: `${name} summary`,
    cover: { url: `//images.igdb.com/igdb/image/upload/t_thumb/${id}-cover.jpg` },
    genres: [{ name: 'Action' }],
    involved_companies: [],
  };
}

function candidate(overrides: Partial<MetadataCandidateDto> = {}): MetadataCandidateDto {
  return {
    provider: 'igdb',
    providerId: '1',
    title: 'Super Mario Odyssey',
    description: 'A 3D platformer.',
    releaseDate: '2017-10-30',
    developer: 'Nintendo EPD',
    publisher: 'Nintendo',
    genres: ['Platformer', 'Adventure'],
    coverImageUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg',
    trailerUrl: 'https://www.youtube.com/watch?v=abc123',
    screenshots: [],
    confidence: 1,
    ...overrides,
  };
}

/** Yields past every pending microtask, so in-flight workers settle. */
function nextTask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe('MetadataService', () => {
  let dir: string;
  let db: AppDatabase;
  let paths: AppPaths;
  let nextId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
    paths = resolveAppPaths(dir);
    ensureAppPaths(paths);
    db = openDatabase(paths.databaseFile);
    runMigrations(db, paths.databaseFile);
    nextId = 1;
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function insertGame(displayTitle: string, options: { locked?: boolean } = {}): number {
    db.prepare('INSERT INTO games(display_title, cleaned_title, metadata_locked) VALUES (?, ?, ?)').run(
      displayTitle,
      displayTitle,
      options.locked ? 1 : 0,
    );
    const row = db.prepare('SELECT id FROM games WHERE cleaned_title = ?').get(displayTitle) as { id: number };
    return row.id;
  }

  /** Every IGDB title resolves to itself, so a stored candidate is auto-appliable. */
  function igdbStub(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input);
      if (url === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
      if (url !== GAMES_URL) return imageResponse();
      const body = typeof init?.body === 'string' ? init.body : '';
      return jsonResponse([rawGame(searchedName(body), nextId++)]);
    }) as unknown as typeof fetch;
  }

  function service(
    options: {
      fetchImpl?: typeof fetch;
      credentials?: () => { clientId: string; clientSecret: string };
    } = {},
  ): MetadataService {
    const fetchImpl = options.fetchImpl ?? igdbStub();
    return new MetadataService({
      db,
      paths,
      credentials: options.credentials ?? (() => ({ clientId: 'client-id', clientSecret: 'client-secret' })),
      imageCache: new ImageCache({
        coversDir: paths.coversCacheDir,
        screenshotsDir: paths.screenshotsCacheDir,
        fetchImpl,
      }),
      fetchImpl,
    });
  }

  describe('searchCandidates', () => {
    it('reports a missing game', async () => {
      await expect(service().searchCandidates(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns nothing while credentials are missing', async () => {
      const gameId = insertGame('Hades');
      const found = await service({ credentials: () => ({ clientId: ' ', clientSecret: '' }) }).searchCandidates(gameId);

      expect(found).toEqual([]);
    });

    it('searches with the requested title', async () => {
      const gameId = insertGame('Hades');
      const found = await service().searchCandidates(gameId, 'Hades II');

      expect(found[0]).toMatchObject({ title: 'Hades II', provider: 'igdb', confidence: 1 });
    });
  });

  describe('refreshGame', () => {
    it('uses exact-ID Nlib and preserves a package NACP name', async () => {
      const gameId = insertGame('Package name');
      const titleId = '0100AABBCCDD0000';
      db.prepare(`INSERT INTO titles(game_id,title_id,base_title_id,type,display_name,name_source,provisional)
        VALUES (?,?,?,'base','Package name','nacp',0)`).run(gameId,titleId,titleId);
      let igdbCalls = 0;
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url.startsWith('https://api.nlib.cc/nx/')) return jsonResponse({
          id:titleId,name:'Nlib name',description:'Nlib description',category:['Action'],
          nsuId:'70010000000025',publisher:'Publisher',developer:'Developer',
        });
        igdbCalls += 1;
        throw new Error('IGDB must not be called for a usable Nlib record');
      }) as typeof fetch;
      expect(await service({ fetchImpl }).refreshGame(gameId)).toBe(true);
      expect(igdbCalls).toBe(0);
      expect(getGame(db,gameId)).toMatchObject({ displayTitle:'Package name',
        metadataProvider:'nlib',description:'Nlib description' });
      expect(db.prepare('SELECT nsu_id FROM titles WHERE game_id=?').get(gameId))
        .toMatchObject({ nsu_id:'70010000000025' });
    });

    it('falls back to IGDB when the exact Nlib ID is missing', async () => {
      const gameId = insertGame('Fallback Game');
      const titleId = '0100AABBCCDD0000';
      db.prepare(`INSERT INTO titles(game_id,title_id,base_title_id,type,display_name,provisional)
        VALUES (?,?,?,'base','Fallback Game',0)`).run(gameId,titleId,titleId);
      let nlibCalls = 0;
      const original = igdbStub();
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (requestUrl(input).startsWith('https://api.nlib.cc/nx/')) {
          nlibCalls += 1;
          return jsonResponse({},404);
        }
        return original(input,init);
      }) as typeof fetch;
      expect(await service({ fetchImpl }).refreshGame(gameId)).toBe(true);
      expect(nlibCalls).toBe(1);
      expect(getGame(db,gameId)?.metadataProvider).toBe('igdb');
    });

    it('never searches for or overwrites a locked game', async () => {
      const gameId = insertGame('Super Mario Odyssey', { locked: true });
      let requests = 0;
      const fetchImpl = (async (): Promise<Response> => {
        requests += 1;
        return jsonResponse([rawGame('Metroid Dread', 99)]);
      }) as unknown as typeof fetch;

      await expect(service({ fetchImpl }).refreshGame(gameId)).resolves.toBe(false);

      const game = getGame(db, gameId);
      expect(requests).toBe(0);
      expect(game).toMatchObject({
        displayTitle: 'Super Mario Odyssey',
        metadataProvider: null,
        metadataLocked: true,
        needsReview: false,
      });
    });

    it('flags a low-confidence match for review instead of applying it', async () => {
      const gameId = insertGame('Super Mario Odyssey');
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        if (requestUrl(input) === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
        return jsonResponse([rawGame('The Legend of Zelda: Tears of the Kingdom', 42)]);
      }) as unknown as typeof fetch;

      await expect(service({ fetchImpl }).refreshGame(gameId)).resolves.toBe(false);

      const game = getGame(db, gameId);
      expect(game).toMatchObject({
        displayTitle: 'Super Mario Odyssey',
        metadataProvider: null,
        description: '',
        needsReview: true,
      });
    });

    it('flags a game IGDB cannot match', async () => {
      const gameId = insertGame('Unknown Homebrew Game');
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        if (requestUrl(input) === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
        return jsonResponse([]);
      }) as unknown as typeof fetch;

      await expect(service({ fetchImpl }).refreshGame(gameId)).resolves.toBe(false);

      expect(getGame(db, gameId)?.needsReview).toBe(true);
    });

    it('applies a confident match without locking the metadata', async () => {
      const gameId = insertGame('Super Mario Odyssey');

      await expect(service().refreshGame(gameId)).resolves.toBe(true);

      const game = getGame(db, gameId);
      expect(game).toMatchObject({
        displayTitle: 'Super Mario Odyssey',
        metadataProvider: 'igdb',
        description: 'Super Mario Odyssey summary',
        genres: ['Action'],
        needsReview: false,
        metadataLocked: false,
      });
      expect(game?.coverImagePath?.startsWith(`${paths.coversCacheDir}/`)).toBe(true);
      expect(existsSync(game?.coverImagePath ?? '')).toBe(true);
    });
  });

  describe('applyCandidate', () => {
    it('writes the game row, replaces the screenshot set and records cached paths', async () => {
      const gameId = insertGame('Super Mario Odyssey');
      const screenshots = Array.from(
        { length: 10 },
        (_, index) => `https://images.igdb.com/igdb/image/upload/t_1080p/shot-${index}.jpg`,
      );

      await service().applyCandidate(gameId, candidate({ screenshots }));

      expect(getGame(db, gameId)).toMatchObject({
        displayTitle: 'Super Mario Odyssey',
        metadataProvider: 'igdb',
        metadataProviderId: '1',
        description: 'A 3D platformer.',
        releaseDate: '2017-10-30',
        developer: 'Nintendo EPD',
        publisher: 'Nintendo',
        genres: ['Platformer', 'Adventure'],
        coverImageUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg',
        trailerUrl: 'https://www.youtube.com/watch?v=abc123',
        needsReview: false,
      });
      const coverPath = getGame(db, gameId)?.coverImagePath ?? '';
      expect(coverPath.startsWith(`${paths.coversCacheDir}/`)).toBe(true);
      expect(existsSync(coverPath)).toBe(true);

      const rows = listScreenshots(db, gameId);
      expect(rows.map((row) => row.image_url)).toEqual(screenshots);
      const cached = rows.filter((row) => row.local_path);
      expect(cached).toHaveLength(8);
      expect(cached.every((row) => row.local_path?.startsWith(`${paths.screenshotsCacheDir}/`))).toBe(true);
      expect(cached.every((row) => existsSync(row.local_path ?? ''))).toBe(true);
      expect(rows.slice(8).every((row) => row.local_path === null)).toBe(true);

      await service().applyCandidate(gameId, candidate({ providerId: '2', screenshots: [screenshots[0]] }));
      expect(listScreenshots(db, gameId).map((row) => row.image_url)).toEqual([screenshots[0]]);
    });

    it('keeps the applied metadata when image downloads fail', async () => {
      const gameId = insertGame('Super Mario Odyssey');
      const offline = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;

      await expect(
        service({ fetchImpl: offline }).applyCandidate(
          gameId,
          candidate({ screenshots: ['https://images.igdb.com/igdb/image/upload/t_1080p/shot.jpg'] }),
        ),
      ).resolves.toBeUndefined();

      const game = getGame(db, gameId);
      expect(game).toMatchObject({ displayTitle: 'Super Mario Odyssey', metadataProvider: 'igdb' });
      expect(game?.coverImagePath).toBeNull();
      expect(listScreenshots(db, gameId)[0].local_path).toBeNull();
    });
  });

  describe('bulkRefresh', () => {
    it('refreshes every eligible game and reports progress totals', async () => {
      for (const title of ['Game One', 'Game Two', 'Game Three', 'Game Four', 'Game Five']) insertGame(title);
      const progress: MetadataBulkProgressDto[] = [];

      const result = await service().bulkRefresh({ force: true, onProgress: (event) => progress.push(event) });

      expect(result).toEqual({ attempted: 5, updated: 5, noMatch: 0, failed: 0 });
      expect(progress[0]).toMatchObject({ total: 5, processed: 0, done: false });
      expect(progress.at(-1)).toMatchObject({
        total: 5,
        processed: 5,
        updated: 5,
        noMatch: 0,
        failed: 0,
        done: true,
        cancelled: false,
      });
      expect(progress.every((event) => event.jobId.length > 0)).toBe(true);
    });

    it('keeps at most three searches in flight', async () => {
      for (const title of ['Game One', 'Game Two', 'Game Three', 'Game Four', 'Game Five']) insertGame(title);
      let inFlight = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = requestUrl(input);
        if (url === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
        if (url !== GAMES_URL) return imageResponse();
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const gate = Promise.withResolvers<void>();
        gates.push(gate.resolve);
        await gate.promise;
        inFlight -= 1;
        const body = typeof init?.body === 'string' ? init.body : '';
        return jsonResponse([rawGame(searchedName(body), nextId++)]);
      }) as unknown as typeof fetch;

      const running = service({ fetchImpl }).bulkRefresh({ force: true });
      let settled = false;
      running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      while (!settled) {
        await nextTask();
        while (gates.length > 0) gates.shift()?.();
      }
      await running;

      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
    });

    it('flags games for review when IGDB fails', async () => {
      for (const title of ['Game One', 'Game Two', 'Game Three', 'Game Four']) insertGame(title);
      const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
        if (requestUrl(input) === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
        throw new Error('socket hang up');
      }) as unknown as typeof fetch;

      const result = await service({ fetchImpl }).bulkRefresh({ force: true });

      expect(result).toEqual({ attempted: 4, updated: 0, noMatch: 0, failed: 4 });
      const flagged = db.prepare('SELECT needs_review FROM games').all() as Array<{ needs_review: number }>;
      expect(flagged.every((row) => row.needs_review === 1)).toBe(true);
    });

    it('starts nothing when the signal is already aborted', async () => {
      for (const title of ['Game One', 'Game Two', 'Game Three']) insertGame(title);
      const controller = new AbortController();
      controller.abort();
      const progress: MetadataBulkProgressDto[] = [];

      const result = await service().bulkRefresh({
        force: true,
        signal: controller.signal,
        onProgress: (event) => progress.push(event),
      });

      expect(result).toEqual({ attempted: 0, updated: 0, noMatch: 0, failed: 0 });
      expect(progress.at(-1)).toMatchObject({ total: 3, processed: 0, done: true, cancelled: true });
    });
  });
});
