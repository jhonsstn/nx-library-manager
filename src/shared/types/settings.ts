/**
 * Settings model owned by the main process. Persisted as `settings.json` in the
 * Electron user-data directory.
 *
 * `igdbClientSecret` and `httpServerPassword` are write-only: `settings.get()`
 * never returns their values, only whether they are configured.
 */
export interface AppSettings {
  schemaVersion: number;

  baseGamesFolder: string;
  updatesFolder: string;

  scanRecursively: boolean;
  fuzzyMatchThreshold: number;
  autoRescanOnStartup: boolean;
  autoCheckUpdatesOnStartup: boolean;
  cacheImages: boolean;

  metadataProvider: 'igdb';
  igdbClientId: string;
  igdbClientSecret?: string;

  httpServerEnabled: boolean;
  httpServerPort: number;
  httpServerUsername: string;
  httpServerPassword?: string;

  defaultInstallDestination: 'folder' | 'mtp-sd' | 'mtp-nand';
  defaultInstallFolder: string;
  installFolderLabel: string;

  gridCoverSize: number;

  /** Set once the user answers the first-run legacy import prompt. */
  legacyImportDismissed: boolean;
}

/** Renderer-safe projection: secrets are replaced by configured flags. */
export type PublicSettingsDto = Omit<AppSettings, 'igdbClientSecret' | 'httpServerPassword'> & {
  igdbClientSecretConfigured: boolean;
  httpServerPasswordConfigured: boolean;
};

/**
 * Partial update. For the two secret fields:
 * - `undefined` keeps the stored value,
 * - `null` clears it,
 * - a non-empty string replaces it.
 */
export type SettingsUpdateInput = Partial<
  Omit<AppSettings, 'schemaVersion' | 'igdbClientSecret' | 'httpServerPassword'>
> & {
  igdbClientSecret?: string | null;
  httpServerPassword?: string | null;
};
