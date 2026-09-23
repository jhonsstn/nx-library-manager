import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProdKeysStore, parseProdKeys } from '@main/settings/prod-keys';
import { TEMP_ROOT } from '../../setup/vitest.setup';

const first = 'header_key = ' + '12'.repeat(16) + '34'.repeat(16) + '\nmaster_key_00 = ' + 'ab'.repeat(16);
const second = 'header_key = ' + '56'.repeat(16) + '78'.repeat(16) + '\nmaster_key_00 = ' + 'cd'.repeat(16);

describe('prod.keys storage', () => {
  it('validates required entries without exposing the plaintext in app data', () => {
    const dir = mkdtempSync(join(TEMP_ROOT,'keys-'));
    const input = join(dir,'prod.keys');
    const cipher = {
      encrypt: (value: string) => `encrypted:${Buffer.from(value).toString('base64')}`,
      decrypt: (value: string) => value.startsWith('encrypted:')
        ? Buffer.from(value.slice(10),'base64').toString('utf8') : null,
    };
    const store = new ProdKeysStore(dir,cipher);
    writeFileSync(input,first);
    store.importFile(input);
    expect(store.available).toBe(true);
    expect(store.read()?.get('header_key')).toHaveLength(32);
    expect(readFileSync(join(dir,'prod-keys.enc'),'utf8')).not.toContain('header_key');
    const revision = store.revision;
    writeFileSync(input,second);
    store.importFile(input);
    expect(store.revision).not.toBe(revision);
    store.remove();
    expect(store.available).toBe(false);
  });

  it('rejects malformed and incomplete files, and unavailable encrypted storage', () => {
    expect(() => parseProdKeys('header_key = abc\nmaster_key_00 = abc')).toThrow();
    expect(() => parseProdKeys('header_key = ' + '12'.repeat(32))).toThrow();
    expect(() => parseProdKeys('header_key = ' + '12'.repeat(16) + '\nmaster_key_00 = ' + 'ab'.repeat(16))).toThrow();
    const dir = mkdtempSync(join(TEMP_ROOT,'keys-'));
    const input = join(dir,'prod.keys');
    writeFileSync(input,first);
    expect(() => new ProdKeysStore(dir).importFile(input)).toThrow(/Encrypted key storage/);
  });
});
