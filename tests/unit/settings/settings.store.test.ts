import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SettingsStore, type SecretCipher } from '@main/settings/settings.store';
import { resolveAppPaths, type AppPaths } from '@main/platform/paths';
import { SwitchCatalogError } from '@shared/errors/app-error';
import { defaultAppSettings } from '@shared/schemas/settings';
import type { PublicSettingsDto, SettingsUpdateInput } from '@shared/types/settings';
import { DEFAULT_FUZZY_MATCH_THRESHOLD, DEFAULT_GRID_COVER_SIZE, DEFAULT_HTTP_SERVER_PORT } from '@shared/constants';

import { TEMP_ROOT } from '../../setup/vitest.setup';

const FIXED_NOW = 1_700_000_000_000;

/** Prefix cipher: round-trips and keeps the plaintext out of the file. */
const cipher: SecretCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (payload) =>
    payload.startsWith('enc:') ? Buffer.from(payload.slice(4), 'base64').toString('utf8') : null,
};

function makeStore(): { dir: string; paths: AppPaths; store: SettingsStore } {
  const dir = mkdtempSync(join(TEMP_ROOT, 'case-'));
  const paths = resolveAppPaths(dir);
  const store = new SettingsStore({ paths, cipher, now: () => FIXED_NOW });
  return { dir, paths, store };
}

function writeSettings(paths: AppPaths, value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  writeFileSync(paths.settingsFile, text, 'utf8');
  return text;
}

function backupPath(paths: AppPaths): string {
  return `${paths.settingsFile}.corrupt-${FIXED_NOW}.bak`;
}

function expectValidationError(run: () => void): void {
  try {
    run();
    throw new Error('expected the update to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(SwitchCatalogError);
    expect((error as SwitchCatalogError).code).toBe('VALIDATION_ERROR');
  }
}

describe('SettingsStore.load', () => {
  it('returns defaults without writing when settings.json is absent', () => {
    const { paths, store } = makeStore();

    const settings = store.load();

    expect(settings).toEqual({
      ...defaultAppSettings(),
      igdbClientSecretConfigured: false,
      httpServerPasswordConfigured: false,
    });
    expect(existsSync(paths.settingsFile)).toBe(false);
  });

  it('falls back per field and backs the invalid file up', () => {
    const { paths, store } = makeStore();
    const original = writeSettings(paths, {
      schemaVersion: 1,
      baseGamesFolder: '/roms',
      httpServerPort: 999999,
      gridCoverSize: 9999,
      scanRecursively: 'yes',
      fuzzyMatchThreshold: 5,
    });

    const settings = store.load();

    expect(settings.baseGamesFolder).toBe('/roms');
    expect(settings.httpServerPort).toBe(DEFAULT_HTTP_SERVER_PORT);
    expect(settings.gridCoverSize).toBe(DEFAULT_GRID_COVER_SIZE);
    expect(settings.scanRecursively).toBe(true);
    expect(settings.fuzzyMatchThreshold).toBe(DEFAULT_FUZZY_MATCH_THRESHOLD);

    expect(readFileSync(backupPath(paths), 'utf8')).toBe(original);
    const repaired: unknown = JSON.parse(readFileSync(paths.settingsFile, 'utf8'));
    expect(repaired).toMatchObject({ baseGamesFolder: '/roms', httpServerPort: DEFAULT_HTTP_SERVER_PORT });
  });

  it('keeps the other fields when a secret has the wrong type', () => {
    const { paths, store } = makeStore();
    writeSettings(paths, { baseGamesFolder: '/roms', igdbClientSecret: 42, httpServerPort: '8000' });

    const settings = store.load();

    expect(settings.baseGamesFolder).toBe('/roms');
    expect(settings.igdbClientSecretConfigured).toBe(false);
    expect(existsSync(backupPath(paths))).toBe(true);
  });

  it('replaces malformed JSON with defaults without throwing', () => {
    const { paths, store } = makeStore();
    const broken = writeSettings(paths, '{ "baseGamesFolder": "/roms",');

    expect(() => store.load()).not.toThrow();
    expect(store.load().baseGamesFolder).toBe('');
    expect(readFileSync(backupPath(paths), 'utf8')).toBe(broken);
    expect(() => JSON.parse(readFileSync(paths.settingsFile, 'utf8'))).not.toThrow();
  });

  it('does not leave temp files behind and round-trips through update', () => {
    const { dir, paths, store } = makeStore();

    store.update({ baseGamesFolder: '/roms', httpServerPort: 9001, igdbClientSecret: 'igdb-secret' });
    store.update({ updatesFolder: '/updates' });
    store.update({ gridCoverSize: 200 });

    expect(readdirSync(dir)).toEqual(['settings.json']);

    const reloaded = new SettingsStore({ paths, cipher });
    const settings = reloaded.load();
    expect(settings).toMatchObject({
      baseGamesFolder: '/roms',
      updatesFolder: '/updates',
      httpServerPort: 9001,
      gridCoverSize: 200,
      igdbClientSecretConfigured: true,
    });
    expect(reloaded.getSecrets()).toEqual({ igdbClientSecret: 'igdb-secret', httpServerPassword: '' });
  });
});

describe('SettingsStore secrets', () => {
  it('never returns or persists a secret value in the public view', () => {
    const { paths, store } = makeStore();

    store.update({ igdbClientSecret: 'igdb-secret', httpServerPassword: 'server-secret' });

    const settings: PublicSettingsDto = store.load();
    expect(Object.keys(settings)).not.toContain('igdbClientSecret');
    expect(Object.keys(settings)).not.toContain('httpServerPassword');
    expect(JSON.stringify(settings)).not.toContain('igdb-secret');
    expect(settings.igdbClientSecretConfigured).toBe(true);
    expect(settings.httpServerPasswordConfigured).toBe(true);

    const file = readFileSync(paths.settingsFile, 'utf8');
    expect(file).not.toContain('igdb-secret');
    expect(file).not.toContain('server-secret');
    expect(file).toContain('enc:');
    expect(store.getSecrets()).toEqual({ igdbClientSecret: 'igdb-secret', httpServerPassword: 'server-secret' });
  });

  it('keeps, clears and replaces secrets like the UI expects', () => {
    const { store } = makeStore();
    store.update({ igdbClientSecret: 'first', httpServerPassword: 'server' });

    const kept = store.update({ baseGamesFolder: '/roms', igdbClientSecret: undefined });
    expect(kept.igdbClientSecretConfigured).toBe(true);
    expect(store.getSecrets().igdbClientSecret).toBe('first');

    const emptyIsNoop = store.update({ igdbClientSecret: '' });
    expect(emptyIsNoop.igdbClientSecretConfigured).toBe(true);
    expect(store.getSecrets().igdbClientSecret).toBe('first');

    const cleared = store.update({ igdbClientSecret: null });
    expect(cleared.igdbClientSecretConfigured).toBe(false);
    expect(store.getSecrets().igdbClientSecret).toBe('');
    expect(cleared.httpServerPasswordConfigured).toBe(true);

    const replaced = store.update({ httpServerPassword: 'second' });
    expect(replaced.httpServerPasswordConfigured).toBe(true);
    expect(store.getSecrets().httpServerPassword).toBe('second');
  });

  it('treats secrets as absent when no cipher is configured', () => {
    const { paths } = makeStore();
    const cipherless = new SettingsStore({ paths });

    cipherless.update({ igdbClientSecret: 'igdb-secret' });

    expect(cipherless.load().igdbClientSecretConfigured).toBe(false);
    expect(cipherless.getSecrets().igdbClientSecret).toBe('');
    expect(cipherless.getFull().igdbClientSecret).toBeUndefined();
    expect(readFileSync(paths.settingsFile, 'utf8')).not.toContain('igdb-secret');
  });
});

describe('SettingsStore.update', () => {
  it('rejects an out-of-range port', () => {
    const { store } = makeStore();
    expectValidationError(() => store.update({ httpServerPort: 0 }));
  });

  it('rejects an unknown key', () => {
    const { store } = makeStore();
    expectValidationError(() => store.update({ nonsense: true } as unknown as SettingsUpdateInput));
  });
});
