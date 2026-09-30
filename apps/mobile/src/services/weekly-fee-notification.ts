import { vendorApi } from './api';
import { getAuthSessionSnapshot } from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';

let resolution = 0;
/** Validate the notified store with its explicit header before selecting it.
 * No checkout ref is read until the router has adopted that store. */
export async function resolveFeeNotification(params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (typeof params['vendorId'] !== 'string') return params;
  const owner = getAuthSessionSnapshot();
  if (!owner) return null;
  const attempt = ++resolution;
  const previous = useStoreSwitcher.getState().selectedStoreId;
  const current = () => {
    const now = getAuthSessionSnapshot();
    return attempt === resolution && now?.userId === owner.userId && now.generation === owner.generation
      && useStoreSwitcher.getState().selectedStoreId === previous;
  };
  useStoreSwitcher.getState().setFeeContextPending(true);
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
    // An unavailable probe cannot authorize a store switch or a ref read.
    return null;
  } finally {
    if (attempt === resolution) useStoreSwitcher.getState().setFeeContextPending(false);
  }
}
