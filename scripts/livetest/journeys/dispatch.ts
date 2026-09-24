// Dispatch helpers for the mover journeys [TASK-057]: offers are found the way
// the app finds them (GET offers/current polling), movers keep their position
// fresh through the suite heartbeat, and express delivery skips the 5-minute
// hold so a dispatch journey does not wait on it.

import type { Session } from '../client.js';
import { goOnline, goOffline, ping } from '../provision.js';
import { GET, POST, PUT, req, sleep, codeOf, orderIdsOf, customerOrder, idemKey, clearCart, ensureAddress, type Res } from './common.js';
import type { Ctx } from './context.js';

export type MoverId = string;

export function mover(ctx: Ctx, id: MoverId) {
  const m = ctx.roster.movers[id];
  if (!m) throw new Error(`no mover ${id} in the roster`);
  return m;
}

/** Online riders (or drivers) that provisioning cleared. */
export const onlineOf = (ctx: Ctx, kind: 'rider' | 'driver') =>
  ctx.world.onlineMovers.filter((id) => ctx.roster.movers[id]?.kind === kind);

/** Take a mover online/offline and keep the heartbeat's list in step. */
export async function setOnline(ctx: Ctx, id: MoverId, on: boolean): Promise<Res> {
  const m = mover(ctx, id);
  const r = on ? await goOnline(m) : await goOffline(m);
  if (on && r.ok) {
    await ping(m);
    if (!ctx.world.onlineMovers.includes(id)) ctx.world.onlineMovers.push(id);
  }
  if (!on && r.ok) ctx.world.onlineMovers = ctx.world.onlineMovers.filter((x) => x !== id);
  return r;
}

export interface Offer { moverId: MoverId; offer: any }

/** Poll the candidates' current offer until one holds `orderId`. */
export async function pollOffer(ctx: Ctx, orderId: string, candidates: MoverId[], timeoutMs = 45_000): Promise<Offer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const id of candidates) {
      const m = mover(ctx, id);
      const r = await GET(`/${m.kind}/offers/current`, m.session.token);
      const offer = r.json?.data?.offer ?? r.json?.data;
      if (offer?.orderId === orderId) return { moverId: id, offer };
    }
    await sleep(1_000);
  }
  return null;
}

/** Customer places an express CASH delivery (no hold); returns the order id and the checkout response. */
export async function placeExpress(ctx: Ctx, customerId: string, vendorKey: string, itemKey: string, label: string, qty = 1): Promise<{ id: string | null; res: Res }> {
  const c = ctx.roster.customers[customerId]!;
  const v = ctx.roster.vendors[vendorKey]!;
  const item = ctx.world.items[itemKey];
  if (!item || !v.vendorId) return { id: null, res: { status: 0, ok: false, json: null, text: `${itemKey} not provisioned` } };
  await clearCart(c.session);
  const add = await POST('/customer/cart/items', { vendorId: v.vendorId, itemId: item.itemId, quantity: qty }, c.session.token);
  if (!add.ok) return { id: null, res: add };
  const addr = await ensureAddress(c.session, c.lat, c.lng);
  if (addr) await PUT('/customer/cart/address', { addressId: addr }, c.session.token);
  const res = await req('POST', '/customer/checkout', {
    token: c.session.token,
    body: { paymentMethod: 'CASH', express: true },
    headers: { 'Idempotency-Key': idemKey(ctx.runId, label) },
  });
  return { id: orderIdsOf(res)[0] ?? null, res };
}

/** The rider's leg from assignment to the door. Returns the last response. */
export async function riderToDoor(r: Session, orderId: string): Promise<Res> {
  let last: Res | null = null;
  for (const slug of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived']) {
    last = await PUT(`/rider/orders/${orderId}/${slug}`, {}, r.token);
    if (!last.ok) return last;
  }
  return last!;
}

/** Close a cash delivery at the door as paid. */
export async function handoverPaid(r: Session, orderId: string, gps: { lat: number; lng: number }): Promise<Res> {
  return POST(`/rider/orders/${orderId}/handover`, { outcome: 'paid', gps }, r.token);
}

/** A released delivery order accepted by its store (dispatch starts ON_ACCEPT). */
export async function storeAccepts(ctx: Ctx, vendorKey: string, orderId: string): Promise<Res> {
  return PUT(`/vendor/orders/${orderId}/accept`, {}, ctx.roster.vendors[vendorKey]!.session.token);
}

/** Store marks preparing + ready (on a rider-owned lane these only stamp the timestamps). */
export async function storeReadies(ctx: Ctx, vendorKey: string, orderId: string): Promise<void> {
  const t = ctx.roster.vendors[vendorKey]!.session.token;
  await PUT(`/vendor/orders/${orderId}/preparing`, {}, t);
  await PUT(`/vendor/orders/${orderId}/ready`, {}, t);
}

/** Finish (or release) whatever a rider holds, so the next journey starts from a free rider. */
export async function freeRider(ctx: Ctx, id: MoverId, customerId?: string): Promise<void> {
  const m = mover(ctx, id);
  const legs = await GET('/rider/orders/active-legs', m.session.token);
  const list: any[] = Array.isArray(legs.json?.data) ? legs.json.data : legs.json?.data ? [legs.json.data] : [];
  for (const o of list) {
    const oid = o.orderId ?? o.id;
    const status = o.status;
    if (['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(status)) {
      await POST(`/rider/orders/${oid}/handback`, { reason: 'journey cleanup' }, m.session.token);
      continue;
    }
    await riderToDoor(m.session, oid);
    await handoverPaid(m.session, oid, { lat: m.lat, lng: m.lng });
  }
  void customerId; void customerOrder; void codeOf;
}
