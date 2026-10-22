// ---------------------------------------------------------------------------
// A Services store's schedule (the app's Schedule tab: apps/mobile
// hooks/vendorops.ts useVendorBookings / useVendorBookingExceptions /
// useCreateBookingException / useDeleteBookingException), the same endpoints.
// Its own small file, read only by the Schedule page, so the other console
// pages do not carry it in their first load (scripts/perf-budget).
// ---------------------------------------------------------------------------
import { apiFetch } from './auth';
import { toAmount } from './vendor-api';

const V = '/api/v1/vendor';

/** One appointment on a Services store's day (GET /vendor/bookings). */
export interface VendorBooking {
  id: string;
  serviceName: string;
  price: number | null;
  slotStart: string;
  slotEnd: string;
  status: string;
  orderId: string | null;
  customer: { firstName: string } | null;
}

/** Blocked time: a full day (start/end null) or a window, "HH:MM" in Guyana. */
export interface VendorBookingException {
  id: string;
  itemId: string | null;
  date: string;
  start: string | null;
  end: string | null;
  reason: string | null;
}

/** The coming two weeks of appointments (the server's default window). */
export const getBookings = (): Promise<VendorBooking[]> =>
  apiFetch(`${V}/bookings`).then((r) => ((r.data ?? []) as Array<VendorBooking & { price: unknown }>).map((b) => ({ ...b, price: toAmount(b.price) })));

/** Blocked time in the coming month (owners and managers). */
export const getBookingExceptions = (): Promise<VendorBookingException[]> =>
  apiFetch(`${V}/bookings/exceptions`).then((r) => (r.data ?? []) as VendorBookingException[]);

export const createBookingException = (body: { date: string; start?: string; end?: string; reason?: string }) =>
  apiFetch(`${V}/bookings/exceptions`, { method: 'POST', body: JSON.stringify(body) });

export const deleteBookingException = (id: string) =>
  apiFetch(`${V}/bookings/exceptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
