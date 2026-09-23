import { QueryClient } from '@tanstack/react-query';

/**
 * The React Query cache is never authoritative (spec 01); these defaults keep it
 * responsive without pretending to own main-process state.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
