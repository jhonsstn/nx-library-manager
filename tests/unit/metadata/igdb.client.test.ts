import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TEMP_ROOT } from '../../setup/vitest.setup';
import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { runMigrations } from '../../../src/main/db/migrations';
import { ensureAppPaths, resolveAppPaths } from '../../../src/main/platform/paths';
import { IGDB_SEARCH_CACHE_VERSION, IgdbClient } from '../../../src/main/metadata/igdb.client';
import { MIN_AUTO_MATCH_CONFIDENCE } from '../../../src/shared/constants';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const GAMES_URL = 'https://api.igdb.com/v4/games';
const SWITCH_RESTRICTION = 'where platforms = (130); ';

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: string;
}

interface FetchStub {
  calls: RecordedCall[];
  games: RecordedCall[];
  tokens: RecordedCall[];
  impl: typeof fetch;
}

function createFetchStub(
  handler: (url: string, body: string, index: number) => Response | Promise<Response>,
): FetchStub {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, init: init ?? {}, body });
    return handler(url, body, calls.length);
  }) as unknown as typeof fetch;
  return {
    calls,
    get games(): RecordedCall[] {
      return calls.filter((call) => call.url === GAMES_URL);
    },
    get tokens(): RecordedCall[] {
      return calls.filter((call) => call.url === TOKEN_URL);
    },
    impl,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rawGame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1234,
    name: 'Super Mario Odyssey',
    summary: 'A 3D platformer.',
    first_release_date: 1509321600,
    cover: { url: '//images.igdb.com/igdb/image/upload/t_thumb/co1.jpg' },
    screenshots: [{ url: '//images.igdb.com/igdb/image/upload/t_thumb/sc1.jpg' }, { url: '' }],
    genres: [{ name: 'Platformer' }, { name: 'Adventure' }],
    videos: [{ video_id: 'abc123' }],
    involved_companies: [
      { developer: true, publisher: false, company: { name: 'Nintendo EPD' } },
      { developer: false, publisher: true, company: { name: 'Nintendo' } },
      { developer: true, publisher: true, company: { name: 'Shared Studio' } },
      { developer: true, publisher: false, company: {} },
    ],
    ...overrides,
  };
}

const TOKEN_PAYLOAD = { access_token: 'test-token', expires_in: 5_000_000 };

describe('IgdbClient', () => {
  let dir: string;
  let db: AppDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
    const paths = resolveAppPaths(dir, dir);
    ensureAppPaths(paths);
    db = openDatabase(paths.databaseFile);
    runMigrations(db, paths.databaseFile);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function client(fetchImpl: typeof fetch): IgdbClient {
    return new IgdbClient({ db, clientId: 'client-id', clientSecret: 'client-secret', fetchImpl });
  }

  function searchHandler(results: Record<string, unknown>[]) {
    return (url: string): Response =>
      url === TOKEN_URL ? jsonResponse(TOKEN_PAYLOAD) : jsonResponse(results);
  }

  it('maps a Switch-restricted search result field by field', async () => {
    const stub = createFetchStub(searchHandler([rawGame()]));
    const candidates = await client(stub.impl).search('Super Mario Odyssey');

    expect(candidates).toEqual([
      {
        provider: 'igdb',
        providerId: '1234',
        title: 'Super Mario Odyssey',
        description: 'A 3D platformer.',
        releaseDate: '2017-10-30',
        developer: 'Nintendo EPD, Shared Studio',
        publisher: 'Nintendo, Shared Studio',
        genres: ['Platformer', 'Adventure'],
        coverImageUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1.jpg',
        trailerUrl: 'https://www.youtube.com/watch?v=abc123',
        screenshots: ['https://images.igdb.com/igdb/image/upload/t_1080p/sc1.jpg'],
        confidence: 1,
      },
    ]);

    expect(stub.games).toHaveLength(1);
    expect(stub.games[0].body).toBe(
      'search "Super Mario Odyssey"; fields name,summary,first_release_date,' +
        'cover.url,screenshots.url,genres.name,videos.video_id,' +
        'involved_companies.developer,involved_companies.publisher,' +
        'involved_companies.company.name; where platforms = (130); limit 10;',
    );
    expect(stub.games[0].init.headers).toMatchObject({
      'Client-ID': 'client-id',
      Authorization: 'Bearer test-token',
      Accept: 'application/json',
    });
    expect(stub.tokens).toHaveLength(1);
    expect(stub.tokens[0].body).toBe(
      'client_id=client-id&client_secret=client-secret&grant_type=client_credentials',
    );
  });

  it('leaves release date, cover and trailer empty when IGDB omits them', async () => {
    const stub = createFetchStub(
      searchHandler([rawGame({ first_release_date: undefined, cover: undefined, videos: [], screenshots: [] })]),
    );
    const [candidate] = await client(stub.impl).search('Super Mario Odyssey');

    expect(candidate.releaseDate).toBe('');
    expect(candidate.coverImageUrl).toBe('');
    expect(candidate.trailerUrl).toBe('');
    expect(candidate.screenshots).toEqual([]);
  });

  it('de-duplicates by provider id and sorts by descending confidence', async () => {
    const stub = createFetchStub(
      searchHandler([
        rawGame({ id: 1, name: 'Super Mario Odyssey Deluxe Edition' }),
        rawGame({ id: 2, name: 'Super Mario Odyssey' }),
        rawGame({ id: 2, name: 'Super Mario Odyssey' }),
      ]),
    );
    const candidates = await client(stub.impl).search('Super Mario Odyssey');

    expect(candidates.map((candidate) => candidate.providerId)).toEqual(['2', '1']);
    expect(candidates[0].confidence).toBeGreaterThan(candidates[1].confidence);
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(MIN_AUTO_MATCH_CONFIDENCE);
  });

  it('serves a repeated query from the cache without another HTTP call', async () => {
    const stub = createFetchStub(searchHandler([rawGame()]));
    const subject = client(stub.impl);
    const first = await subject.search('Super Mario Odyssey');
    const callsAfterFirst = stub.calls.length;

    const second = await subject.search('Super Mario Odyssey');

    expect(second).toEqual(first);
    expect(stub.calls).toHaveLength(callsAfterFirst);
  });

  it('fetches one token and reuses it across queries and client instances', async () => {
    const stub = createFetchStub(searchHandler([rawGame({ name: 'Hades' })]));
    await client(stub.impl).search('Hades');
    await client(stub.impl).search('Celeste');
    await client(stub.impl).search('Celeste');

    expect(stub.tokens).toHaveLength(1);
    expect(stub.games).toHaveLength(2);
    expect(
      stub.games.every(
        (call) => (call.init.headers as Record<string, string>).Authorization === 'Bearer test-token',
      ),
    ).toBe(true);
  });

  it('uses the versioned cache key', async () => {
    const stub = createFetchStub(searchHandler([rawGame()]));
    await client(stub.impl).search('Super Mario Odyssey');

    const row = db
      .prepare('SELECT query FROM metadata_cache WHERE provider = ?')
      .all('igdb') as Array<{ query: string }>;
    expect(row.map((entry) => entry.query)).toContain(
      `search:${IGDB_SEARCH_CACHE_VERSION}:switch:Super Mario Odyssey`,
    );
  });

  it('keeps the Switch restriction while it yields results', async () => {
    const stub = createFetchStub(searchHandler([rawGame()]));
    await client(stub.impl).search('Super Mario Odyssey');

    expect(stub.games.every((call) => call.body.includes(SWITCH_RESTRICTION))).toBe(true);
  });

  it('falls back to an unrestricted search only when the Switch pass returns nothing', async () => {
    const stub = createFetchStub((url, body) => {
      if (url === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
      return jsonResponse(body.includes(SWITCH_RESTRICTION) ? [] : [rawGame()]);
    });
    const candidates = await client(stub.impl).search('Super Mario Odyssey');

    expect(candidates).toHaveLength(1);
    expect(stub.games).toHaveLength(2);
    expect(stub.games[0].body).toContain(SWITCH_RESTRICTION);
    expect(stub.games[1].body).not.toContain(SWITCH_RESTRICTION);
  });

  it('maps 429 to a retryable METADATA_RATE_LIMITED error', async () => {
    const stub = createFetchStub((url) =>
      url === TOKEN_URL ? jsonResponse(TOKEN_PAYLOAD) : new Response('slow down', { status: 429 }),
    );

    await expect(client(stub.impl).search('Hades')).rejects.toMatchObject({
      code: 'METADATA_RATE_LIMITED',
      retryable: true,
    });
  });

  it('maps 401 to a non-retryable METADATA_AUTH_ERROR', async () => {
    const stub = createFetchStub((url) =>
      url === TOKEN_URL ? jsonResponse(TOKEN_PAYLOAD) : new Response('nope', { status: 401 }),
    );

    await expect(client(stub.impl).search('Hades')).rejects.toMatchObject({
      code: 'METADATA_AUTH_ERROR',
      retryable: false,
    });
  });

  it('stops after a rejected token request instead of retrying per query', async () => {
    const stub = createFetchStub(() => new Response('invalid client', { status: 400 }));

    await expect(client(stub.impl).search('The Legend of Zelda: Breath of the Wild')).rejects.toMatchObject({
      code: 'METADATA_AUTH_ERROR',
      retryable: false,
    });
    expect(stub.tokens).toHaveLength(1);
    expect(stub.games).toHaveLength(0);
  });

  it('maps transport failures to a retryable NETWORK_ERROR', async () => {
    const stub = createFetchStub((url) => {
      if (url === TOKEN_URL) return jsonResponse(TOKEN_PAYLOAD);
      throw new Error('socket hang up');
    });

    await expect(client(stub.impl).search('Hades')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      retryable: true,
    });
  });

  it('does not search without credentials', async () => {
    const stub = createFetchStub(searchHandler([rawGame()]));
    const results = await new IgdbClient({ db, clientId: '', clientSecret: '', fetchImpl: stub.impl }).search(
      'Hades',
    );

    expect(results).toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });
});
