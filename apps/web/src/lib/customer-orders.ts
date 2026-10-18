'use client';

// [PERF · web shared bundle] The customer's order calls (list, one order with its
// swap view, the swap answer, cancel), moved verbatim from lib/customer.ts; only
// the orders pages use them.
import { apiFetch } from './auth';

export async function getOrders(): Promise<any[]> { return (await apiFetch('/api/v1/customer/orders')).data as any[]; }
// [SUBSTITUTION · owner 17 Oct 2026] The web renders the server's swap view (its
// permitted answers and deadline), so it opts in to swap decisions.
export async function getOrder(id: string): Promise<any> { return (await apiFetch(`/api/v1/customer/orders/${id}?swapDecisions=v1`)).data; }
/** The customer's answer to the store's swap question (approve = take the substitute). */
export async function decideSubstitution(orderId: string, lineId: string, approve: boolean): Promise<any> {
  return (await apiFetch(`/api/v1/customer/orders/${orderId}/items/${lineId}/substitution`, { method: 'POST', body: JSON.stringify({ approve }) })).data;
}
export async function cancelOrder(id: string, reason: string) {
  return apiFetch(`/api/v1/customer/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
}
