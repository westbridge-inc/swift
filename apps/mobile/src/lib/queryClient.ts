import { QueryClient } from '@tanstack/react-query';

// Single app-wide client, module-scoped so non-React code (e.g. authStore.logout)
// can clear it without a hook.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 2 } },
});
