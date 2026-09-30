import { vendorApi } from './api';
import { getAuthSessionSnapshot } from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';

let resolution = 0;
/** Validate the notified store with its explicit header before selecting it.
 * No checkout ref is read until the router has adopted that store. */
export async function resolveFeeNotification(params: Record<string, unknown>, onResolved?: (_params: Record<string, unknown>) => void): Promise<Record<string, unknown> | null> {
  if (typeof params['vendorId'] !== 'string') return params;
  const owner = getAuthSessionSnapshot();
  if (!owner) return null;
  const attempt = ++resolution;
  const { selectedStoreId: previous, storeGeneration } = useStoreSwitcher.getState();
  const sameOwner = () => {
    const now = getAuthSessionSnapshot();
    return now?.userId === owner.userId && now.generation === owner.generation;
  };
  const current = () => {
    const selection = useStoreSwitcher.getState();
    return attempt === resolution && sameOwner()
      && selection.selectedStoreId === previous && selection.storeGeneration === storeGeneration;
  };
  const fallback = () => ({ ref: undefined, subscriptionId: undefined, vendorId: useStoreSwitcher.getState().selectedStoreId });
  let unresolved = false;
  useStoreSwitcher.setState({ feeContextPending: true, feeContextError: null });
  try {
    const response = await vendorApi.subscription(owner, params['vendorId']);
    if (!current()) return null;
    const subscription = response.data.data;
    if (subscription.id !== params['subscriptionId']) return { ref: undefined, subscriptionId: undefined, vendorId: previous };
    useStoreSwitcher.getState().setSelectedStore(params['vendorId']);
    return params;
  } catch (error) {
    if (!current()) return null;
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 403 || status === 404) return { ref: undefined, subscriptionId: undefined, vendorId: previous };
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
        const next = resolveFeeNotification(params, onResolved);
        const nextAttempt = resolution;
        const result = await next;
        const selection = useStoreSwitcher.getState();
        const expectedGeneration = storeGeneration + (result?.['vendorId'] === previous ? 0 : 1);
        if (result && nextAttempt === resolution && sameOwner()
          && selection.selectedStoreId === result['vendorId'] && selection.storeGeneration === expectedGeneration) onResolved?.(result);
      },
      cancel: () => {
        if (!retire()) return;
        const now = getAuthSessionSnapshot();
        if (now?.userId === owner.userId && now.generation === owner.generation) onResolved?.(fallback());
      },
    };
    useStoreSwitcher.setState({ feeContextError: recovery });
    return fallback();
  } finally {
    if (attempt === resolution && sameOwner() && !unresolved) useStoreSwitcher.setState({ feeContextPending: false, feeContextError: null });
  }
}
