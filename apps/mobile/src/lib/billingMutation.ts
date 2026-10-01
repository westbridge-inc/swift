import { requireAuthSessionForPrincipal, requireAuthSessionSnapshot } from '../stores/authStore';
import type { AuthSessionSnapshot } from './authSession';
import type { MutationGuard } from '../hooks/useStepUp';

/** Capture before the first request; recheck before the one authorized retry. */
export function runBillingMutation<R>(
  guard: MutationGuard,
  submit: (session: AuthSessionSnapshot, storeId?: string | null) => Promise<R>,
  currentStore?: () => string | null,
): Promise<R> {
  const principal = requireAuthSessionSnapshot();
  const storeId = currentStore?.();
  return guard(() => {
    const session = requireAuthSessionForPrincipal(principal);
    if (currentStore && currentStore() !== storeId) throw new Error('Selected store changed. Start this change again.');
    return submit(session, storeId);
  })();
}
