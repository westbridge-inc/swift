import { apiFetch } from './auth';

/** [MASTER-025] One stock adjustment, named by `commandKey`: resending it (a retry
 *  after a lost response) returns the committed movement instead of moving stock
 *  again. Only the inventory page adjusts stock, so this lives outside the shared
 *  vendor-api module: every other vendor page stays within its size budget. */
export const adjustStock = (id: string, delta: number, reason: 'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN', commandKey: string) =>
  apiFetch(`/api/v1/vendor/items/${id}/adjust`, { method: 'POST', body: JSON.stringify({ delta, reason }), headers: { 'Idempotency-Key': commandKey } });

/** [IN-STORE-SALE] One sold in person ("Sold in store −1"). `tapKey` names that ONE tap: a resend is answered with its
 *  receipt, never taken twice. Answers with the item's stock and availability. */
export const sellInStore = (id: string, tapKey: string) =>
  apiFetch(`/api/v1/vendor/items/${id}/in-store-sale`, { method: 'POST', body: '{}', headers: { 'Idempotency-Key': tapKey } });

/** [IN-STORE-SALE] Undo of that tap: the server puts the one back (a new ledger row), once per sale. */
export const undoInStoreSale = (id: string, saleKey: string) =>
  apiFetch(`/api/v1/vendor/items/${id}/in-store-sale/undo`, { method: 'POST', body: JSON.stringify({ saleKey }) });
