'use client';

// [PERF · web shared bundle] The customer's order calls (list, one order with its
// swap view, the swap answer, cancel), moved verbatim from lib/customer.ts; only
// the orders pages use them.
import { apiFetch } from './auth';


// [UI-SWEEP U13] The phone's two reads (hooks/customer.ts useLiveOrders /
// useOrdersInfinite). History is placedAt DESC and pages at 20, so filtering the
// newest page for live orders misses an older order still in progress, and older
// history was unreachable. Live orders are asked for as such, in one generous
// page whose server total is kept; history is paged.
export const LIVE_ORDERS_LIMIT = 50;
export interface LiveOrders { items: any[]; total: number | null }
export async function getLiveOrders(): Promise<LiveOrders> {
  const body = await apiFetch(`/api/v1/customer/orders?live=true&limit=${LIVE_ORDERS_LIMIT}`);
  return { items: Array.isArray(body?.data) ? body.data : [], total: typeof body?.meta?.total === 'number' ? body.meta.total : null };
}
export interface HistoryPage { items: any[]; page: number; totalPages: number; total: number | null }
export async function getOrderHistoryPage(page: number): Promise<HistoryPage> {
  const body = await apiFetch(`/api/v1/customer/orders?live=false&page=${page}`);
  const meta = body?.meta ?? {};
  return {
    items: Array.isArray(body?.data) ? body.data : [],
    page: typeof meta.page === 'number' ? meta.page : page,
    totalPages: typeof meta.totalPages === 'number' ? meta.totalPages : page,
    total: typeof meta.total === 'number' ? meta.total : null,
  };
}
/** [UI-SWEEP U17] Put a finished store order's lines back in the cart (the phone's Reorder). */
export async function reorder(id: string): Promise<{ unavailableItems?: number | null; needsOptions?: string[] | null; message?: string | null } | null> {
  return ((await apiFetch(`/api/v1/customer/orders/${id}/reorder`, { method: 'POST', body: '{}' })).data ?? null);
}
// [SUBSTITUTION · owner 17 Oct 2026] The web renders the server's swap view (its
// permitted answers and deadline), so it opts in to swap decisions.
export async function getOrder(id: string): Promise<any> { return (await apiFetch(`/api/v1/customer/orders/${id}?swapDecisions=v2`)).data; }
/** The customer's answer to the store's swap question (approve = take the substitute). */
export async function decideSubstitution(orderId: string, lineId: string, approve: boolean): Promise<any> {
  return (await apiFetch(`/api/v1/customer/orders/${orderId}/items/${lineId}/substitution`, { method: 'POST', body: JSON.stringify({ approve }) })).data;
}
export async function cancelOrder(id: string, reason: string) {
  return apiFetch(`/api/v1/customer/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
}
/** [BOOK-S6b · owner B2] Move my booking to another free time of the same service
 *  (POST /customer/bookings/:id/reschedule, the phone's useRescheduleBooking). The
 *  server judges the new time and the two-hour cut-off; its refusal is thrown in its own words. */
export async function rescheduleBooking(bookingId: string, newSlotStart: string) {
  return (await apiFetch(`/api/v1/customer/bookings/${encodeURIComponent(bookingId)}/reschedule`, { method: 'POST', body: JSON.stringify({ newSlotStart }) })).data;
}
