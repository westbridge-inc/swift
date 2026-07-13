import { QueryClient, MutationCache } from '@tanstack/react-query';
import { toast } from '../components/ui/toast';
import { errorMessage } from './apiError';

export { errorMessage };

// Every mutation that DOESN'T set its own onError used to fail silently — the
// spinner stopped and nothing told the user, so a vendor thought they accepted
// an order they hadn't, and a driver chased a job they never got (pre-launch
// audit H8/H10). A global MutationCache surfaces every such failure as a
// toast. A mutation opts out (it shows its own feedback) with
// meta: { silent: true } or by declaring its own onError.
const mutationCache = new MutationCache({
  onError: (err, _vars, _ctx, mutation) => {
    // Screens that render their own inline error UI opt out with
    // meta: { silent: true }; everything else gets a toast instead of silence.
    if (mutation.options.meta?.['silent']) return;
    toast.error('Couldn’t complete that', errorMessage(err));
  },
});

// Single app-wide client, module-scoped so non-React code (e.g. authStore.logout)
// can clear it without a hook.
export const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 2 },
    // One retry on a flaky mobile network before we surface the failure —
    // covers a transient blip without masking a real error for long.
    mutations: { retry: 1, retryDelay: 800 },
  },
});
