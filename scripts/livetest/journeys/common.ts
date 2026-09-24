// Shared helpers for the journey flows [TASK-057]. HTTP only.

import { createHash } from 'node:crypto';
import { GET, POST, PUT, DEL, req, sleep, codeOf, type Res, type Session } from '../client.js';

export { GET, POST, PUT, DEL, req, sleep, codeOf };
export type { Res, Session };

/** First non-empty value at the given dotted paths. */
export function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    const v = p.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Poll until `probe` yields a value, or the deadline passes (null). */
export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 2_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

/**
 * A never-a-subscriber number (+592049xxxx) for a journey that needs a
 * brand-new account (signup, deletion, onboarding). Deterministic per run and
 * slot, so a re-run gets different numbers; callers skip numbers that exist.
 */
export function freshPhone(runId: string, slot: string, attempt = 0): string {
  const h = createHash('sha256').update(`${runId}:${slot}:${attempt}`).digest();
  // 0000–9998: +5920499999 stays reserved for deploy/journeys-run.sh's public-route probe.
  const n = h.readUInt32BE(0) % 9999;
  return `+592049${String(n).padStart(4, '0')}`;
}

/** A per-run reference usable as an Idempotency-Key (8–128 chars). */
export const idemKey = (runId: string, label: string) => `${runId}-${label}`.slice(0, 120).padEnd(8, '0');

export async function ensureAddress(c: Session, lat: number, lng: number): Promise<string | null> {
  const list = await GET('/customer/addresses', c.token);
  const existing = (list.json?.data ?? []).find?.((a: any) => a.isDefault)?.id ?? list.json?.data?.[0]?.id;
  if (existing) return existing;
  const a = await POST('/customer/addresses', {
    label: 'Home', addressLine1: '1 Test St', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: lat, longitude: lng, isDefault: true,
  }, c.token);
  return a.json?.data?.id ?? a.json?.data?.address?.id ?? null;
}

export async function clearCart(c: Session) {
  await req('DELETE', '/customer/cart', { token: c.token });
}

export interface PlaceOpts {
  payment?: 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER' | string;
  qty?: number;
  pickup?: boolean;
  key?: string;
  tip?: number;
  extraItems?: Array<{ vendorId: string; itemId: string; qty?: number }>;
}

/** The latest LIFECYCLE_V2 hold expiry seen on any order this run placed (epoch ms). */
export let latestHoldUntil = 0;
export function noteHold(iso: unknown) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isFinite(t) && t > latestHoldUntil) latestHoldUntil = t;
}

/** Cart → (address) → checkout. Returns the checkout response. */
export async function placeOrder(c: Session, vendorId: string, itemId: string, lat: number, lng: number, o: PlaceOpts = {}): Promise<Res> {
  await clearCart(c);
  const addressId = await ensureAddress(c, lat, lng);
  const add = await POST('/customer/cart/items', { vendorId, itemId, quantity: o.qty ?? 1 }, c.token);
  if (!add.ok) return add;
  for (const x of o.extraItems ?? []) {
    const r = await POST('/customer/cart/items', { vendorId: x.vendorId, itemId: x.itemId, quantity: x.qty ?? 1 }, c.token);
    if (!r.ok) return r;
  }
  if (addressId && !o.pickup) {
    const a = await PUT('/customer/cart/address', { addressId }, c.token);
    if (!a.ok) return a;
  }
  const body: Record<string, unknown> = { paymentMethod: o.payment ?? 'CASH' };
  if (o.pickup) {
    body.fulfillmentSelections = Object.fromEntries([vendorId, ...(o.extraItems ?? []).map((x) => x.vendorId)].map((v) => [v, 'PICKUP']));
  }
  if (o.tip !== undefined) body.tipAmount = o.tip;
  const res = await req('POST', '/customer/checkout', { token: c.token, body, headers: o.key ? { 'Idempotency-Key': o.key } : undefined });
  for (const ord of (res.json?.data?.orders ?? [res.json?.data?.order]) as any[]) noteHold(ord?.holdExpiresAt);
  return res;
}

/** The order id(s) a checkout response names. */
export function orderIdsOf(r: Res): string[] {
  const d = r.json?.data;
  if (Array.isArray(d?.orders)) return d.orders.map((o: any) => o.id).filter(Boolean);
  if (d?.order?.id) return [d.order.id];
  if (d?.id) return [d.id];
  return [];
}

export async function customerOrder(c: Session, orderId: string): Promise<any> {
  const r = await GET(`/customer/orders/${orderId}`, c.token);
  return r.ok ? r.json?.data : null;
}

/** Wait for a customer-visible order status (or any of several). */
export async function waitForStatus(c: Session, orderId: string, statuses: string[], timeoutMs: number): Promise<any> {
  return waitFor(async () => {
    const o = await customerOrder(c, orderId);
    return o && statuses.includes(o.status) ? o : null;
  }, timeoutMs, 2_500);
}

/** Wait until the LIFECYCLE_V2 hold on an order has passed (the vendor can see it). */
export async function waitForRelease(c: Session, orderId: string, maxMs = 7 * 60_000): Promise<boolean> {
  const o = await customerOrder(c, orderId);
  const until = o?.holdExpiresAt ? Date.parse(o.holdExpiresAt) : 0;
  const wait = until - Date.now();
  if (wait > maxMs) return false;
  if (wait > 0) await sleep(wait + 1_500);
  return true;
}

export async function notificationsOf(s: Session): Promise<any[]> {
  const r = await GET('/customer/notifications', s.token);
  const d = r.json?.data;
  return Array.isArray(d) ? d : Array.isArray(d?.notifications) ? d.notifications : Array.isArray(d?.items) ? d.items : [];
}

/** A notification about `orderId` (data.orderId), created after `since`. */
export async function waitForNotification(s: Session, match: (n: any) => boolean, timeoutMs = 20_000): Promise<any> {
  return waitFor(async () => (await notificationsOf(s)).find(match) ?? null, timeoutMs, 2_000);
}

export const brief = (r: Res) => `${r.status}${codeOf(r) ? ` ${codeOf(r)}` : ''}`;

/**
 * The live jobs a mover holds, from GET /rider/orders/active-legs ({ legs, run }) or
 * GET /driver/rides/active (one ride or null). Each has `id` (and `status`).
 */
export function activeLegsOf(json: any): any[] {
  const d = json?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.legs)) return d.legs;
  return d?.id ? [d] : [];
}

/** The statuses an order or ride never leaves (order-status.ts TERMINAL_ORDER_STATUSES). */
export const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

/**
 * A leg whose goods (or passenger) are already with the mover. The state machine
 * lets these end only DELIVERED or FAILED (ORDER_TRANSITIONS.CANCELLED lists
 * pre-custody states alone), so neither the customer nor the operator can cancel
 * one: it is finished the way a mover finishes it.
 */
export const IN_CUSTODY = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS'];

/** Where a leg (or a ride) ends: the order's own delivery point, else where the mover is. */
export const doorOf = (o: any, m: { lat: number; lng: number }) =>
  typeof o?.deliveryLat === 'number' && typeof o?.deliveryLng === 'number' ? { lat: o.deliveryLat as number, lng: o.deliveryLng as number } : { lat: m.lat, lng: m.lng };

/** Each rider rung and the PUT that moves the leg on from it, assignment to the door. */
const RIDER_RUNGS: ReadonlyArray<readonly [status: string, slug: string]> = [
  ['RIDER_ASSIGNED', 'en-route-pickup'],
  ['RIDER_EN_ROUTE_PICKUP', 'arrived-pickup'],
  ['RIDER_ARRIVED_PICKUP', 'picked-up'],
  ['PICKED_UP', 'en-route-delivery'],
  ['EN_ROUTE_DELIVERY', 'arrived'],
];

/**
 * Walk a rider's leg to the door (ARRIVED) from the rung it is on, skipping the
 * rungs it already passed. Returns the first refusal, else the last answer, or
 * null when there was nothing to walk (already at the door).
 */
export async function riderToDoorFrom(r: Session, orderId: string, status: string): Promise<Res | null> {
  const from = RIDER_RUNGS.findIndex(([s]) => s === status);
  if (from < 0) return null;
  let last: Res | null = null;
  for (const [, slug] of RIDER_RUNGS.slice(from)) {
    last = await PUT(`/rider/orders/${orderId}/${slug}`, {}, r.token);
    if (!last.ok) return last;
  }
  return last;
}
