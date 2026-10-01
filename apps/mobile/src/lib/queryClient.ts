import { QueryClient, MutationCache } from '@tanstack/react-query';
import { toast } from '../kit/toast';
import { errorMessage } from './apiError';
import { installQueryFreshness, QUERY_GC_MS, readRetryDelay, reconnectPolicy, retryRead } from './appQueryPolicy';

export { errorMessage };

// Every mutation that DOESN'T set its own onError used to fail silently — the
// spinner stopped and nothing told the user, so a vendor thought they accepted
// an order they hadn't, and a driver chased a job they never got (pre-launch
// audit H8/H10). A global MutationCache surfaces every such failure as a
// toast. A mutation opts out (it shows its own feedback) with
// meta: { silent: true } or by declaring its own onError.
const mutationCache = new MutationCache({
  onError: (err, variables, _ctx, mutation) => {
    // Screens that render their own inline error UI opt out with
    // meta: { silent: true }; everything else gets a toast instead of silence.
    if (mutation.options.meta?.['silent']) return;
    // Use this mutation's immutable variables, never the observer's latest call.
    // Current-account failures still get feedback.
    const errorOwnerCurrent = mutation.options.meta?.['errorOwnerCurrent'];
    if (typeof errorOwnerCurrent === 'function' && !errorOwnerCurrent(variables)) return;
    toast.error('Couldn’t complete that', errorMessage(err));
  },
});

// Single app-wide client, module-scoped so non-React code (e.g. authStore.logout)
// can clear it without a hook.
export const queryClient: QueryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: 0, // Unknown families are live; reviewed exceptions are installed below.
      gcTime: QUERY_GC_MS,
      retry: retryRead,
      retryDelay: readRetryDelay,
      refetchOnReconnect: reconnectPolicy(() => queryClient),
    },
    // A mutation function is invoked again from scratch. On a shared device,
    // account A can log out during the retry delay and the second invocation
    // can then authorize a state-changing request as account B. Mutations fail
    // fast globally; explicitly idempotent workflows own any safe retry policy.
    // Run once and fail normally even offline: never pause a money action
    // here and silently replay it when the network returns.
    mutations: { retry: false, networkMode: 'always' },
  },
});
installQueryFreshness(queryClient);
