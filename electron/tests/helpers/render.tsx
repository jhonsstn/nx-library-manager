import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AppEventsProvider } from '@renderer/query/AppEventsProvider';
import { ToastProvider } from '@renderer/components/Toast';
import { SelectionProvider } from '@renderer/app/SelectionProvider';
import { configureCatalogBridge } from '@renderer/api';
import { createFakeBridge, type FakeHandler } from './fakeBridge';

export interface RenderOptions {
  route?: string;
  handlers?: Record<string, FakeHandler>;
  withSelection?: boolean;
}

/**
 * Renders a component with the app's providers and an in-memory IPC transport.
 * Queries never retry, so failures surface immediately in assertions.
 */
export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): RenderResult {
  configureCatalogBridge(() => createFakeBridge(options.handlers ?? {}));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppEventsProvider>
          <MemoryRouter initialEntries={[options.route ?? '/']}>
            {options.withSelection === false ? ui : <SelectionProvider>{ui}</SelectionProvider>}
          </MemoryRouter>
        </AppEventsProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  return render(tree);
}
