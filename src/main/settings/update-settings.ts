import type { SettingsUpdateInput, PublicSettingsDto } from '../../shared/types/settings';
import type { SettingsStore } from './settings.store';
import type { HttpServerService } from '../services/http-server.service';
import type { Logger } from '../lifecycle/logger';

const HTTP_SETTINGS = new Set([
  'httpServerEnabled',
  'httpServerPort',
  'httpServerUsername',
  'httpServerPassword',
]);

export async function updateSettingsTransactional(
  dependencies: { settings: SettingsStore; httpServer: HttpServerService; logger?: Logger },
  input: SettingsUpdateInput,
): Promise<PublicSettingsDto> {
  const httpChanged = Object.keys(input).some((key) => HTTP_SETTINGS.has(key));
  const snapshot = httpChanged ? dependencies.settings.snapshot() : null;
  const publicSettings = dependencies.settings.update(input);
  if (!snapshot) return publicSettings;

  try {
    await dependencies.httpServer.applySettings();
    return publicSettings;
  } catch (error) {
    dependencies.settings.restore(snapshot);
    try {
      await dependencies.httpServer.applySettings();
    } catch (rollbackError) {
      dependencies.logger?.error('settings.httpRollbackFailed', {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  }
}
