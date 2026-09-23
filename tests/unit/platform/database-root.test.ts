import { describe, expect, it } from 'vitest';
import { resolveDatabaseRoot } from '@main/platform/database-root';
import { resolveAppPaths } from '@main/platform/paths';

describe('catalog database location', () => {
  it('stores the development database in the app root', () => {
    const root = resolveDatabaseRoot({
      isPackaged: false,
      appPath: '/workspace/nx-library-manager',
      executablePath: '/tools/electron',
      platform: 'win32',
    });
    expect(root).toBe('/workspace/nx-library-manager');
    const paths = resolveAppPaths('/user-data/NX Library Manager', root);
    expect(paths.databaseFile).toBe('/workspace/nx-library-manager/library.sqlite3');
    expect(paths.settingsFile).toBe('/user-data/NX Library Manager/settings.json');
  });

  it('stores the packaged Windows database beside the executable', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: '/apps/nlm/resources/app.asar',
      executablePath: '/apps/nlm/NX Library Manager.exe',
      platform: 'win32',
    })).toBe('/apps/nlm');
  });

  it('stores a portable Windows database beside the original portable executable', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: '/tmp/portable/app.asar',
      executablePath: '/tmp/portable/NX Library Manager.exe',
      platform: 'win32',
      portableExecutableDir: '/games/catalog',
    })).toBe('/games/catalog');
  });

  it('stores the packaged macOS database beside the app bundle', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: '/apps/NX Library Manager.app/Contents/Resources/app.asar',
      executablePath: '/apps/NX Library Manager.app/Contents/MacOS/NX Library Manager',
      platform: 'darwin',
    })).toBe('/apps');
  });

  it('allows an isolated development database for end-to-end tests', () => {
    expect(resolveDatabaseRoot({
      isPackaged: false,
      appPath: '/workspace/nx-library-manager',
      executablePath: '/tools/electron',
      platform: 'linux',
      developmentOverride: '/tmp/catalog-test',
    })).toBe('/tmp/catalog-test');
  });
});
