import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  MetadataBulkProgressDto,
  ScanCompletedDto,
  ScanProgressDto,
  ShutdownStatusDto,
} from '@shared/types/domain';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { getCatalogApi } from '../api';
import { catalogKeysToInvalidate, queryKeys } from './keys';
import { useToast } from '../components/Toast';

interface AppEventsValue {
  scanProgress: ScanProgressDto | null;
  scanCompleted: ScanCompletedDto | null;
  bulkMetadata: MetadataBulkProgressDto | null;
  shutdownStatus: ShutdownStatusDto | null;
  clearScanCompleted: () => void;
}

const AppEventsContext = createContext<AppEventsValue | null>(null);

/**
 * Single subscription point for main-process events. Progress lands in local
 * state (it is presentation-only); durable changes invalidate query keys so the
 * React Query cache refetches instead of being trusted.
 */
export function AppEventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [scanProgress, setScanProgress] = useState<ScanProgressDto | null>(null);
  const [scanCompleted, setScanCompleted] = useState<ScanCompletedDto | null>(null);
  const [bulkMetadata, setBulkMetadata] = useState<MetadataBulkProgressDto | null>(null);
  const [shutdownStatus, setShutdownStatus] = useState<ShutdownStatusDto | null>(null);

  useEffect(() => {
    const unsubscribes: Array<() => void> = [];
    let disposed = false;

    const invalidateCatalog = async () => {
      for (const key of catalogKeysToInvalidate()) await queryClient.invalidateQueries({ queryKey: key });
    };

    void (async () => {
      const api = getCatalogApi();
      const registered = await Promise.all([
        api.scan.onProgress((event) => {
          setScanProgress(event);
          setScanCompleted(null);
        }),
        api.scan.onCompleted((event) => {
          setScanProgress(null);
          setScanCompleted(event);
          void invalidateCatalog();
          if (event.error) toast.error('Library scan failed', event.error.message);
        }),
        api.install.onChanged(() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.installJobs() });
          void invalidateCatalog();
        }),
        api.mtp.onStatusChanged((status) => {
          queryClient.setQueryData(queryKeys.mtpStatus(), status);
        }),
        api.mtp.onInventoryChanged((inventory) => {
          queryClient.setQueryData(queryKeys.mtpInventory(), inventory);
          void invalidateCatalog();
        }),
        api.httpServer.onStatusChanged((status) => {
          queryClient.setQueryData(queryKeys.httpServerStatus(), status);
        }),
        api.metadata.onBulkProgress((event) => {
          setBulkMetadata(event.done ? null : event);
          if (event.done) void invalidateCatalog();
        }),
        api.app.onVersionsChanged(() => {
          void invalidateCatalog();
        }),
        api.app.onShutdownStatus(setShutdownStatus),
      ]);
      if (disposed) registered.forEach((off) => off());
      else unsubscribes.push(...registered);
    })();

    return () => {
      disposed = true;
      for (const off of unsubscribes) off();
    };
  }, [queryClient, toast]);

  return (
    <AppEventsContext.Provider
      value={{
        scanProgress,
        scanCompleted,
        bulkMetadata,
        shutdownStatus,
        clearScanCompleted: () => setScanCompleted(null),
      }}
    >
      {children}
    </AppEventsContext.Provider>
  );
}

export function useAppEvents(): AppEventsValue {
  const context = useContext(AppEventsContext);
  if (!context) throw new Error('useAppEvents must be used inside <AppEventsProvider>.');
  return context;
}
