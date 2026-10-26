import { apiFetch } from './auth';

/** [MASTER-025] One stock adjustment, named by `commandKey`: resending it (a retry
 *  after a lost response) returns the committed movement instead of moving stock
 *  again. Only the inventory page adjusts stock, so this lives outside the shared
 *  vendor-api module: every other vendor page stays within its size budget. */
export const adjustStock = (id: string, delta: number, reason: 'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN', commandKey: string) =>
  apiFetch(`/api/v1/vendor/items/${id}/adjust`, { method: 'POST', body: JSON.stringify({ delta, reason }), headers: { 'Idempotency-Key': commandKey } });
