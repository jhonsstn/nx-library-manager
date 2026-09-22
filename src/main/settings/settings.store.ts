import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { appError } from '../../shared/errors/app-error';
import { SettingsUpdateSchema, defaultAppSettings, parseAppSettings } from '../../shared/schemas/settings';
import type { AppSettings, PublicSettingsDto, SettingsUpdateInput } from '../../shared/types/settings';
import type { AppPaths } from '../platform/paths';

/**
 * Encrypts secrets at rest. The Electron `safeStorage` adapter is injected by
 * the main process; without a cipher secrets can neither be written nor read
 * (they are treated as absent instead of crashing).
 */
export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string | null;
}

const SECRET_FIELDS = ['igdbClientSecret', 'httpServerPassword'] as const;

interface SettingsStoreOptions {
  paths: AppPaths;
  cipher?: SecretCipher;
  now?(): number;
}

/**
 * Persists `settings.json` in the user-data directory.
 *
 * The stored form keeps `igdbClientSecret` / `httpServerPassword` as ciphertext;
 * plaintext only ever exists inside this process (and while importing the legacy
 * Qt settings, which stored secrets in the clear).
 */
export class SettingsStore {
  private readonly paths: AppPaths;
  private readonly cipher: SecretCipher | undefined;
  private readonly now: () => number;
  private settings: AppSettings | null = null;
  private tempCounter = 0;

  constructor(options: SettingsStoreOptions) {
    this.paths = options.paths;
    this.cipher = options.cipher;
    this.now = options.now ?? Date.now;
  }

  /** Reads and repairs `settings.json`. Never throws. */
  load(): PublicSettingsDto {
    this.settings = this.readFromDisk();
    return this.toPublic(this.settings);
  }

  /** Main-process view: secrets are decrypted in place. */
  getFull(): AppSettings {
    const stored = this.current();
    const full: AppSettings = { ...stored };
    for (const field of SECRET_FIELDS) {
      const plain = this.decryptSecret(stored[field]);
      if (plain) {
        full[field] = plain;
      } else {
        delete full[field];
      }
    }
    return full;
  }

  /** Decrypted secrets; empty strings when unset or undecryptable. */
  getSecrets(): { igdbClientSecret: string; httpServerPassword: string } {
    const stored = this.current();
    return {
      igdbClientSecret: this.decryptSecret(stored.igdbClientSecret),
      httpServerPassword: this.decryptSecret(stored.httpServerPassword),
    };
  }

  /**
   * Validates a partial update, merges it over the current settings, and
   * persists atomically. Secret semantics: `undefined` keeps, `null` clears, a
   * non-empty string replaces, and an empty string is a no-op.
   */
  update(input: SettingsUpdateInput): PublicSettingsDto {
    const parsed = SettingsUpdateSchema.safeParse(input);
    if (!parsed.success) {
      throw appError('VALIDATION_ERROR', 'Settings update is invalid.', {
        details: { issues: parsed.error.issues },
      });
    }

    const current = this.current();
    const next: AppSettings = { ...current };
    // `.strict()` guarantees only known keys survive validation; secrets are
    // applied separately because of their three-way semantics.
    const patch: Record<string, unknown> = { ...parsed.data };
    for (const field of SECRET_FIELDS) delete patch[field];
    Object.assign(next, patch);

    // `undefined` is stripped by the schema, so read the raw input for the
    // three-way secret semantics.
    const raw = input as Record<string, unknown>;
    for (const field of SECRET_FIELDS) {
      if (!Object.hasOwn(raw, field)) continue;
      const value = raw[field];
      if (value === undefined || value === '') continue;
      if (value === null) {
        delete next[field];
        continue;
      }
      if (typeof value !== 'string') continue;
      const encrypted = this.cipher?.encrypt(value);
      if (encrypted) {
        next[field] = encrypted;
      } else {
        delete next[field];
      }
    }

    this.writeAtomic(next);
    this.settings = next;
    return this.toPublic(next);
  }

  /** Strips both secrets and reports whether a non-empty value is stored. */
  toPublic(settings: AppSettings): PublicSettingsDto {
    const { igdbClientSecret, httpServerPassword, ...rest } = settings;
    return {
      ...rest,
      igdbClientSecretConfigured: isNonEmpty(igdbClientSecret),
      httpServerPasswordConfigured: isNonEmpty(httpServerPassword),
    };
  }

  private current(): AppSettings {
    if (this.settings === null) {
      this.settings = this.readFromDisk();
    }
    return this.settings;
  }

  private readFromDisk(): AppSettings {
    const file = this.paths.settingsFile;
    if (!existsSync(file)) return defaultAppSettings();

    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return defaultAppSettings();
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.repair(defaultAppSettings());
    }

    const sanitized = sanitizeSecrets(raw);
    let parsed: AppSettings;
    try {
      parsed = parseAppSettings(sanitized.raw);
    } catch {
      return this.repair(defaultAppSettings());
    }
    if (sanitized.droppedSecrets || wasRepaired(sanitized.raw, parsed)) {
      return this.repair(parsed);
    }
    return parsed;
  }

  /** Backs the unusable file up next to itself, then persists the repaired settings. */
  private repair(settings: AppSettings): AppSettings {
    try {
      this.backupUnreadableFile();
    } catch {
      /* keep going: a failed backup must not block startup */
    }
    try {
      this.writeAtomic(settings);
    } catch {
      /* defaults stay in memory even when the file cannot be rewritten */
    }
    return settings;
  }

  private backupUnreadableFile(): string {
    const file = this.paths.settingsFile;
    const stamp = this.now();
    let backup = `${file}.corrupt-${stamp}.bak`;
    let counter = 1;
    while (existsSync(backup)) {
      backup = `${file}.corrupt-${stamp}-${counter}.bak`;
      counter += 1;
    }
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(file, backup);
    return backup;
  }

  /** Temp file in the same directory + rename, so readers never see a partial file. */
  private writeAtomic(settings: AppSettings): void {
    const file = this.paths.settingsFile;
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    this.tempCounter += 1;
    const temp = join(dir, `${basename(file)}.${process.pid}.${this.tempCounter}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      renameSync(temp, file);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        /* the temp file was never created */
      }
      throw error;
    }
  }

  private decryptSecret(value: unknown): string {
    if (!isNonEmpty(value) || !this.cipher) return '';
    try {
      return this.cipher.decrypt(value) ?? '';
    } catch {
      return '';
    }
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Drops secret fields whose value is not a string: `parseAppSettings` has no
 * fallback for them, and one bad secret must not reset every other field.
 */
function sanitizeSecrets(raw: unknown): { raw: Record<string, unknown>; droppedSecrets: boolean } {
  const record: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  let droppedSecrets = false;
  for (const field of SECRET_FIELDS) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (typeof value === 'string') continue;
    delete record[field];
    droppedSecrets = true;
  }
  return { raw: record, droppedSecrets };
}

/** True when loading silently replaced a value, i.e. the file needs a backup. */
function wasRepaired(raw: Record<string, unknown>, parsed: AppSettings): boolean {
  const stored = parsed as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(stored, key)) continue;
    if (JSON.stringify(raw[key] ?? null) !== JSON.stringify(stored[key] ?? null)) return true;
  }
  return false;
}
