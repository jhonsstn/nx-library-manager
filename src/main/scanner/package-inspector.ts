import { createDecipheriv } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const INSPECTOR_VERSION = 3;
const MAX_HEADER = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const ID = /^[0-9A-F]{16}$/;

export interface InspectedTitle {
  titleId: string;
  baseTitleId: string;
  type: 'base' | 'update' | 'dlc';
  rawVersion: number | null;
  name: string | null;
  publisher: string | null;
  source: 'cnmt' | 'nca-header';
}
interface Entry { name: string; offset: number; size: number }

function hexId(data: Buffer, offset: number): string {
  return data.readBigUInt64LE(offset).toString(16).toUpperCase().padStart(16, '0');
}

async function readAt(file: FileHandle, offset: number, length: number, fileSize: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > MAX_HEADER || offset + length > fileSize)
    throw new Error('Package range is invalid');
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  if (bytesRead !== length) throw new Error('Truncated package');
  return buffer;
}

async function parseFs(file: FileHandle, fileSize: number, offset: number, expected: 'PFS0' | 'HFS0'): Promise<Entry[]> {
  const head = await readAt(file, offset, 0x10, fileSize);
  if (head.toString('ascii', 0, 4) !== expected) throw new Error(`Missing ${expected} header`);
  const count = head.readUInt32LE(4);
  const stringsSize = head.readUInt32LE(8);
  const stride = expected === 'PFS0' ? 0x18 : 0x40;
  const headerSize = 0x10 + count * stride + stringsSize;
  if (count > MAX_ENTRIES || headerSize > MAX_HEADER) throw new Error('Oversized package index');
  const header = await readAt(file, offset, headerSize, fileSize);
  const stringsAt = 0x10 + count * stride;
  const contentAt = offset + headerSize;
  const entries: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 0x10 + i * stride;
    const relative = Number(header.readBigUInt64LE(at));
    const size = Number(header.readBigUInt64LE(at + 8));
    const stringOffset = header.readUInt32LE(at + 16);
    if (stringOffset >= stringsSize || !Number.isSafeInteger(relative) || !Number.isSafeInteger(size))
      throw new Error('Invalid package entry');
    const start = stringsAt + stringOffset;
    const end = header.indexOf(0, start);
    if (end < start || end >= headerSize) throw new Error('Invalid package filename');
    const entryOffset = contentAt + relative;
    if (entryOffset + size > fileSize) throw new Error('Package entry exceeds file');
    entries.push({ name: header.toString('utf8', start, end), offset: entryOffset, size });
  }
  return entries;
}

function parseCnmt(data: Buffer): InspectedTitle | null {
  if (data.length < 0x30) return null;
  const metaType = data[0xC];
  const type = metaType === 0x80 ? 'base' : metaType === 0x81 ? 'update' : metaType === 0x82 ? 'dlc' : null;
  if (!type) return null;
  const id = hexId(data, 0);
  if (!ID.test(id) || id === '0000000000000000') return null;
  const extendedSize = data.readUInt16LE(0xE);
  if (extendedSize > data.length - 0x20) return null;
  if (type !== 'base' && extendedSize < 8) return null;
  const parent = type === 'base' ? id : hexId(data, 0x20);
  if (!ID.test(parent) || parent === '0000000000000000') return null;
  return { titleId: id, baseTitleId: parent, type, rawVersion: data.readUInt32LE(8),
    name: null, publisher: null, source: 'cnmt' };
}

function parseNacp(data: Buffer): { name: string; publisher: string } | null {
  if (data.length < 0x300) return null;
  for (let at = 0; at + 0x300 <= Math.min(data.length, 0x3000); at += 0x300) {
    const name = data.toString('utf8', at, at + 0x200).split('\0')[0].trim();
    const publisher = data.toString('utf8', at + 0x200, at + 0x300).split('\0')[0].trim();
    if (name) return { name, publisher };
  }
  return null;
}

function decryptNcaHeader(data: Buffer, key: Buffer): Buffer | null {
  if (data.length < 0xC00 || key.length !== 32) return null;
  for (const littleEndian of [true, false]) {
    try {
      const header = Buffer.alloc(0xC00);
      for (let sector = 0; sector < 6; sector += 1) {
        const tweak = Buffer.alloc(16);
        if (littleEndian) tweak.writeUInt32LE(sector, 0);
        else tweak.writeUInt32BE(sector, 12);
        const decipher = createDecipheriv('aes-128-xts', key, tweak);
        const plain = Buffer.concat([decipher.update(data.subarray(sector * 0x200, (sector + 1) * 0x200)), decipher.final()]);
        plain.copy(header, sector * 0x200);
      }
      if (/^NCA[0-3]$/.test(header.toString('ascii', 0x200, 0x204))) return header;
    } catch { /* unsupported key or malformed header */ }
  }
  return null;
}

function decryptEcb(key: Buffer, value: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

function masterIndex(revision: number): string { return Math.max(0, revision - 1).toString(16).padStart(2, '0'); }

function keyAreaKey(keys: Map<string, Buffer>, revision: number, kakIndex: number): Buffer | null {
  const family = ['application', 'ocean', 'system'][kakIndex];
  if (!family) return null;
  const index = masterIndex(revision);
  const direct = keys.get(`key_area_key_${family}_${index}`);
  if (direct?.length === 16) return direct;
  const master = keys.get(`master_key_${index}`);
  const kekSource = keys.get('aes_kek_generation_source');
  const areaSource = keys.get(`key_area_key_${family}_source`);
  const keySource = keys.get('aes_key_generation_source');
  if (!master || !kekSource || !areaSource || !keySource) return null;
  if ([master,kekSource,areaSource,keySource].some((item) => item.length !== 16)) return null;
  return decryptEcb(decryptEcb(decryptEcb(master,kekSource),areaSource),keySource);
}

async function readTickets(file: FileHandle, fileSize: number, entries: Entry[],
  keys: Map<string, Buffer>): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.tik') || entry.size < 0x2C0) continue;
    const data = await readAt(file, entry.offset, 0x2C0, fileSize);
    if (data[0x281] !== 0) continue;
    const rights = data.subarray(0x2A0, 0x2B0);
    const revision = Math.max(data[0x285],rights[15]);
    const index = masterIndex(revision);
    let titleKek = keys.get(`titlekek_${index}`);
    if (!titleKek) {
      const master = keys.get(`master_key_${index}`);
      const source = keys.get('titlekek_source');
      if (master?.length === 16 && source?.length === 16) titleKek = decryptEcb(master,source);
    }
    if (titleKek?.length === 16) result.set(rights.toString('hex'), decryptEcb(titleKek,data.subarray(0x180,0x190)));
  }
  return result;
}

function ncaBodyKey(header: Buffer, keys: Map<string, Buffer>, tickets: Map<string, Buffer>): Buffer | null {
  const rights = header.subarray(0x230,0x240);
  if (rights.some((byte) => byte !== 0)) return tickets.get(rights.toString('hex')) ?? null;
  const revision = Math.max(header[0x206],header[0x220]);
  const kak = keyAreaKey(keys,revision,Math.min(2,header[0x207]));
  return kak ? decryptEcb(kak,header.subarray(0x320,0x330)) : null;
}

async function readNcaSection(file: FileHandle, fileSize: number, ncaOffset: number,
  sectionOffset: number, relative: number, length: number, key: Buffer | null,
  nonce: Buffer, encryption: number): Promise<Buffer> {
  const absolute = ncaOffset + sectionOffset + relative;
  if (encryption === 1) return readAt(file,absolute,length,fileSize);
  if (encryption !== 3 || !key || key.length !== 16) throw new Error('NCA section key unavailable');
  const counterOffset = sectionOffset + relative;
  const skew = counterOffset % 16;
  const aligned = absolute - skew;
  const ciphertext = await readAt(file,aligned,length + skew,fileSize);
  const iv = Buffer.alloc(16);
  Buffer.from(nonce).reverse().copy(iv,0);
  iv.writeBigUInt64BE(BigInt(Math.floor(counterOffset / 16)),8);
  const decipher = createDecipheriv('aes-128-ctr',key,iv);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]).subarray(skew);
}

/** Meta NCA's PFS0 holds a tiny CNMT. No game content is extracted. */
async function inspectMetaNca(file: FileHandle, fileSize: number, entry: Entry, header: Buffer,
  keys: Map<string, Buffer>, tickets: Map<string, Buffer>, plainNczBody: Buffer | null = null): Promise<InspectedTitle | null> {
  if (header[0x205] !== 1) return null;
  const bodyKey = ncaBodyKey(header,keys,tickets);
  for (let section = 0; section < 4; section += 1) {
    const tableAt = 0x240 + section * 0x10;
    const start = header.readUInt32LE(tableAt) * 0x200;
    const end = header.readUInt32LE(tableAt + 4) * 0x200;
    const virtualSize = plainNczBody ? 0x4000+plainNczBody.length : entry.size;
    if (end <= start || end > virtualSize) continue;
    const fs = header.subarray(0x400 + section * 0x200,0x600 + section * 0x200);
    if (fs[2] !== 1 || fs[3] !== 2) continue;
    const encryption = fs[4];
    const pfsOffset = Number(fs.readBigUInt64LE(0x40));
    const pfsSize = Number(fs.readBigUInt64LE(0x48));
    if (!Number.isSafeInteger(pfsOffset) || pfsSize < 0x10 || pfsOffset + pfsSize > end-start) continue;
    const read = (at: number,length: number) => {
      const relative = start+pfsOffset+at-0x4000;
      if (plainNczBody) {
        if (relative < 0 || relative+length > plainNczBody.length) throw new Error('NCZ metadata range invalid');
        return Promise.resolve(plainNczBody.subarray(relative,relative+length));
      }
      return readNcaSection(file,fileSize,entry.offset,start,pfsOffset+at,length,
        bodyKey,fs.subarray(0x140,0x148),encryption);
    };
    const prefix = await read(0,0x10);
    if (prefix.toString('ascii',0,4) !== 'PFS0') continue;
    const count = prefix.readUInt32LE(4);
    const stringsSize = prefix.readUInt32LE(8);
    const indexSize = 0x10 + count * 0x18 + stringsSize;
    if (count > 32 || indexSize > 0x10000 || indexSize > pfsSize) continue;
    const index = await read(0,indexSize);
    for (let i = 0; i < count; i += 1) {
      const at = 0x10 + i * 0x18;
      const nameOffset = index.readUInt32LE(at+16);
      if (nameOffset >= stringsSize) continue;
      const stringAt = 0x10 + count * 0x18 + nameOffset;
      const nameEnd = index.indexOf(0,stringAt);
      if (nameEnd < 0 || !index.toString('utf8',stringAt,nameEnd).toLowerCase().endsWith('.cnmt')) continue;
      const fileAt = Number(index.readBigUInt64LE(at));
      const fileLength = Number(index.readBigUInt64LE(at+8));
      if (fileAt + fileLength > pfsSize - indexSize || fileLength < 0x30) continue;
      const title = parseCnmt(await read(indexSize+fileAt,Math.min(fileLength,0x40)));
      if (title) return title;
    }
  }
  return null;
}

/** NCZ keeps its first 0x4000 bytes unchanged. Meta NCAs are small enough to
 * decompress under a strict cap; large game-content NCZs are never expanded. */
async function readSmallNczBody(file: FileHandle, fileSize: number, entry: Entry): Promise<Buffer | null> {
  if (entry.size < 0x4008 || entry.size > MAX_HEADER) return null;
  const prefix = await readAt(file,entry.offset+0x4000,8,fileSize);
  const sections = Number(prefix.readBigUInt64LE(0));
  if (!Number.isSafeInteger(sections) || sections<1 || sections>32) return null;
  const headerSize = 8+sections*0x48;
  if (0x4000+headerSize >= entry.size) return null;
  const header = await readAt(file,entry.offset+0x4000,headerSize,fileSize);
  for (let i=0;i<sections;i+=1)
    if (header.toString('ascii',8+i*0x48,16+i*0x48) !== 'NCZSECTN') return null;
  const compressedAt = entry.offset+0x4000+headerSize;
  const magic = await readAt(file,compressedAt,8,fileSize);
  if (magic.toString('ascii') === 'NCZBLOCK') {
    const block = await readAt(file,compressedAt,24,fileSize);
    const exponent = block[11];
    const blockCount = block.readUInt32LE(12);
    const unpackedSize = Number(block.readBigUInt64LE(16));
    if (exponent < 14 || exponent > 24 || blockCount < 1 || blockCount > 1024
      || !Number.isSafeInteger(unpackedSize) || unpackedSize > MAX_HEADER) return null;
    const sizes = await readAt(file,compressedAt+24,blockCount*4,fileSize);
    let offset = compressedAt+24+blockCount*4;
    const chunks: Buffer[] = [];
    const blockSize = 2 ** exponent;
    for (let i=0;i<blockCount;i+=1) {
      const packed = sizes.readUInt32LE(i*4);
      const expected = Math.min(blockSize,unpackedSize-i*blockSize);
      if (expected <= 0 || packed > expected || offset+packed > entry.offset+entry.size) return null;
      const bytes = await readAt(file,offset,packed,fileSize);
      offset += packed;
      const plain = packed < expected
        ? zstdDecompressSync(bytes,{ maxOutputLength:expected }) : bytes;
      if (plain.length !== expected) return null;
      chunks.push(plain);
    }
    return Buffer.concat(chunks,unpackedSize);
  }
  const compressed = await readAt(file,compressedAt,entry.size-0x4000-headerSize,fileSize);
  try { return zstdDecompressSync(compressed,{ maxOutputLength:MAX_HEADER }); }
  catch { return null; }
}

/** Reads only RomFS tables and control.nacp from the Control NCA. */
async function inspectControlNca(file: FileHandle, fileSize: number, entry: Entry, header: Buffer,
  keys: Map<string, Buffer>, tickets: Map<string, Buffer>, plainNczBody: Buffer | null = null):
  Promise<{ name: string; publisher: string } | null> {
  if (header[0x205] !== 2) return null;
  const bodyKey = ncaBodyKey(header,keys,tickets);
  for (let section = 0; section < 4; section += 1) {
    const tableAt = 0x240 + section * 0x10;
    const start = header.readUInt32LE(tableAt) * 0x200;
    const end = header.readUInt32LE(tableAt+4) * 0x200;
    const virtualSize = plainNczBody ? 0x4000+plainNczBody.length : entry.size;
    if (end <= start || end > virtualSize) continue;
    const fs = header.subarray(0x400+section*0x200,0x600+section*0x200);
    if (fs[2] !== 0 || fs[3] !== 3) continue;
    const count = Math.min(6,fs.readUInt32LE(0x14));
    if (count < 1) continue;
    const imageBase = Number(fs.readBigUInt64LE(0x18+(count-1)*0x18));
    if (!Number.isSafeInteger(imageBase) || imageBase+0x50 > end-start) continue;
    const read = (at: number,length: number) => {
      const relative = start+at-0x4000;
      if (plainNczBody) {
        if (relative < 0 || relative+length > plainNczBody.length) throw new Error('NCZ control range invalid');
        return Promise.resolve(plainNczBody.subarray(relative,relative+length));
      }
      return readNcaSection(file,fileSize,entry.offset,start,at,length,bodyKey,
        fs.subarray(0x140,0x148),fs[4]);
    };
    const rom = await read(imageBase,0x50);
    if (rom.readBigUInt64LE(0) < 0x50n) continue;
    const dirAt = Number(rom.readBigUInt64LE(0x18));
    const dirSize = Number(rom.readBigUInt64LE(0x20));
    const filesAt = Number(rom.readBigUInt64LE(0x38));
    const filesSize = Number(rom.readBigUInt64LE(0x40));
    const dataAt = Number(rom.readBigUInt64LE(0x48));
    if ([dirAt,dirSize,filesAt,filesSize,dataAt].some((n) => !Number.isSafeInteger(n) || n<0)
      || dirSize < 0x18 || dirSize > MAX_HEADER || filesSize > MAX_HEADER
      || imageBase+dirAt+dirSize > end-start || imageBase+filesAt+filesSize > end-start) continue;
    const root = await read(imageBase+dirAt,0x18);
    const table = await read(imageBase+filesAt,filesSize);
    let next = root.readUInt32LE(0xC);
    for (let walked=0;next !== 0xFFFFFFFF && walked<1000;walked+=1) {
      if (next+0x20 > table.length) break;
      const nameLength = table.readUInt32LE(next+0x1C);
      if (next+0x20+nameLength > table.length) break;
      const name = table.toString('utf8',next+0x20,next+0x20+nameLength);
      if (name.toLowerCase() === 'control.nacp') {
        const offset = Number(table.readBigUInt64LE(next+0x8));
        const length = Number(table.readBigUInt64LE(next+0x10));
        if (length >= 0x300 && length <= 0x4000 && imageBase+dataAt+offset+length <= end-start)
          return parseNacp(await read(imageBase+dataAt+offset,length));
      }
      next = table.readUInt32LE(next+4);
    }
  }
  return null;
}

/** Reads only container indexes and small metadata prefixes. Raw versions are
 * reported only when CNMT itself was parsed; an NCA header cannot prove them. */
export async function inspectPackage(path: string, keys: Map<string, Buffer> | null, signal?: AbortSignal): Promise<InspectedTitle[]> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const ext = extname(path).toLowerCase();
    let entries: Entry[];
    if (ext === '.xci') {
      const card = await readAt(file, 0, 0x200, size);
      const rootOffset = Number(card.readBigUInt64LE(0x130));
      const root = await parseFs(file, size, rootOffset, 'HFS0');
      const secure = root.find((entry) => entry.name === 'secure');
      if (!secure) throw new Error('XCI secure partition is missing');
      entries = await parseFs(file, size, secure.offset, 'HFS0');
    } else {
      entries = await parseFs(file, size, 0, 'PFS0');
    }
    const found = new Map<string, InspectedTitle>();
    let nacp: { name: string; publisher: string } | null = null;
    const tickets = keys ? await readTickets(file,size,entries,keys) : new Map<string, Buffer>();
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Inspection cancelled');
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.nacp') && entry.size <= 0x4000) {
        nacp = parseNacp(await readAt(file, entry.offset, entry.size, size)) ?? nacp;
      } else if (lower.endsWith('.cnmt') && !lower.endsWith('.cnmt.nca') && entry.size <= MAX_HEADER) {
        const title = parseCnmt(await readAt(file, entry.offset, Math.min(entry.size, 0x40), size));
        if (title) found.set(title.titleId, title);
      } else if ((lower.endsWith('.nca') || lower.endsWith('.ncz')) && keys?.get('header_key')) {
        const header = decryptNcaHeader(await readAt(file,entry.offset,Math.min(entry.size,0xC00),size),keys.get('header_key')!);
        if (!header) continue;
        const plainNczBody = lower.endsWith('.ncz') && (header[0x205] === 1 || header[0x205] === 2)
          ? await readSmallNczBody(file,size,entry).catch(() => null) : null;
        const title = lower.endsWith('.cnmt.nca') || lower.endsWith('.cnmt.ncz')
          ? await inspectMetaNca(file,size,entry,header,keys,tickets,plainNczBody).catch(() => null)
          : null;
        if (header[0x205] === 2 && !nacp) {
          nacp = await inspectControlNca(file,size,entry,header,keys,tickets,plainNczBody).catch(() => null);
        }
        if (title) found.set(title.titleId,title);
      }
    }
    if (nacp) {
      for (const title of found.values()) if (title.type === 'base') {
        title.name = nacp.name;
        title.publisher = nacp.publisher;
      }
    }
    return [...found.values()];
  } finally { await file.close(); }
}
