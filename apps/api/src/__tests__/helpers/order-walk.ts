/**
 * [ORDER-FLOW · random walk] Model-based random walks over the order state
 * machine, with seeds that replay and traces that shrink.
 *
 * A walk is a TRACE: how many riders, then a list of actions by the customer,
 * the store, the riders, an admin and the clock, ending (usually) with
 * `abandon` — everybody stops acting and 24 hours pass with only the
 * production sweeps running. A seed generates a trace (mulberry32, weighted
 * towards the actions that make sense in the order's current status, with a
 * share of "anything at all" so refusals are exercised too). A trace replays
 * exactly from fresh fixtures, which is what makes shrinking possible.
 *
 * After every action the INVARIANTS are checked against the database and the
 * people's own views (see `checkInvariants`). After `abandon`, EXIT is
 * checked: every order must reach a terminal status. A violation is either a
 * KNOWN finding (classified to its FINDINGS.txt id, so the run names it) or
 * UNKNOWN — and an unknown violation fails the run with its shrunk trace,
 * which `WALK_TRACE='<json>'` replays.
 */
import type { OrderStatus } from '@prisma/client';
import { ORDER_TRANSITIONS, RECOVERY_TRANSITIONS, isTerminalOrderStatus } from '../../modules/order/order-status';
import { adminCall, advance, call, castWalk, drainDue, placeCashOrder, type Cast, type WalkWorld } from './order-walk-world';

export const RIDER_STEPS = ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived'] as const;
export type RiderStep = (typeof RIDER_STEPS)[number];

export type Action =
  | { a: 'cust.cancel' }
  | { a: 'store.accept' } | { a: 'store.preparing' } | { a: 'store.ready' } | { a: 'store.reject' } | { a: 'store.retry' }
  | { a: 'rider.online'; r: number } | { a: 'rider.offline'; r: number } | { a: 'rider.accept'; r: number }
  | { a: 'rider.step'; r: number; step: RiderStep } | { a: 'rider.handover'; r: number } | { a: 'rider.handback'; r: number }
  | { a: 'admin.cancel'; refund: boolean } | { a: 'admin.refundSettled' }
  | { a: 'wait'; ms: number }
  | { a: 'abandon'; ridersOnline: boolean };

export interface Trace { riders: number; actions: Action[] }

export interface Violation {
  inv: string;
  detail: string;
  /** Index of the action after which it was seen (-1: at checkout). */
  at: number;
  status: string;
  /** The FINDINGS.txt id when the violation is a known, recorded finding. */
  finding: string | null;
}

export interface WalkResult {
  trace: Trace;
  orderId: string | null;
  finalStatus: string | null;
  violations: Violation[];
  /** `${before} --${action}--> ${after} [${http}]` → count. */
  coverage: Map<string, number>;
  /** Status-log edges seen, `${from}>${to}`. */
  edges: Set<string>;
}

export const HORIZON_MS = 24 * 3600_000;
const WALK_SWEEP_MS = 5 * 60_000;
const ABANDON_SWEEP_MS = 30 * 60_000;

// ─── Seeds ──────────────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WAITS = [20_000, 2 * 60_000, 10 * 60_000, 45 * 60_000, 3 * 3600_000];

function anyAction(rnd: () => number, riders: number): Action {
  const r = Math.floor(rnd() * riders);
  const all: Action[] = [
    { a: 'cust.cancel' }, { a: 'store.accept' }, { a: 'store.preparing' }, { a: 'store.ready' }, { a: 'store.reject' }, { a: 'store.retry' },
    { a: 'rider.online', r }, { a: 'rider.offline', r }, { a: 'rider.accept', r }, { a: 'rider.handover', r }, { a: 'rider.handback', r },
    { a: 'rider.step', r, step: RIDER_STEPS[Math.floor(rnd() * RIDER_STEPS.length)]! },
    { a: 'admin.cancel', refund: rnd() < 0.5 }, { a: 'admin.refundSettled' },
    { a: 'wait', ms: WAITS[Math.floor(rnd() * WAITS.length)]! },
  ];
  return all[Math.floor(rnd() * all.length)]!;
}

/** The weighted "sensible next" menu for a status. `r` is the rider most
 *  likely to act (the assigned one when there is one). */
function sensible(status: string, r: number, rnd: () => number, refundOwed: boolean): Array<[number, Action]> {
  const wait: Action = { a: 'wait', ms: WAITS[Math.floor(rnd() * WAITS.length)]! };
  const cancelish: Array<[number, Action]> = [[0.4, { a: 'cust.cancel' }], [0.25, { a: 'admin.cancel', refund: rnd() < 0.5 }]];
  switch (status) {
    case 'PENDING': return [[5, { a: 'store.accept' }], [1, { a: 'store.reject' }], [2, wait], ...cancelish];
    case 'ACCEPTED': return [[3, { a: 'store.preparing' }], [2, { a: 'store.ready' }], [3, { a: 'rider.accept', r }], [2, wait], [0.5, { a: 'rider.offline', r }], ...cancelish];
    case 'PREPARING': return [[4, { a: 'store.ready' }], [3, { a: 'rider.accept', r }], [2, wait], ...cancelish];
    case 'READY_FOR_PICKUP': return [[5, { a: 'rider.accept', r }], [2, wait], [1, { a: 'store.retry' }], [0.5, { a: 'rider.online', r }], ...cancelish];
    case 'RIDER_ASSIGNED': return [[4, { a: 'rider.step', r, step: 'en-route-pickup' }], [1, { a: 'rider.step', r, step: 'arrived-pickup' }], [1, { a: 'rider.step', r, step: 'picked-up' }], [1, { a: 'rider.handback', r }], [2, { a: 'store.ready' }], [1, wait], ...cancelish];
    case 'RIDER_EN_ROUTE_PICKUP': return [[4, { a: 'rider.step', r, step: 'arrived-pickup' }], [1, { a: 'rider.handback', r }], [2, { a: 'store.ready' }], [1, wait], ...cancelish];
    case 'RIDER_ARRIVED_PICKUP': return [[4, { a: 'rider.step', r, step: 'picked-up' }], [2, { a: 'store.ready' }], [1, { a: 'rider.handback', r }], [1, wait]];
    case 'PICKED_UP': return [[4, { a: 'rider.step', r, step: 'en-route-delivery' }], [1, { a: 'rider.step', r, step: 'arrived' }], [1, { a: 'rider.handover', r }], [1, wait]];
    case 'EN_ROUTE_DELIVERY': return [[4, { a: 'rider.step', r, step: 'arrived' }], [1, { a: 'rider.handover', r }], [1, wait]];
    case 'ARRIVED': return [[4, { a: 'rider.handover', r }], [1, wait]];
    default: return refundOwed ? [[3, { a: 'admin.refundSettled' }], [1, wait]] : [[1, wait]];
  }
}

function pick(rnd: () => number, menu: Array<[number, Action]>): Action {
  const total = menu.reduce((s, [w]) => s + w, 0);
  let x = rnd() * total;
  for (const [w, act] of menu) {
    x -= w;
    if (x <= 0) return act;
  }
  return menu[menu.length - 1]![1];
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function riderIndexOf(w: WalkWorld, cast: Cast, orderId: string): Promise<number | null> {
  const o = await w.app.prisma.order.findUnique({ where: { id: orderId }, select: { riderId: true } });
  const i = cast.riders.findIndex((r) => r.riderId === o?.riderId);
  return i >= 0 ? i : null;
}

/** Perform one action through the real door. Returns the HTTP status (0 = no request). */
async function perform(w: WalkWorld, cast: Cast, orderId: string, act: Action): Promise<number> {
  const o = `/api/v1`;
  const rider = 'r' in act ? cast.riders[act.r % cast.riders.length]! : null;
  switch (act.a) {
    case 'cust.cancel': return (await call(w, 'POST', `${o}/customer/orders/${orderId}/cancel`, cast.customer.token, { reason: 'walk: changed my mind' })).statusCode;
    case 'store.accept': return (await call(w, 'PUT', `${o}/vendor/orders/${orderId}/accept`, cast.vendorOwner.token)).statusCode;
    case 'store.preparing': return (await call(w, 'PUT', `${o}/vendor/orders/${orderId}/preparing`, cast.vendorOwner.token)).statusCode;
    case 'store.ready': return (await call(w, 'PUT', `${o}/vendor/orders/${orderId}/ready`, cast.vendorOwner.token)).statusCode;
    case 'store.reject': return (await call(w, 'PUT', `${o}/vendor/orders/${orderId}/reject`, cast.vendorOwner.token, { reason: 'walk: out of stock' })).statusCode;
    case 'store.retry': return (await call(w, 'POST', `${o}/vendor/orders/${orderId}/retry-dispatch`, cast.vendorOwner.token, {})).statusCode;
    case 'rider.online': return (await call(w, 'POST', `${o}/rider/go-online`, rider!.token, { latitude: rider!.lat, longitude: rider!.lng })).statusCode;
    case 'rider.offline': return (await call(w, 'POST', `${o}/rider/go-offline`, rider!.token, {})).statusCode;
    case 'rider.accept': return (await call(w, 'POST', `${o}/rider/orders/${orderId}/accept`, rider!.token)).statusCode;
    case 'rider.step': return (await call(w, 'PUT', `${o}/rider/orders/${orderId}/${act.step}`, rider!.token)).statusCode;
    case 'rider.handback': return (await call(w, 'POST', `${o}/rider/orders/${orderId}/handback`, rider!.token, { reason: 'walk: bike trouble' })).statusCode;
    case 'rider.handover': {
      const detail = await call(w, 'GET', `${o}/customer/orders/${orderId}`, cast.customer.token);
      const ridePin = detail.json()?.data?.ridePin;
      return (await call(w, 'POST', `${o}/rider/orders/${orderId}/handover`, rider!.token, {
        outcome: 'paid', gps: { lat: 6.8045, lng: -58.1553 }, ...(typeof ridePin === 'string' ? { ridePin } : {}),
      })).statusCode;
    }
    case 'admin.cancel': return (await adminCall(w, 'PUT', `${o}/admin/orders/${orderId}/cancel`, { reason: 'walk: admin decision', refund: act.refund })).statusCode;
    case 'admin.refundSettled': {
      const row = await w.app.prisma.order.findUnique({ where: { id: orderId }, select: { refundOwedAmount: true } });
      const amount = Number(row?.refundOwedAmount ?? 0);
      return (await adminCall(w, 'PUT', `${o}/admin/orders/${orderId}/refund-settled`, { reference: `WALK${Date.now().toString(36).toUpperCase()}`, amount })).statusCode;
    }
    case 'wait':
      await advance(w, cast, act.ms, WALK_SWEEP_MS);
      return 0;
    case 'abandon':
      if (!act.ridersOnline) {
        for (const r of cast.riders) await call(w, 'POST', `${o}/rider/go-offline`, r.token, {});
      }
      await abandon(w, cast, orderId);
      return 0;
  }
}

/** Everybody stops; only the sweeps run, until the order is terminal or the horizon passes. */
async function abandon(w: WalkWorld, cast: Cast, orderId: string): Promise<void> {
  const sinceSweep = { ms: 0 };
  for (let t = 0; t < HORIZON_MS; t += 3 * 3600_000) {
    await advance(w, cast, 3 * 3600_000, ABANDON_SWEEP_MS, sinceSweep);
    const o = await w.app.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (o && isTerminalOrderStatus(o.status)) {
      // Stay a little longer: a terminal order must stay quiet too.
      await advance(w, cast, 3 * 3600_000, ABANDON_SWEEP_MS, sinceSweep);
      return;
    }
  }
}

// ─── Invariants ─────────────────────────────────────────────────────────────

interface Snap {
  status: OrderStatus;
  logs: OrderStatus[];
  riderId: string | null;
  readyAt: Date | null;
  paymentMethod: string;
  paymentStatus: string;
  totalAmount: number;
  refundOwed: number | null;
  refundPaid: number | null;
}

async function snap(w: WalkWorld, orderId: string): Promise<Snap> {
  const o = await w.app.prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true, riderId: true, readyAt: true, paymentMethod: true, paymentStatus: true, totalAmount: true,
      refundOwedAmount: true, refundPaidAmount: true,
      statusHistory: { select: { status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  return {
    status: o.status, logs: o.statusHistory.map((l) => l.status), riderId: o.riderId, readyAt: o.readyAt,
    paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, totalAmount: Number(o.totalAmount),
    refundOwed: o.refundOwedAmount == null ? null : Number(o.refundOwedAmount),
    refundPaid: o.refundPaidAmount == null ? null : Number(o.refundPaidAmount),
  };
}

const PREP_STAMP_STATUSES: readonly OrderStatus[] = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

/** Notices that are offers to movers, not news to a person: a fresh search may re-offer. */
const OFFER_TITLES = /^🛵|order available|new delivery/i;

interface CheckState {
  reportedNotice: Set<string>; jobErrorsSeen: number; prev: Snap | null;
  /** notification id -> the status epoch in force when it first appeared (stamped every clock tick and step). */
  noticeEpoch: Map<string, number>;
}

/** Status changes so far (a same-status timeline note is not a change). */
const statusEpoch = (logs: readonly OrderStatus[]) => logs.reduce((n, l, i) => (i > 0 && l !== logs[i - 1] ? n + 1 : n), 0);

/** Give every notice of the order not seen before the status epoch in force now. */
async function stampNotices(w: WalkWorld, orderId: string, st: CheckState, logs?: readonly OrderStatus[]) {
  const live = logs ?? (await w.app.prisma.orderStatusLog.findMany({
    where: { orderId }, select: { status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })).map((l) => l.status);
  const epoch = statusEpoch(live);
  const rows = await w.app.prisma.$queryRawUnsafe<Array<{ id: string; userId: string; title: string }>>(
    `SELECT n.id, n."userId", n.title FROM notifications n WHERE n.data->>'orderId' = $1`,
    orderId,
  );
  for (const r of rows) if (!st.noticeEpoch.has(r.id)) st.noticeEpoch.set(r.id, epoch);
  return rows;
}

async function checkInvariants(
  w: WalkWorld, cast: Cast, orderId: string, at: number, http: number, st: CheckState,
): Promise<Violation[]> {
  const out: Violation[] = [];
  const s = await snap(w, orderId);
  const v = (inv: string, detail: string) => out.push({ inv, detail, at, status: s.status, finding: null });

  // LOG-HEAD: the newest status log names the status the order is in.
  const head = s.logs[s.logs.length - 1];
  if (head !== s.status) v('LOG-HEAD', `status ${s.status} but newest log ${head ?? 'none'}`);

  // EDGE: every consecutive pair of the log is a declared forward or recovery edge.
  if (s.logs[0] && s.logs[0] !== 'PENDING') v('EDGE', `first log ${s.logs[0]}`);
  for (let i = 1; i < s.logs.length; i += 1) {
    const from = s.logs[i - 1]!; const to = s.logs[i]!;
    // A same-status row is a timeline note, not a transition — but only the
    // store's "preparing / ready (rider already assigned)" stamps write one
    // (vendor.routes recordPrepProgress), and only in these three statuses.
    // Anywhere else a repeated status is a double write.
    if (from === to && PREP_STAMP_STATUSES.includes(to)) continue;
    const ok = ORDER_TRANSITIONS[to].includes(from) || RECOVERY_TRANSITIONS[to].includes(from);
    if (!ok) v('EDGE', `${from}>${to} is not a declared edge`);
  }

  // REFUSAL-INERT: a refused request moves nothing.
  if (st.prev && http >= 400 && (st.prev.status !== s.status || st.prev.logs.length !== s.logs.length)) {
    v('REFUSAL-INERT', `HTTP ${http} yet ${st.prev.status}→${s.status} (+${s.logs.length - st.prev.logs.length} logs)`);
  }

  // CASH: delivered cash is captured cash; a refund is never more than was taken.
  if (s.paymentMethod === 'CASH') {
    if ((s.status === 'DELIVERED' || s.status === 'COMPLETED') && s.paymentStatus !== 'CAPTURED') {
      v('CASH-DELIVERED-UNCAPTURED', `${s.status} with paymentStatus ${s.paymentStatus}`);
    }
    const captured = s.paymentStatus === 'CAPTURED' || s.paymentStatus === 'REFUNDED' ? s.totalAmount : 0;
    if (s.refundOwed != null && s.refundOwed > captured) v('REFUND-OVER-CAPTURED', `refund owed ${s.refundOwed} > captured ${captured} (paymentStatus ${s.paymentStatus})`);
    if (s.refundPaid != null && s.refundPaid > (s.refundOwed ?? 0)) v('REFUND-PAID-OVER-OWED', `refund paid ${s.refundPaid} > owed ${s.refundOwed}`);
  }

  // EARN: a mover is paid once, and only for a finished delivery.
  const earnings = await w.app.prisma.earning.findMany({ where: { orderId }, select: { riderId: true, type: true } });
  const seenEarn = new Set<string>();
  for (const e of earnings) {
    const k = `${e.riderId}|${e.type}`;
    if (seenEarn.has(k)) v('EARN-TWICE', `two ${e.type} earnings for rider ${e.riderId}`);
    seenEarn.add(k);
  }
  if (earnings.length > 0 && !['DELIVERED', 'COMPLETED', 'REFUNDED'].includes(s.status)) v('EARN-UNFINISHED', `${earnings.length} earning(s) on a ${s.status} order`);

  // RIDER-POINTER: a rider points at a live order it holds, and only then.
  for (const r of cast.riders) {
    const row = await w.app.prisma.rider.findUnique({ where: { id: r.riderId }, select: { currentOrderId: true } });
    const holds = s.riderId === r.riderId && !isTerminalOrderStatus(s.status);
    if (row?.currentOrderId === orderId && !holds) v('RIDER-POINTER', `rider ${r.riderId} still points at a ${s.status} order it does not hold`);
    if (holds && row?.currentOrderId !== orderId) v('RIDER-POINTER', `rider ${r.riderId} holds the ${s.status} order but points at ${row?.currentOrderId ?? 'nothing'}`);
  }

  // VIEWS: the customer and the store see the status the order is in.
  const cv = await call(w, 'GET', `/api/v1/customer/orders/${orderId}`, cast.customer.token);
  if (cv.statusCode === 200 && cv.json()?.data?.status !== s.status) v('VIEW-CUSTOMER', `customer sees ${cv.json()?.data?.status}, order is ${s.status}`);
  const sv = await call(w, 'GET', `/api/v1/vendor/orders/${orderId}`, cast.vendorOwner.token);
  if (sv.statusCode === 200 && sv.json()?.data?.status !== s.status) v('VIEW-STORE', `store sees ${sv.json()?.data?.status}, order is ${s.status}`);

  // NOTICE-ONCE: one notice per person, per title, per status the order was in.
  // A notice belongs to the status in force when it first appears: stamped
  // after every tick of the walk clock and after every step (stampNotices),
  // counted in status changes. Never by timestamp: aged notices read against
  // log stamps aged by another rule would put a whole life in one status.
  const rows = await stampNotices(w, orderId, st, s.logs);
  const groups = new Map<string, { userId: string; title: string; epoch: number; n: number }>();
  for (const r of rows) {
    const e = st.noticeEpoch.get(r.id)!;
    const k = `${r.userId}|${r.title}|${e}`;
    const g = groups.get(k) ?? { userId: r.userId, title: r.title, epoch: e, n: 0 };
    g.n += 1;
    groups.set(k, g);
  }
  for (const [k, n] of groups) {
    if (n.n < 2 || OFFER_TITLES.test(n.title)) continue;
    if (st.reportedNotice.has(k)) continue;
    st.reportedNotice.add(k);
    const who = n.userId === cast.customer.userId ? 'customer' : n.userId === cast.vendorOwner.userId ? 'store'
      : cast.riders.some((r) => r.userId === n.userId) ? 'rider' : 'admin';
    v('NOTICE-ONCE', `${who} got "${n.title}" ${n.n}x in one status (status #${n.epoch})`);
  }

  // JOB-THREW: a sweep or job the production worker runs threw.
  for (const e of w.jobErrors.slice(st.jobErrorsSeen)) v('JOB-THREW', `${e.name}: ${e.message}`);
  st.jobErrorsSeen = w.jobErrors.length;

  st.prev = s;
  for (const x of out) x.finding = classify(x, s);
  return out;
}

/** Recorded findings (the order-flow findings list, OF-nn ids). A fix PR
 *  deletes its line here, and its pinned trace in the test turns red if the
 *  violation is still produced. */
export function classify(x: Violation, s: Snap): string | null {
  const noRider = s.riderId == null;
  // OF-01 (riderless never-ready exit + the dispatch notice loop) is FIXED:
  // it is no longer classified, so any recurrence fails the walk.
  if (x.inv === 'REFUND-OVER-CAPTURED' && s.paymentMethod === 'CASH' && s.paymentStatus === 'PENDING') return 'OF-02';
  if (x.inv === 'EXIT' && ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(s.status)) return 'OF-12';
  if (x.inv === 'EXIT' && ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(s.status) && !noRider) return 'OF-33';
  return null;
}

// ─── Running a trace ────────────────────────────────────────────────────────

export interface RunOptions {
  /** Stop at the first UNKNOWN violation (shrinking needs only that one). */
  stopAtUnknown?: boolean;
}

/** Chooses the next action from the live status; null ends the walk. */
type Next = (i: number, s: Snap, assigned: number | null) => Action | null;

async function walk(w: WalkWorld, riders: number, next: Next, opts: RunOptions = {}): Promise<WalkResult> {
  const cast = await castWalk(w, riders);
  const before = new Set(w.orderIds);
  try {
    return await walkCast(w, cast, next, opts);
  } finally {
    // Leave nothing behind that another walk (or another suite) could dispatch
    // to: the walk's riders go offline (no current order), its store closes,
    // and an order it left unfinished is deleted — otherwise the NEXT walk's
    // sweeps would re-drive it to the next walk's riders. (A finished order
    // stays; nothing dispatches a terminal order.)
    w.onTick = null;
    w.sched.pending = [];
    for (const r of cast.riders) {
      await w.app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: false, currentOrderId: null } }).catch(() => {});
    }
    await w.app.prisma.vendor.update({ where: { id: cast.vendorId }, data: { acceptingOrders: false, isCurrentlyOpen: false } }).catch(() => {});
    for (const id of [...w.orderIds].filter((x) => !before.has(x))) {
      const o = await w.app.prisma.order.findUnique({ where: { id }, select: { status: true } }).catch(() => null);
      if (!o || isTerminalOrderStatus(o.status)) continue;
      await w.app.prisma.$executeRawUnsafe('DELETE FROM dispatch_searches WHERE "subjectId" = $1', id).catch(() => {});
      await w.app.prisma.order.delete({ where: { id } }).then(() => w.orderIds.delete(id)).catch(() => {});
    }
  }
}

async function walkCast(w: WalkWorld, cast: Cast, next: Next, opts: RunOptions): Promise<WalkResult> {
  const riders = cast.riders.length;
  const actions: Action[] = [];
  const result: WalkResult = { trace: { riders, actions }, orderId: null, finalStatus: null, violations: [], coverage: new Map(), edges: new Set() };
  for (const r of cast.riders) await call(w, 'POST', '/api/v1/rider/go-online', r.token, { latitude: r.lat, longitude: r.lng });
  const co = await placeCashOrder(w, cast);
  const orderId = co.orderId;
  if (!orderId) {
    result.violations.push({ inv: 'SETUP', detail: `checkout ${co.status}: ${co.body.slice(0, 200)}`, at: -1, status: 'none', finding: null });
    return result;
  }
  result.orderId = orderId;
  await drainDue(w);
  const st: CheckState = { reportedNotice: new Set(), jobErrorsSeen: w.jobErrors.length, prev: null, noticeEpoch: new Map() };
  w.onTick = async () => { await stampNotices(w, orderId, st); };
  result.violations.push(...await checkInvariants(w, cast, orderId, -1, 0, st));

  for (let i = 0; ; i += 1) {
    const act = next(i, st.prev!, await riderIndexOf(w, cast, orderId));
    if (!act) break;
    actions.push(act);
    const before = st.prev!.status;
    const http = await perform(w, cast, orderId, act);
    const found = await checkInvariants(w, cast, orderId, i, http, st);
    const after = st.prev!.status;
    const key = `${before} --${describeAction(act).replace(/^rider\d/, 'rider')}--> ${after}${http ? ` [${http}]` : ''}`;
    result.coverage.set(key, (result.coverage.get(key) ?? 0) + 1);
    if (act.a === 'abandon' && !isTerminalOrderStatus(after)) {
      const x: Violation = { inv: 'EXIT', detail: `still ${after} ${HORIZON_MS / 3600_000} h after everybody stopped acting`, at: i, status: after, finding: null };
      x.finding = classify(x, st.prev!);
      found.push(x);
    }
    result.violations.push(...found);
    if (opts.stopAtUnknown && found.some((x) => x.finding === null)) break;
  }
  const logs = st.prev!.logs;
  for (let i = 1; i < logs.length; i += 1) result.edges.add(`${logs[i - 1]}>${logs[i]}`);
  result.finalStatus = st.prev!.status;
  return result;
}

/** Replay a recorded trace exactly. */
export function runTrace(w: WalkWorld, trace: Trace, opts: RunOptions = {}): Promise<WalkResult> {
  return walk(w, trace.riders, (i) => trace.actions[i] ?? null, opts);
}

/** Walk a seed: 8–22 weighted actions chosen from the LIVE status (so the
 *  trace is recorded as it is walked), then — unless the order is finished —
 *  abandon (60%). The returned result's trace replays the walk exactly. */
export function walkSeed(w: WalkWorld, seed: number): Promise<WalkResult> {
  const rnd = mulberry32(seed);
  const riders = 1 + Math.floor(rnd() * 2);
  const length = 8 + Math.floor(rnd() * 15);
  return walk(w, riders, (i, s, assigned) => {
    if (i > length) return null;
    if (i === length) {
      if (isTerminalOrderStatus(s.status) || rnd() < 0.4) return null;
      return { a: 'abandon', ridersOnline: rnd() < 0.5 };
    }
    if (rnd() < 0.15) return anyAction(rnd, riders);
    const r = assigned ?? Math.floor(rnd() * riders);
    return pick(rnd, sensible(s.status, r, rnd, s.refundOwed != null && s.refundPaid == null));
  });
}

// ─── Shrinking ──────────────────────────────────────────────────────────────

export const violationKey = (x: Violation) => `${x.inv}|${x.finding ?? 'UNKNOWN'}|${x.inv === 'EXIT' ? x.status : ''}`;

/** ddmin-style: drop chunks of actions while the same violation still appears. */
export async function shrink(w: WalkWorld, trace: Trace, target: Violation, budget = 25): Promise<{ trace: Trace; replays: number }> {
  const key = violationKey(target);
  let best = trace.actions.slice();
  let replays = 0;
  const reproduces = async (actions: Action[]) => {
    replays += 1;
    const r = await runTrace(w, { riders: trace.riders, actions }, { stopAtUnknown: target.finding === null });
    return r.violations.some((x) => violationKey(x) === key);
  };
  for (let chunk = Math.max(1, Math.floor(best.length / 2)); chunk >= 1 && replays < budget; chunk = Math.floor(chunk / 2)) {
    for (let i = 0; i < best.length && replays < budget;) {
      const cand = [...best.slice(0, i), ...best.slice(i + chunk)];
      if (cand.length < best.length && await reproduces(cand)) best = cand;
      else i += chunk;
    }
    if (chunk === 1) break;
  }
  return { trace: { riders: trace.riders, actions: best }, replays };
}

export function describeAction(a: Action): string {
  switch (a.a) {
    case 'rider.step': return `rider${a.r}.${a.step}`;
    case 'rider.online': case 'rider.offline': case 'rider.accept': case 'rider.handover': case 'rider.handback': return `rider${a.r}.${a.a.slice(6)}`;
    case 'admin.cancel': return `admin.cancel(${a.refund ? 'refund' : 'no-refund'})`;
    case 'wait': return `wait ${a.ms >= 3600_000 ? `${a.ms / 3600_000}h` : a.ms >= 60_000 ? `${a.ms / 60_000}m` : `${a.ms / 1000}s`}`;
    case 'abandon': return `abandon(${a.ridersOnline ? 'riders online' : 'riders offline'}, ${HORIZON_MS / 3600_000}h)`;
    default: return a.a;
  }
}
