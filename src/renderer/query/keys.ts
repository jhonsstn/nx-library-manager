import type { ListGamesInput, ListUpdatesInput } from '@shared/contracts/api';

/** Query key factory (spec 12). Invalidate the smallest set that fits. */
export const queryKeys = {
  games: (filters: ListGamesInput) => ['games', filters] as const,
  game: (gameId: number) => ['game', gameId] as const,
  genres: () => ['genres'] as const,
  updates: (filters: ListUpdatesInput) => ['updates', filters] as const,
  settings: () => ['settings'] as const,
  mtpStatus: () => ['mtp-status'] as const,
  mtpInventory: () => ['mtp-inventory'] as const,
  httpServerStatus: () => ['http-server-status'] as const,
  installJobs: () => ['install-jobs'] as const,
  appVersion: () => ['app-version'] as const,
};

export const catalogKeysToInvalidate = () => [
  ['games'],
  ['game'],
  ['genres'],
  ['updates'],
] as const;
