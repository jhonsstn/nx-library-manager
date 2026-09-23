import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { App } from './app/App';
import { ToastProvider } from './components/Toast';
import { AppEventsProvider } from './query/AppEventsProvider';
import { createQueryClient } from './query/client';
import './styles/tokens.css';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('Renderer root element is missing.');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <AppEventsProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </AppEventsProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
