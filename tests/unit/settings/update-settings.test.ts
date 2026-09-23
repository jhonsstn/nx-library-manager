import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '@main/platform/paths';
import { SettingsStore } from '@main/settings/settings.store';
import { updateSettingsTransactional } from '@main/settings/update-settings';
import type { HttpServerService } from '@main/services/http-server.service';
import { appError } from '@shared/errors/app-error';
import { TEMP_ROOT } from '../../setup/vitest.setup';

describe('updateSettingsTransactional', () => {
  it('restores settings and the previous server after an occupied-port failure', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'settings-transaction-'));
    const paths = resolveAppPaths(dir, dir);
    const settings = new SettingsStore({ paths });
    settings.update({ httpServerEnabled: true, httpServerPort: 8000 });
    let runningPort = 8000;
    const applySettings = vi.fn(async () => {
      const port = settings.getFull().httpServerPort;
      if (port === 9000) {
        runningPort = 0;
        throw appError('HTTP_PORT_IN_USE', 'Port 9000 is already in use.');
      }
      runningPort = port;
      return {} as never;
    });
    const httpServer = { applySettings } as unknown as HttpServerService;

    await expect(
      updateSettingsTransactional({ settings, httpServer }, { httpServerPort: 9000 }),
    ).rejects.toMatchObject({ code: 'HTTP_PORT_IN_USE' });

    expect(settings.getFull().httpServerPort).toBe(8000);
    expect(new SettingsStore({ paths }).load().httpServerPort).toBe(8000);
    expect(runningPort).toBe(8000);
    expect(applySettings).toHaveBeenCalledTimes(2);
  });

  it('does not reconfigure the server for unrelated settings', async () => {
    const dir = mkdtempSync(join(TEMP_ROOT, 'settings-transaction-'));
    const settings = new SettingsStore({ paths: resolveAppPaths(dir, dir) });
    const applySettings = vi.fn();

    await updateSettingsTransactional(
      { settings, httpServer: { applySettings } as unknown as HttpServerService },
      { baseGamesFolder: '/games' },
    );

    expect(applySettings).not.toHaveBeenCalled();
  });
});
