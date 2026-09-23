import { createCipheriv } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inspectPackage } from '@main/scanner/package-inspector';
import { TEMP_ROOT } from '../../setup/vitest.setup';

const BASE = '0100AABBCCDD0000';
const PATCH = '0100AABBCCDD0800';
const DLC = '0100AABBCCDD0001';

function cnmt(id: string, type: number, version: number, parent = BASE): Buffer {
  const data = Buffer.alloc(0x40);
  data.writeBigUInt64LE(BigInt(`0x${id}`),0);
  data.writeUInt32LE(version,8);
  data[0xC] = type;
  data.writeUInt16LE(type === 0x80 ? 0x10 : 0x18,0xE);
  data.writeBigUInt64LE(BigInt(`0x${parent}`),0x20);
  return data;
}

function fsContainer(magic: 'PFS0' | 'HFS0', files: Array<[string,Buffer]>): Buffer {
  const stride = magic === 'PFS0' ? 0x18 : 0x40;
  const strings = Buffer.from(files.map(([name]) => `${name}\0`).join(''));
  const headerSize = 0x10 + stride * files.length + strings.length;
  const total = files.reduce((sum,[,data]) => sum + data.length,headerSize);
  const result = Buffer.alloc(total);
  result.write(magic,0,'ascii');
  result.writeUInt32LE(files.length,4);
  result.writeUInt32LE(strings.length,8);
  strings.copy(result,0x10+stride*files.length);
  let contentAt = 0;
  let stringAt = 0;
  files.forEach(([name,data],index) => {
    const at = 0x10 + stride*index;
    result.writeBigUInt64LE(BigInt(contentAt),at);
    result.writeBigUInt64LE(BigInt(data.length),at+8);
    result.writeUInt32LE(stringAt,at+16);
    data.copy(result,headerSize+contentAt);
    contentAt += data.length;
    stringAt += Buffer.byteLength(name)+1;
  });
  return result;
}

function save(extension: string, data: Buffer): string {
  const dir = mkdtempSync(join(TEMP_ROOT,'package-'));
  const path = join(dir,`combined.${extension}`);
  writeFileSync(path,data);
  return path;
}

function encryptedMetaNca(data: Buffer, id: string, sectionStart = 0xC00,
  options: { contentType?: number; body?: Buffer } = {}):
  { nca: Buffer; plainBody: Buffer; keys: Map<string,Buffer> } {
  const headerKey = Buffer.alloc(32,0x19);
  headerKey.fill(0x1A,16);
  const areaKey = Buffer.alloc(16,0x25);
  const bodyKey = Buffer.alloc(16,0x32);
  const inner = options.body ?? fsContainer('PFS0', [['meta.cnmt',data]]);
  const sectionSize = Math.ceil(inner.length/0x200)*0x200;
  const plain = Buffer.alloc(0xC00);
  plain.write('NCA3',0x200,'ascii');
  plain[0x205] = options.contentType ?? 1;
  plain.writeBigUInt64LE(BigInt(`0x${id}`),0x210);
  plain.writeUInt32LE(sectionStart/0x200,0x240);
  plain.writeUInt32LE((sectionStart+sectionSize)/0x200,0x244);
  plain.writeUInt16LE(2,0x400);
  plain[0x402] = options.contentType === 2 ? 0 : 1;
  plain[0x403] = options.contentType === 2 ? 3 : 2;
  plain[0x404] = 3;
  if (options.contentType === 2) plain.writeUInt32LE(1,0x414);
  else plain.writeBigUInt64LE(BigInt(inner.length),0x448);
  const wrap = createCipheriv('aes-128-ecb',areaKey,null);
  wrap.setAutoPadding(false);
  Buffer.concat([wrap.update(bodyKey),wrap.final()]).copy(plain,0x320);
  const encryptedHeader = Buffer.alloc(0xC00);
  for (let sector=0;sector<6;sector+=1) {
    const tweak = Buffer.alloc(16);
    tweak.writeUInt32LE(sector,0);
    const cipher = createCipheriv('aes-128-xts',headerKey,tweak);
    Buffer.concat([cipher.update(plain.subarray(sector*0x200,(sector+1)*0x200)),cipher.final()])
      .copy(encryptedHeader,sector*0x200);
  }
  const body = Buffer.alloc(sectionSize);
  inner.copy(body);
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sectionStart/16),8);
  const cipher = createCipheriv('aes-128-ctr',bodyKey,iv);
  const encryptedBody = Buffer.concat([cipher.update(body),cipher.final()]);
  return { nca: Buffer.concat([encryptedHeader,Buffer.alloc(sectionStart-0xC00),encryptedBody]),
    plainBody:body,
    keys: new Map([['header_key',headerKey],['key_area_key_application_00',areaKey]]) };
}

describe('bounded package inspection', () => {
  it.each(['nsp','nsz'])('reads all CNMT titles in a combined %s', async (extension) => {
    const nacp = Buffer.alloc(0x300);
    nacp.write('Example Game',0,'utf8');
    nacp.write('Example Studio',0x200,'utf8');
    const packageFile = save(extension,fsContainer('PFS0',[
      ['base.cnmt',cnmt(BASE,0x80,0)],
      ['patch.cnmt',cnmt(PATCH,0x81,131072)],
      ['dlc.cnmt',cnmt(DLC,0x82,65536)],
      ['control.nacp',nacp],
    ]));
    const result = await inspectPackage(packageFile,null);
    expect(result).toHaveLength(3);
    expect(result.find((title) => title.type === 'base')).toMatchObject({ titleId:BASE,
      name:'Example Game',publisher:'Example Studio',source:'cnmt' });
    expect(result.find((title) => title.type === 'update')).toMatchObject({ titleId:PATCH,
      baseTitleId:BASE,rawVersion:131072 });
    expect(result.find((title) => title.type === 'dlc')).toMatchObject({ titleId:DLC,
      baseTitleId:BASE,rawVersion:65536 });
  });

  it('reads CNMT in an XCI secure partition', async () => {
    const secure = fsContainer('HFS0',[['base.cnmt',cnmt(BASE,0x80,0)]]);
    const root = fsContainer('HFS0',[['secure',secure]]);
    const card = Buffer.alloc(0x200);
    card.writeBigUInt64LE(0x200n,0x130);
    const result = await inspectPackage(save('xci',Buffer.concat([card,root])),null);
    expect(result.map((title) => title.titleId)).toEqual([BASE]);
  });

  it('decrypts a CNMT from an NCA with imported test keys', async () => {
    const fixture = encryptedMetaNca(cnmt(PATCH,0x81,196608),PATCH);
    const path = save('nsp',fsContainer('PFS0',[['meta.cnmt.nca',fixture.nca]]));
    expect(await inspectPackage(path,fixture.keys)).toMatchObject([{
      titleId:PATCH,baseTitleId:BASE,rawVersion:196608,source:'cnmt',type:'update',
    }]);
    expect(await inspectPackage(path,null)).toEqual([]);
  });

  it('reads an NACP name and publisher from a Control NCA RomFS', async () => {
    const nacp = Buffer.alloc(0x300);
    nacp.write('Control Name',0);
    nacp.write('Control Publisher',0x200);
    const romfs = Buffer.alloc(0x94+nacp.length);
    romfs.writeBigUInt64LE(0x50n,0);
    romfs.writeBigUInt64LE(0x50n,0x18);
    romfs.writeBigUInt64LE(0x18n,0x20);
    romfs.writeBigUInt64LE(0x68n,0x38);
    romfs.writeBigUInt64LE(0x2Cn,0x40);
    romfs.writeBigUInt64LE(0x94n,0x48);
    romfs.writeUInt32LE(0,0x50+0xC);
    romfs.writeUInt32LE(0xFFFFFFFF,0x68+4);
    romfs.writeBigUInt64LE(BigInt(nacp.length),0x68+0x10);
    romfs.writeUInt32LE(12,0x68+0x1C);
    romfs.write('control.nacp',0x68+0x20);
    nacp.copy(romfs,0x94);
    const control = encryptedMetaNca(Buffer.alloc(0),BASE,0xC00,{ contentType:2,body:romfs });
    const path = save('nsp',fsContainer('PFS0',[
      ['base.cnmt',cnmt(BASE,0x80,0)],
      ['control.nca',control.nca],
    ]));
    expect(await inspectPackage(path,control.keys)).toMatchObject([{
      titleId:BASE,name:'Control Name',publisher:'Control Publisher',source:'cnmt',
    }]);
  });

  it('reads a compressed Meta NCZ without expanding game content', async () => {
    const fixture = encryptedMetaNca(cnmt(DLC,0x82,65536),DLC,0x4000);
    const nczHeader = Buffer.alloc(8+0x48);
    nczHeader.writeBigUInt64LE(1n,0);
    nczHeader.write('NCZSECTN',8,'ascii');
    nczHeader.writeBigUInt64LE(0x4000n,16);
    nczHeader.writeBigUInt64LE(BigInt(fixture.plainBody.length),24);
    const ncz = Buffer.concat([fixture.nca.subarray(0,0x4000),nczHeader,zstdCompressSync(fixture.plainBody)]);
    const path = save('nsz',fsContainer('PFS0',[['meta.cnmt.ncz',ncz]]));
    expect(await inspectPackage(path,fixture.keys)).toMatchObject([{
      titleId:DLC,baseTitleId:BASE,rawVersion:65536,source:'cnmt',type:'dlc',
    }]);
  });

  it('reads block-compressed Meta NCZ metadata', async () => {
    const fixture = encryptedMetaNca(cnmt(PATCH,0x81,262144),PATCH,0x4000);
    const section = Buffer.alloc(8+0x48);
    section.writeBigUInt64LE(1n,0);
    section.write('NCZSECTN',8,'ascii');
    const packed = zstdCompressSync(fixture.plainBody);
    const block = Buffer.alloc(28);
    block.write('NCZBLOCK',0,'ascii');
    block[11] = 14;
    block.writeUInt32LE(1,12);
    block.writeBigUInt64LE(BigInt(fixture.plainBody.length),16);
    block.writeUInt32LE(packed.length,24);
    const ncz = Buffer.concat([fixture.nca.subarray(0,0x4000),section,block,packed]);
    const path = save('nsz',fsContainer('PFS0',[['meta.cnmt.ncz',ncz]]));
    expect(await inspectPackage(path,fixture.keys)).toMatchObject([{
      titleId:PATCH,rawVersion:262144,source:'cnmt',type:'update',
    }]);
  });

  it('rejects corrupt containers and honours cancellation', async () => {
    await expect(inspectPackage(save('nsp',Buffer.from('bad')),null)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    const path = save('nsp',fsContainer('PFS0',[['base.cnmt',cnmt(BASE,0x80,0)]]));
    await expect(inspectPackage(path,null,controller.signal)).rejects.toThrow('cancelled');
  });
});
