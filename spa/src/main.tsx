import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './index.css';
import { App } from './App';
import { demoModeActive, installDemoMode } from './lib/demoMode';
import { useAppStore } from './store';

if (demoModeActive()) {
  installDemoMode();
  // Expose the Zustand store for headless demo/debug harnesses.
  (window as unknown as { __TCA_STORE__: typeof useAppStore }).__TCA_STORE__ =
    useAppStore;
}

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
