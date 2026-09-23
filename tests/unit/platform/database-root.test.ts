import { describe, expect, it } from 'vitest';
import { resolveDatabaseRoot } from '@main/platform/database-root';
import { resolveAppPaths } from '@main/platform/paths';

describe('catalog database location', () => {
  it('stores the development database in the app root', () => {
    const root = resolveDatabaseRoot({
      isPackaged: false,
      appPath: '/workspace/switch-game-catalog',
      executablePath: '/tools/electron',
      platform: 'win32',
    });
    expect(root).toBe('/workspace/switch-game-catalog');
    const paths = resolveAppPaths('/user-data/Switch Game Catalog', root);
    expect(paths.databaseFile).toBe('/workspace/switch-game-catalog/library.sqlite3');
    expect(paths.settingsFile).toBe('/user-data/Switch Game Catalog/settings.json');
  });

  it('stores the packaged Windows database beside the executable', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: '/apps/sgc/resources/app.asar',
      executablePath: '/apps/sgc/Switch Game Catalog.exe',
      platform: 'win32',
    })).toBe('/apps/sgc');
  });

  it('stores a portable Windows database beside the original portable executable', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: '/tmp/portable/app.asar',
      executablePath: '/tmp/portable/Switch Game Catalog.exe',
      platform: 'win32',
      portableExecutableDir: '/games/catalog',
    })).toBe('/games/catalog');
  });

  it('stores the packaged macOS database beside the app bundle', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: '/apps/Switch Game Catalog.app/Contents/Resources/app.asar',
      executablePath: '/apps/Switch Game Catalog.app/Contents/MacOS/Switch Game Catalog',
      platform: 'darwin',
    })).toBe('/apps');
  });

  it('allows an isolated development database for end-to-end tests', () => {
    expect(resolveDatabaseRoot({
      isPackaged: false,
      appPath: '/workspace/switch-game-catalog',
      executablePath: '/tools/electron',
      platform: 'linux',
      developmentOverride: '/tmp/catalog-test',
    })).toBe('/tmp/catalog-test');
  });
});
