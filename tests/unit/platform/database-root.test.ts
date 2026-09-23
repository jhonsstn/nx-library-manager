import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveDatabaseRoot } from '@main/platform/database-root';
import { resolveAppPaths } from '@main/platform/paths';

describe('catalog database location', () => {
  it('stores the development database in the app root', () => {
    const root = resolveDatabaseRoot({
      isPackaged: false,
      appPath: resolve('/workspace/nx-library-manager'),
      executablePath: resolve('/tools/electron'),
      platform: 'win32',
    });
    expect(root).toBe(resolve('/workspace/nx-library-manager'));
    const paths = resolveAppPaths(resolve('/user-data/NX Library Manager'), root);
    expect(paths.databaseFile).toBe(join(root, 'library.sqlite3'));
    expect(paths.settingsFile).toBe(resolve('/user-data/NX Library Manager/settings.json'));
  });

  it('stores the packaged Windows database beside the executable', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: resolve('/apps/nlm/resources/app.asar'),
      executablePath: resolve('/apps/nlm/NX Library Manager.exe'),
      platform: 'win32',
    })).toBe(resolve('/apps/nlm'));
  });

  it('stores a portable Windows database beside the original portable executable', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: resolve('/tmp/portable/app.asar'),
      executablePath: resolve('/tmp/portable/NX Library Manager.exe'),
      platform: 'win32',
      portableExecutableDir: resolve('/games/catalog'),
    })).toBe(resolve('/games/catalog'));
  });

  it('stores the packaged macOS database beside the app bundle', () => {
    expect(resolveDatabaseRoot({
      isPackaged: true,
      appPath: resolve('/apps/NX Library Manager.app/Contents/Resources/app.asar'),
      executablePath: resolve('/apps/NX Library Manager.app/Contents/MacOS/NX Library Manager'),
      platform: 'darwin',
    })).toBe(resolve('/apps'));
  });

  it('allows an isolated development database for end-to-end tests', () => {
    expect(resolveDatabaseRoot({
      isPackaged: false,
      appPath: resolve('/workspace/nx-library-manager'),
      executablePath: resolve('/tools/electron'),
      platform: 'linux',
      developmentOverride: resolve('/tmp/catalog-test'),
    })).toBe(resolve('/tmp/catalog-test'));
  });
});
