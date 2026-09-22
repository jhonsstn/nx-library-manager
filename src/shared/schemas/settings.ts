import { z } from 'zod';
import {
  DEFAULT_FUZZY_MATCH_THRESHOLD,
  DEFAULT_GRID_COVER_SIZE,
  DEFAULT_HTTP_SERVER_PORT,
  GRID_COVER_SIZE_MAX,
  GRID_COVER_SIZE_MIN,
} from '../constants';
import type { AppSettings } from '../types/settings';

export const APP_SETTINGS_SCHEMA_VERSION = 1;

const folder = z.string();
const port = z.number().int().min(1).max(65535).catch(DEFAULT_HTTP_SERVER_PORT);
const threshold = z.number().min(0).max(1).catch(DEFAULT_FUZZY_MATCH_THRESHOLD);
const gridCoverSize = z
  .number()
  .int()
  .min(GRID_COVER_SIZE_MIN)
  .max(GRID_COVER_SIZE_MAX)
  .catch(DEFAULT_GRID_COVER_SIZE);

const INSTALL_DESTINATIONS = ['folder', 'mtp-sd', 'mtp-nand'] as const;

/**
 * Persisted settings. Every field falls back to a safe default, so a partially
 * corrupt `settings.json` degrades field by field instead of failing to load.
 */
export const AppSettingsSchema = z.object({
  schemaVersion: z.number().int().positive().catch(APP_SETTINGS_SCHEMA_VERSION),
  baseGamesFolder: folder.catch(''),
  updatesFolder: folder.catch(''),
  scanRecursively: z.boolean().catch(true),
  fuzzyMatchThreshold: threshold,
  autoRescanOnStartup: z.boolean().catch(false),
  autoCheckUpdatesOnStartup: z.boolean().catch(true),
  cacheImages: z.boolean().catch(true),
  metadataProvider: z.literal('igdb').catch('igdb'),
  igdbClientId: z.string().catch(''),
  igdbClientSecret: z.string().optional(),
  httpServerEnabled: z.boolean().catch(false),
  httpServerPort: port,
  httpServerUsername: z.string().catch(''),
  httpServerPassword: z.string().optional(),
  defaultInstallDestination: z.enum(INSTALL_DESTINATIONS).catch('folder'),
  defaultInstallFolder: folder.catch(''),
  installFolderLabel: z.string().catch(''),
  gridCoverSize,
});

/** Update input: strict (invalid values are a validation error, not a default). */
export const SettingsUpdateSchema = z
  .object({
    baseGamesFolder: z.string(),
    updatesFolder: z.string(),
    scanRecursively: z.boolean(),
    fuzzyMatchThreshold: z.number().min(0).max(1),
    autoRescanOnStartup: z.boolean(),
    autoCheckUpdatesOnStartup: z.boolean(),
    cacheImages: z.boolean(),
    metadataProvider: z.literal('igdb'),
    igdbClientId: z.string(),
    igdbClientSecret: z.string().nullable(),
    httpServerEnabled: z.boolean(),
    httpServerPort: z.number().int().min(1).max(65535),
    httpServerUsername: z.string(),
    httpServerPassword: z.string().nullable(),
    defaultInstallDestination: z.enum(INSTALL_DESTINATIONS),
    defaultInstallFolder: z.string(),
    installFolderLabel: z.string(),
    gridCoverSize: z.number().int().min(GRID_COVER_SIZE_MIN).max(GRID_COVER_SIZE_MAX),
  })
  .partial()
  .strict();

/** Defaults are derived from the schema so there is a single source of truth. */
export function defaultAppSettings(): AppSettings {
  return AppSettingsSchema.parse({}) as AppSettings;
}

export function parseAppSettings(raw: unknown): AppSettings {
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return AppSettingsSchema.parse(candidate) as AppSettings;
}
