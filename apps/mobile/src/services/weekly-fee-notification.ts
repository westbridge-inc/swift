import { vendorApi } from './api';
import { getAuthSessionSnapshot } from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { selectionStillCurrent, type StoreSelection } from '../lib/storeSelection';

/** The routing authority a fee notice resolves under. `current` answers whether
 *  the notice still owns routing: the newest tap, the same account, and the
 *  selection it captured (or the shell's automatic first-store handoff).
 *  `adopt` re-bases it on this resolution's own authorized store handoff. */
export interface FeeNoticeAuthority {
  current: () => boolean;
  adopt: () => void;
}

function capturedSelection(): StoreSelection {
  const { selectedStoreId, storeGeneration } = useStoreSwitcher.getState();
  return { selectedStoreId, storeGeneration };
}

/** A resolution started outside the tap-router answers to the selection it saw. */
function selectionAuthority(): FeeNoticeAuthority {
  let captured = capturedSelection();
  return { current: () => selectionStillCurrent(captured, useStoreSwitcher.getState()), adopt: () => { captured = capturedSelection(); } };
}

let resolution = 0;
/** Validate the notified store with its explicit header before selecting it.
 * No checkout ref is read until the router has adopted that store. */
export async function resolveFeeNotification(
  params: Record<string, unknown>,
  onResolved?: (_params: Record<string, unknown>) => void,
  authority: FeeNoticeAuthority = selectionAuthority(),
): Promise<Record<string, unknown> | null> {
  if (typeof params['vendorId'] !== 'string') return params;
  const owner = getAuthSessionSnapshot();
  if (!owner || !authority.current()) return null;
  const attempt = ++resolution;
  const sameOwner = () => {
    const now = getAuthSessionSnapshot();
    return now?.userId === owner.userId && now.generation === owner.generation;
  };
  // Every effect below (store publication, recovery, navigation) answers to
  // this: a newer tap, another account or an explicit choice retires it first.
  const current = () => attempt === resolution && sameOwner() && authority.current();
  const fallback = () => ({ ref: undefined, subscriptionId: undefined, vendorId: useStoreSwitcher.getState().selectedStoreId });
  let unresolved = false;
  useStoreSwitcher.setState({ feeContextPending: true, feeContextError: null });
  try {
    const response = await vendorApi.subscription(owner, params['vendorId']);
    if (!current()) return null;
    const subscription = response.data.data;
    if (subscription.id !== params['subscriptionId']) return fallback();
    useStoreSwitcher.getState().setSelectedStore(params['vendorId']);
    authority.adopt();
    return params;
  } catch (error) {
    if (!current()) return null;
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 403 || status === 404) return fallback();
    // A transport failure is not an access denial. Keep every Pay blocked
    // until this notification is resolved or explicitly abandoned.
    unresolved = true;
    const ownsRecovery = () => sameOwner() && attempt === resolution
      && useStoreSwitcher.getState().feeContextError === recovery;
    const retire = () => {
      if (!ownsRecovery()) return false;
      resolution++;
      useStoreSwitcher.setState({ feeContextPending: false, feeContextError: null });
      return true;
    };
    const recovery = {
      retry: async () => {
        if (!current()) { retire(); return; }
        if (!ownsRecovery()) return;
        const next = resolveFeeNotification(params, onResolved, authority);
        const nextAttempt = resolution;
        const result = await next;
        // The retried handoff re-based the authority: any later choice fails it.
        if (result && nextAttempt === resolution && sameOwner() && authority.current()
          && useStoreSwitcher.getState().selectedStoreId === result['vendorId']) onResolved?.(result);
      },
      cancel: () => {
        const routed = authority.current();
        if (!retire()) return;
        if (routed && sameOwner()) onResolved?.(fallback());
      },
    };
    useStoreSwitcher.setState({ feeContextError: recovery });
    return fallback();
  } finally {
    if (attempt === resolution && sameOwner() && !unresolved) useStoreSwitcher.setState({ feeContextPending: false, feeContextError: null });
  }
}
