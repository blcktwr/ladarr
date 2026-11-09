import { Alerts } from 'nebula';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import { api } from './lib/api.ts';
import './theme/index.css';

// The query key is the API path. A failed request shows its error at once, with no retry.
// The live events load the data again, so a focus of the window does not. Some reads ask the indexers, TMDB, or ffprobe.
const queryClient = new QueryClient({
  defaultOptions: { queries: { queryFn: ({ queryKey }) => api(queryKey[0] as string), retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={new URL(document.baseURI).pathname.replace(/\/$/, '')}>
        <Alerts>
          <App />
        </Alerts>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
