// Dispatch helpers for the mover journeys [TASK-057]: offers are found the way
// the app finds them (GET offers/current polling), movers keep their position
// fresh through the suite heartbeat, and express delivery skips the 5-minute
// hold so a dispatch journey does not wait on it.

import type { Session } from '../client.js';
import { goOnline, goOffline, ping, asAdmin } from '../provision.js';
import { GET, POST, PUT, req, sleep, codeOf, orderIdsOf, customerOrder, idemKey, clearCart, ensureAddress, activeLegsOf, riderToDoorFrom, doorOf, TERMINAL, IN_CUSTODY, type Res } from './common.js';
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

/**
 * [MKT-F057] The door PIN the customer holds while the goods are on their way:
 * GET /customer/orders/:id carries it from PICKED_UP to ARRIVED, and no
 * rider-facing payload does. The journeys ask the customer, as a rider would.
 */
export async function doorPin(c: Session, orderId: string): Promise<string | null> {
  const pin = (await customerOrder(c, orderId))?.ridePin;
  return typeof pin === 'string' && pin.length > 0 ? pin : null;
}

/** The PIN from whichever roster customer owns the order (cleanup does not know who placed it). */
export async function doorPinFromRoster(ctx: Ctx, orderId: string): Promise<string | null> {
  for (const c of Object.values(ctx.roster.customers)) {
    const pin = await doorPin(c.session, orderId);
    if (pin) return pin;
  }
  return null;
}

/**
 * [E19] A driver's 'arrived' needs a fresh fix (≤ 2 min) within 300 m of the
 * pickup, read from the driver's own location stream. The suite heartbeat keeps
 * every driver at their roster home, ~3.4 km from the journeys' pickup, so a
 * journey drives the car there first: the override holds the heartbeat at the
 * pickup (a beat can never move the car back between the fix and the tap), the
 * fix is reported the way the app reports it, and then the driver taps arrived.
 * The caller clears the override when the journey ends (releaseDrivers).
 */
export async function driverArrives(ctx: Ctx, driverId: MoverId, rideId: string, pickup: { lat: number; lng: number }): Promise<Res> {
  const d = mover(ctx, driverId);
  ctx.stash.heartbeatOverrides[driverId] = pickup;
  await PUT('/driver/location', { latitude: pickup.lat, longitude: pickup.lng, accuracy: 5 }, d.session.token);
  return PUT(`/driver/rides/${rideId}/arrived`, {}, d.session.token);
}

/** The heartbeat takes these drivers back to their roster homes. */
export function releaseDrivers(ctx: Ctx, ids: Iterable<MoverId>): void {
  for (const id of ids) ctx.stash.heartbeatOverrides[id] = undefined;
}

/**
 * Close a ride a journey made, whatever step the journey stopped at, so one
 * failed step cannot leave the passenger "already in a ride" for every journey
 * after it. Short of pickup the passenger cancels (the operator if that is
 * refused); with the passenger aboard nobody can cancel (IN_CUSTODY), so the
 * driver settles the fare at the drop-off. Returns what is still live, or null.
 */
export async function closeRide(ctx: Ctx, passenger: Session, rideId: string, dropoff: { lat: number; lng: number }): Promise<string | null> {
  const status = (await GET(`/rides/${rideId}`, passenger.token)).json?.data?.status;
  if (!status || TERMINAL.includes(status)) return null;
  let last: Res;
  if (IN_CUSTODY.includes(status)) {
    const holder = await driverHolding(ctx, rideId);
    if (!holder) return `${rideId} (${status}): no roster driver holds it`;
    last = await POST(`/driver/rides/${rideId}/handover`, { outcome: 'paid', gps: dropoff }, holder.session.token);
  } else {
    last = await POST(`/rides/${rideId}/cancel`, { reason: 'journey cleanup' }, passenger.token);
    if (!last.ok) last = await asAdmin(ctx.admin.token, 'close a ride a journey left live', 'PUT', `/admin/orders/${rideId}/cancel`, { reason: 'journey runner cleanup of a ride its journey left live' });
  }
  return last.ok ? null : `${rideId} (${status}) → ${last.status} ${codeOf(last)}`;
}

/** The roster driver whose active ride is `rideId`. */
async function driverHolding(ctx: Ctx, rideId: string) {
  for (const id of new Set([...onlineOf(ctx, 'driver'), ...ctx.world.readyMovers.filter((x) => ctx.roster.movers[x]?.kind === 'driver')])) {
    const d = mover(ctx, id);
    if (activeLegsOf((await GET('/driver/rides/active', d.session.token)).json).some((r) => r.id === rideId)) return d;
  }
  return null;
}

/** Close a cash delivery at the door as paid, giving the customer's door PIN when the order has one. */
export async function handoverPaid(r: Session, orderId: string, gps: { lat: number; lng: number }, ridePin?: string | null): Promise<Res> {
  return POST(`/rider/orders/${orderId}/handover`, { outcome: 'paid', gps, ...(ridePin ? { ridePin } : {}) }, r.token);
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

/**
 * Finish (or release) whatever a rider holds, so the next journey starts from a free rider.
 * Returns what was left in hand (empty when the rider is free), so a journey can record it.
 */
export async function freeRider(ctx: Ctx, id: MoverId, customerId?: string): Promise<string[]> {
  const m = mover(ctx, id);
  const list = activeLegsOf((await GET('/rider/orders/active-legs', m.session.token)).json);
  const left: string[] = [];
  for (const o of list) {
    const oid = o.id ?? o.orderId;
    const status = o.status;
    let last: Res;
    if (['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(status)) {
      last = await POST(`/rider/orders/${oid}/handback`, { reason: 'journey runner cleanup: the job is handed back after the check' }, m.session.token);
    } else {
      // In custody: walk on from the rung the leg is on (a leg already carried
      // past pickup cannot replay 'en-route-pickup'), then close it at the door.
      // A courier job settles from any custody state and carries no door PIN.
      if (o.orderType !== 'COURIER') await riderToDoorFrom(m.session, oid, status);
      last = await handoverPaid(m.session, oid, doorOf(o, m), o.orderType === 'COURIER' ? null : await doorPinFromRoster(ctx, oid));
    }
    if (!last.ok) left.push(`${oid} (${status}) → ${last.status} ${codeOf(last)}`);
  }
  if (left.length) ctx.log(`    ${id} still holds: ${left.join('; ')}`);
  void customerId; void customerOrder;
  return left;
}
