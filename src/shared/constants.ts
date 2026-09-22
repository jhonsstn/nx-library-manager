export const SUPPORTED_FILE_EXTENSIONS = ['.nsp', '.nsz', '.xci'] as const;

export const DEFAULT_HTTP_SERVER_PORT = 8000;
export const DEFAULT_FUZZY_MATCH_THRESHOLD = 0.82;
export const DEFAULT_GRID_COVER_SIZE = 170;
export const GRID_COVER_SIZE_MIN = 110;
export const GRID_COVER_SIZE_MAX = 260;

/** Score returned when an update matched a base game through its title ID. */
export const TITLE_ID_MATCH_CONFIDENCE = 0.99;

/** Minimum IGDB candidate confidence applied without user review. */
export const MIN_AUTO_MATCH_CONFIDENCE = 0.86;

export const IGDB_SEARCH_CACHE_VERSION = 'v2';
export const IGDB_API_URL = 'https://api.igdb.com/v4/games';
export const IGDB_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const IGDB_SWITCH_PLATFORM_ID = 130;

export const TITLEDB_VERSIONS_URL = 'https://raw.githubusercontent.com/blawar/titledb/master/versions.json';
export const TITLEDB_VERSIONS_TXT_URL = 'https://raw.githubusercontent.com/blawar/titledb/master/versions.txt';
export const TITLEDB_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const RELEASES_API_URL =
  'https://api.github.com/repos/Theuniquejimmy/SwitchGameCatalog/releases/latest';
export const RELEASES_PAGE_URL = 'https://github.com/Theuniquejimmy/SwitchGameCatalog/releases';

export const CATALOG_IMAGE_SCHEME = 'catalog-image';

/** MTP status polling cadence. */
export const MTP_STATUS_REFRESH_MS = 60_000;
export const MTP_STATUS_TIMEOUT_SECONDS = 8;
/** Transfer timeout used by the PowerShell adapter. */
export const MTP_TRANSFER_TIMEOUT_SECONDS = 1800;

export const LOG_ROTATION_MAX_FILES = 5;
export const LOG_ROTATION_MAX_BYTES = 8 * 1024 * 1024;

/** Shell locations Windows exposes for an MTP-connected Switch. */
export const MTP_INSTALL_DESTINATIONS = {
  nand: { id: 'nand', label: 'NAND install', storageName: 'NAND Install' },
  sd: { id: 'sd', label: 'SD Card install', storageName: 'SD install' },
} as const;
