import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './index.css';
import { App } from './App';
import { installQueueChime } from './lib/chime';
import { demoModeActive, installDemoMode } from './lib/demoMode';
import { useAppStore } from './store';

if (demoModeActive()) {
  installDemoMode();
  // Expose the Zustand store for headless demo/debug harnesses.
  (window as unknown as { __TCA_STORE__: typeof useAppStore }).__TCA_STORE__ =
    useAppStore;
}

// §7.2 chime is wired once at app startup — outside any component — so it
// fires only on real empty→non-empty queue transitions and not when the
// user navigates back to /help with an already-non-empty queue.
installQueueChime();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
