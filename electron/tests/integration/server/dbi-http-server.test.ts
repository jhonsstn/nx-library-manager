import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEMP_ROOT } from '../../setup/vitest.setup';
import type { CatalogFileRecord, CatalogFileSource } from '../../../src/main/server/catalog-file-source';
import { DbiHttpServer } from '../../../src/main/server/dbi-http-server';

const GAME_BYTES = Buffer.from('0123456789abcdef', 'utf8');
const UPDATE_BYTES = Buffer.from('abcdefghijklmnopqrstuvwxyz', 'utf8');
const GAME_NAME = 'Alpha Game.nsp';
const UPDATE_NAME = 'Ünïcode Title.nsz';
/** Larger than one 256 KiB read chunk, so downloads must stream. */
const LARGE_SIZE = 2 * 1024 * 1024 + 7;
const LARGE_NAME = 'Huge Game.nsp';

const LARGE_BYTES = Buffer.alloc(LARGE_SIZE);
for (let index = 0; index < LARGE_SIZE; index += 1) LARGE_BYTES[index] = (index * 31) % 256;

let directory: string;
let records: CatalogFileRecord[];
let nextId: number;
let logs: string[];
let servers: DbiHttpServer[];

beforeEach(() => {
  directory = mkdtempSync(join(TEMP_ROOT, 'dbi-server-'));
  const gamePath = join(directory, GAME_NAME);
  const updatePath = join(directory, UPDATE_NAME);
  writeFileSync(gamePath, GAME_BYTES);
  writeFileSync(updatePath, UPDATE_BYTES);
  // Present on disk but absent from the catalog: must never be served.
  writeFileSync(join(directory, 'uncatalogued.txt'), 'not part of the library');
  records = [
    {
      kind: 'game',
      id: 1,
      filePath: gamePath,
      fileName: GAME_NAME,
      fileSize: GAME_BYTES.length,
      modifiedTime: Date.now(),
    },
    {
      kind: 'update',
      id: 2,
      filePath: updatePath,
      fileName: UPDATE_NAME,
      fileSize: UPDATE_BYTES.length,
      modifiedTime: Date.now(),
    },
  ];
  logs = [];
  servers = [];
  nextId = 3;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  rmSync(directory, { recursive: true, force: true });
});

function catalogSource(): CatalogFileSource {
  return {
    listFiles: () => [...records],
    findById: (kind, id) => records.find((record) => record.kind === kind && record.id === id) ?? null,
    findByName: (fileName) => records.find((record) => basename(record.filePath) === fileName) ?? null,
    logServerEvent: (line) => {
      logs.push(line);
    },
  };
}

/** Adds a real file on disk plus its catalog row, returning the file name. */
function addCatalogFile(fileName: string, contents: Buffer): string {
  const filePath = join(directory, fileName);
  writeFileSync(filePath, contents);
  records.push({
    kind: 'game',
    id: nextId,
    filePath,
    fileName,
    fileSize: contents.length,
    modifiedTime: Date.now(),
  });
  nextId += 1;
  return fileName;
}

async function startServer(options: { username?: string; password?: string } = {}): Promise<{
  server: DbiHttpServer;
  baseUrl: string;
}> {
  const server = new DbiHttpServer({ source: catalogSource(), host: '127.0.0.1', port: 0, ...options });
  servers.push(server);
  const { port } = await server.start();
  expect(port).toBeGreaterThan(0);
  expect(server.port).toBe(port);
  expect(server.running).toBe(true);
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function basicAuth(password: string, username = 'dbi'): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

describe('DbiHttpServer routes', () => {
  let baseUrl: string;

  beforeEach(async () => {
    ({ baseUrl } = await startServer());
  });

  it('lists catalog files as escaped HTML links', async () => {
    const response = await fetch(`${baseUrl}/dir/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await response.text();
    expect(body).toContain(`<a href="Alpha%20Game.nsp">Alpha Game.nsp</a>`);
    expect(body).toContain(
      `<a href="%C3%9Cn%C3%AFcode%20Title.nsz">\u00dcn\u00efcode Title.nsz</a>`,
    );
    expect(body).not.toContain('uncatalogued.txt');
    expect(body.indexOf('Alpha Game.nsp')).toBeLessThan(body.indexOf('\u00dcn\u00efcode Title.nsz'));
  });

  it('serves a catalog file by base name with full-body headers', async () => {
    const response = await fetch(`${baseUrl}/dir/${encodeURIComponent(GAME_NAME)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(GAME_BYTES.length));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="Alpha Game.nsp"');
    expect(response.headers.get('last-modified')).toMatch(/GMT$/);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(GAME_BYTES)).toBe(true);
  });

  it('serves a catalog file by id, including updates', async () => {
    const byId = await fetch(`${baseUrl}/dl/game/1/${encodeURIComponent(GAME_NAME)}`);
    expect(byId.status).toBe(200);
    expect(Buffer.from(await byId.arrayBuffer()).equals(GAME_BYTES)).toBe(true);

    const update = await fetch(`${baseUrl}/dl/update/2/anything.nsz`);
    expect(update.status).toBe(200);
    expect(Buffer.from(await update.arrayBuffer()).equals(UPDATE_BYTES)).toBe(true);

    expect((await fetch(`${baseUrl}/dl/game/999/${encodeURIComponent(GAME_NAME)}`)).status).toBe(404);
  });

  it('honours bounded, open-ended and unsatisfiable ranges', async () => {
    const bounded = await fetch(`${baseUrl}/dir/${encodeURIComponent(GAME_NAME)}`, {
      headers: { Range: 'bytes=2-5' },
    });
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get('content-range')).toBe(`bytes 2-5/${GAME_BYTES.length}`);
    expect(bounded.headers.get('content-length')).toBe('4');
    expect(await bounded.text()).toBe('2345');

    const openEnded = await fetch(`${baseUrl}/dir/${encodeURIComponent(GAME_NAME)}`, {
      headers: { Range: 'bytes=10-' },
    });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('content-range')).toBe(`bytes 10-${GAME_BYTES.length - 1}/${GAME_BYTES.length}`);
    expect(await openEnded.text()).toBe('abcdef');

    const unsatisfiable = await fetch(`${baseUrl}/dir/${encodeURIComponent(GAME_NAME)}`, {
      headers: { Range: 'bytes=99-120' },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${GAME_BYTES.length}`);
    expect(unsatisfiable.headers.get('content-length')).toBe('0');
    expect(await unsatisfiable.text()).toBe('');
  });

  it('sends headers only for HEAD', async () => {
    const response = await fetch(`${baseUrl}/dir/${encodeURIComponent(GAME_NAME)}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(GAME_BYTES.length));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe('');

    const listing = await fetch(`${baseUrl}/dir/`, { method: 'HEAD' });
    expect(listing.status).toBe(200);
    expect(await listing.text()).toBe('');
  });

  it('lists download URLs and ranges payload responses', async () => {
    const response = await fetch(`${baseUrl}/list.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await response.text();
    expect(body).toContain(`${baseUrl}/dl/game/1/Alpha%20Game.nsp`);
    expect(body).toContain(`${baseUrl}/dl/update/2/%C3%9Cn%C3%AFcode%20Title.nsz`);
    expect(body.endsWith('\n')).toBe(true);

    const awoo = await fetch(`${baseUrl}/awoo.txt`);
    expect(await awoo.text()).toBe(body);

    const ranged = await fetch(`${baseUrl}/list.txt`, { headers: { Range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-3/${Buffer.byteLength(body)}`);
    expect(await ranged.text()).toBe(body.slice(0, 4));
  });

  it('never resolves request paths outside the catalog', async () => {
    const traversal = await fetch(`${baseUrl}/dir/..%2F..%2Fetc%2Fpasswd`);
    expect(traversal.status).toBe(404);

    const uncatalogued = await fetch(`${baseUrl}/dir/uncatalogued.txt`);
    expect(uncatalogued.status).toBe(404);

    const nested = await fetch(`${baseUrl}/dir/sub%2F${encodeURIComponent(GAME_NAME)}`);
    expect(nested.status).toBe(404);

    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/dl/music/1/song.mp3`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/list.txt`, { method: 'POST' })).status).toBe(405);
  });

  it('escapes file names for display and encodes them for links separately', async () => {
    addCatalogFile('Rock & Roll <Live>.xci', Buffer.from('riff', 'utf8'));
    const body = await (await fetch(`${baseUrl}/dir/`)).text();
    expect(body).toContain('Rock &amp; Roll &lt;Live&gt;.xci');
    expect(body).toContain('href="Rock%20%26%20Roll%20%3CLive%3E.xci"');
  });

  it('streams multi-chunk downloads without corrupting bytes', async () => {
    addCatalogFile(LARGE_NAME, LARGE_BYTES);
    const response = await fetch(`${baseUrl}/dir/${encodeURIComponent(LARGE_NAME)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(LARGE_SIZE));
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.length).toBe(LARGE_SIZE);
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      createHash('sha256').update(LARGE_BYTES).digest('hex'),
    );

    const tail = await fetch(`${baseUrl}/dir/${encodeURIComponent(LARGE_NAME)}`, {
      headers: { Range: `bytes=${LARGE_SIZE - 4}-` },
    });
    expect(tail.status).toBe(206);
    expect((await tail.text()).length).toBe(4);
  });

  it('survives a client disconnect mid-download', async () => {
    addCatalogFile(LARGE_NAME, LARGE_BYTES);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/dir/${encodeURIComponent(LARGE_NAME)}`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();
    await expect(response.arrayBuffer()).rejects.toThrow();

    expect((await fetch(`${baseUrl}/dir/`)).status).toBe(200);
    expect(logs.some((line) => line.includes('download-name 200'))).toBe(true);
  });

  it('stops serving after stop() and tolerates a repeated stop', async () => {
    const { server, baseUrl: url } = await startServer();
    expect((await fetch(`${url}/dir/`)).status).toBe(200);
    await server.stop();
    expect(server.running).toBe(false);
    await server.stop();
    await expect(fetch(`${url}/dir/`)).rejects.toThrow();
  });

  it('reports a taken port as HTTP_PORT_IN_USE', async () => {
    const first = await startServer();
    const conflicting = new DbiHttpServer({
      source: catalogSource(),
      host: '127.0.0.1',
      port: first.server.port,
    });
    servers.push(conflicting);
    await expect(conflicting.start()).rejects.toMatchObject({ code: 'HTTP_PORT_IN_USE' });
    expect(conflicting.running).toBe(false);
  });

  it('logs one structured line per request without leaking credentials', async () => {
    await fetch(`${baseUrl}/dir/`);
    await fetch(`${baseUrl}/dir/${encodeURIComponent(GAME_NAME)}`, { headers: { Range: 'bytes=0-1' } });
    await fetch(`${baseUrl}/nope`);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.some((line) => line.includes('GET listing 200'))).toBe(true);
    expect(logs.some((line) => line.includes('Range=bytes=0-1'))).toBe(true);
    expect(logs.every((line) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (GET|HEAD) /.test(line))).toBe(true);
    expect(logs.every((line) => !line.includes('Authorization'))).toBe(true);
  });
});

describe('DbiHttpServer authentication', () => {
  const PASSWORD = 'hunter2';
  let baseUrl: string;

  beforeEach(async () => {
    ({ baseUrl } = await startServer({ username: 'dbi', password: PASSWORD }));
  });

  it('rejects missing and incorrect credentials', async () => {
    const anonymous = await fetch(`${baseUrl}/dir/`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Basic realm="Switch Catalog"');
    expect(anonymous.headers.get('content-length')).toBe('0');

    const wrong = await fetch(`${baseUrl}/dir/`, { headers: { Authorization: basicAuth('nope') } });
    expect(wrong.status).toBe(401);

    const malformed = await fetch(`${baseUrl}/dir/`, { headers: { Authorization: 'Basic !!!not-base64!!!' } });
    expect(malformed.status).toBe(401);

    expect(logs.every((line) => !line.includes(PASSWORD))).toBe(true);
    expect(logs.every((line) => !line.includes(basicAuth(PASSWORD)))).toBe(true);
    expect(logs.some((line) => line.includes('unauthorized 401'))).toBe(true);
  });

  it('accepts correct credentials and embeds them in the URL list', async () => {
    const response = await fetch(`${baseUrl}/dir/`, { headers: { Authorization: basicAuth(PASSWORD) } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Alpha Game.nsp');

    const list = await fetch(`${baseUrl}/list.txt`, { headers: { Authorization: basicAuth(PASSWORD) } });
    const body = await list.text();
    expect(body).toContain(`http://dbi:${PASSWORD}@127.0.0.1:`);
    expect(body).toContain('/dl/game/1/Alpha%20Game.nsp');
  });
});
