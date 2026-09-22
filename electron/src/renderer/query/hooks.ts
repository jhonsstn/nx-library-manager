import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type {
  AssignUpdatesInput,
  CreateInstallInput,
  DeleteFileInput,
  ListGamesInput,
  ListUpdatesInput,
  MoveFileInput,
  ScanInput,
} from '@shared/contracts/api';
import type { MetadataCandidateDto, PagedResult, GameSummaryDto } from '@shared/types/domain';
import type { SettingsUpdateInput } from '@shared/types/settings';
import { getCatalogApi } from '../api';
import { catalogKeysToInvalidate, queryKeys } from './keys';

/* ---------------------------------------------------------------- queries */

export function useGames(filters: ListGamesInput) {
  return useQuery({
    queryKey: queryKeys.games(filters),
    queryFn: () => getCatalogApi().catalog.listGames(filters),
    placeholderData: keepPreviousData,
  });
}

export function useGame(gameId: number | null) {
  return useQuery({
    queryKey: queryKeys.game(gameId ?? 0),
    queryFn: () => getCatalogApi().catalog.getGame(gameId as number),
    enabled: gameId !== null,
  });
}

export function useGenres() {
  return useQuery({ queryKey: queryKeys.genres(), queryFn: () => getCatalogApi().catalog.getGenres() });
}

export function useUpdates(filters: ListUpdatesInput = {}) {
  return useQuery({
    queryKey: queryKeys.updates(filters),
    queryFn: () => getCatalogApi().catalog.listUpdates(filters),
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings(), queryFn: () => getCatalogApi().settings.get() });
}

export function useMtpStatus() {
  return useQuery({
    queryKey: queryKeys.mtpStatus(),
    queryFn: () => getCatalogApi().mtp.getStatus(),
    refetchInterval: 60_000,
  });
}

export function useHttpServerStatus() {
  return useQuery({
    queryKey: queryKeys.httpServerStatus(),
    queryFn: () => getCatalogApi().httpServer.getStatus(),
  });
}

export function useInstallJobs() {
  return useQuery({ queryKey: queryKeys.installJobs(), queryFn: () => getCatalogApi().install.list() });
}

export function useAppVersion() {
  return useQuery({ queryKey: queryKeys.appVersion(), queryFn: () => getCatalogApi().app.getVersion() });
}

export function useLegacyDataInfo(enabled = true) {
  return useQuery({
    queryKey: queryKeys.legacyDataInfo(),
    queryFn: () => getCatalogApi().app.getLegacyDataInfo(),
    enabled,
  });
}

/* -------------------------------------------------------------- mutations */

/** Invalidates every catalog-shaped query after a mutation. */
export function useInvalidateCatalog(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
  };
}

export function useSetFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, favorite }: { gameId: number; favorite: boolean }) =>
      getCatalogApi().catalog.setFavorite(gameId, favorite),
    onSuccess: async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useSetNeedsReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, value }: { gameId: number; value: boolean }) =>
      getCatalogApi().catalog.setNeedsReview(gameId, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['games'] });
      await queryClient.invalidateQueries({ queryKey: ['game'] });
    },
  });
}

export function useMarkAsUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gameId: number) => getCatalogApi().catalog.markAsUpdate(gameId),
    onSuccess: async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useAssignUpdates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignUpdatesInput) => getCatalogApi().catalog.assignUpdates(input),
    onSuccess: async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useUnmatchUpdates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updateIds: number[]) => getCatalogApi().catalog.unmatchUpdates(updateIds),
    onSuccess: async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useScan() {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: (input: ScanInput) => getCatalogApi().scan.start(input),
  });
  const cancel = useMutation({
    mutationFn: (jobId: string) => getCatalogApi().scan.cancel(jobId),
  });
  return {
    start,
    cancel,
    invalidate: async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    },
  };
}

export function useResetLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => getCatalogApi().catalog.resetLibrary(),
    onSuccess: async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useExportBackup() {
  return useMutation({ mutationFn: () => getCatalogApi().catalog.exportBackup() });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdateInput) => getCatalogApi().settings.update(input),
    onSuccess: async (settings) => {
      queryClient.setQueryData(queryKeys.settings(), settings);
      await queryClient.invalidateQueries({ queryKey: queryKeys.mtpStatus() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.httpServerStatus() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.games({}) });
    },
  });
}

export function useMetadataMutations() {
  const queryClient = useQueryClient();
  const invalidateGame = async (gameId: number) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.game(gameId) });
    for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
  };
  return {
    search: useMutation({
      mutationFn: ({ gameId, query }: { gameId: number; query?: string }) =>
        getCatalogApi().metadata.search(gameId, query),
    }),
    apply: useMutation({
      mutationFn: ({ gameId, candidate }: { gameId: number; candidate: MetadataCandidateDto }) =>
        getCatalogApi().metadata.apply(gameId, candidate),
      onSuccess: async (details) => invalidateGame(details.id),
    }),
    refresh: useMutation({
      mutationFn: (gameId: number) => getCatalogApi().metadata.refresh(gameId),
      onSuccess: async (_job, gameId) => invalidateGame(gameId),
    }),
    bulkRefresh: useMutation({
      mutationFn: (input: { force?: boolean; limit?: number }) => getCatalogApi().metadata.bulkRefresh(input),
    }),
  };
}

export function useFileMutations() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
  };
  return {
    chooseDirectory: useMutation({
      mutationFn: (input: { title?: string; defaultPath?: string; mtp?: boolean }) =>
        getCatalogApi().files.chooseDirectory(input),
    }),
    deleteFile: useMutation({
      mutationFn: (input: DeleteFileInput) => getCatalogApi().files.deleteFile(input),
      onSuccess: invalidate,
    }),
    moveFile: useMutation({
      mutationFn: (input: MoveFileInput) => getCatalogApi().files.moveFile(input),
      onSuccess: invalidate,
    }),
  };
}

export function useInstallMutations() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.installJobs() });
    for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
  };
  return {
    create: useMutation({
      mutationFn: (input: CreateInstallInput) => getCatalogApi().install.create(input),
      onSuccess: invalidate,
    }),
    cancel: useMutation({
      mutationFn: (jobId: number) => getCatalogApi().install.cancel(jobId),
      onSuccess: invalidate,
    }),
    retryFailed: useMutation({ mutationFn: () => getCatalogApi().install.retryFailed(), onSuccess: invalidate }),
  };
}

export function useServerMutations() {
  const queryClient = useQueryClient();
  const setStatus = (status: unknown) => queryClient.setQueryData(queryKeys.httpServerStatus(), status);
  return {
    start: useMutation({ mutationFn: () => getCatalogApi().httpServer.start(), onSuccess: setStatus }),
    stop: useMutation({ mutationFn: () => getCatalogApi().httpServer.stop(), onSuccess: setStatus }),
    refreshMtp: useMutation({
      mutationFn: () => getCatalogApi().mtp.refresh(),
      onSuccess: (status) => queryClient.setQueryData(queryKeys.mtpStatus(), status),
    }),
  };
}

export type { PagedResult, GameSummaryDto, ListGamesInput, ListUpdatesInput };
