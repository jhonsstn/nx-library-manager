import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { appError } from '../../shared/errors/app-error';
import type { SecretCipher } from './settings.store';

/** The encrypted file lives outside SQLite so catalog backups never contain keys. */
export class ProdKeysStore {
  private readonly file: string;
  constructor(userDataDir: string, private readonly cipher?: SecretCipher) {
    this.file = join(userDataDir, 'prod-keys.enc');
  }

  get available(): boolean {
    return Boolean(this.cipher && existsSync(this.file) && this.read());
  }

  get revision(): number {
    if (!this.available) return 0;
    const digest = createHash('sha256').update(readFileSync(this.file)).digest('hex').slice(0, 12);
    return Number.parseInt(digest, 16);
  }

  /** Main-process only. Never send this value over IPC or include it in logs. */
  read(): Map<string, Buffer> | null {
    if (!this.cipher || !existsSync(this.file)) return null;
    try {
      const plain = this.cipher.decrypt(readFileSync(this.file, 'utf8'));
      return plain ? parseProdKeys(plain) : null;
    } catch {
      return null;
    }
  }

  importFile(path: string): void {
    if (!this.cipher) throw appError('VALIDATION_ERROR', 'Encrypted key storage is unavailable on this system.');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw appError('VALIDATION_ERROR', 'Invalid prod.keys file size.');
    const plain = readFileSync(path, 'utf8');
    parseProdKeys(plain);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, this.cipher.encrypt(plain), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
  }

  remove(): void {
    if (existsSync(this.file)) unlinkSync(this.file);
  }
}

export function parseProdKeys(text: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([a-z][a-z0-9_]*)\s*=\s*([0-9a-fA-F]+)(?:\s*#.*)?$/.exec(trimmed);
    if (!match || match[2].length % 2 !== 0 || match[2].length < 32) {
      throw appError('VALIDATION_ERROR', 'Invalid prod.keys entry.');
    }
    keys.set(match[1], Buffer.from(match[2], 'hex'));
  }
  if (keys.get('header_key')?.length !== 32
    || !Array.from(keys.entries()).some(([name, value]) => /^master_key_[0-9a-f]{2}$/.test(name) && value.length === 16)) {
    throw appError('VALIDATION_ERROR', 'prod.keys must include a 32-byte header key and a 16-byte master key.');
  }
  return keys;
}
