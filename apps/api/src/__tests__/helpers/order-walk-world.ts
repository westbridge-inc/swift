/**
 * [ORDER-FLOW · random walk] The WORLD a model-based random walk drives.
 *
 * Everything that decides an order's fate is the real code: the HTTP routes
 * (customer, store, rider, admin) through `app.inject`, the dispatch engine,
 * and the same sweeps and job handlers the production workers run
 * (jobs/queue.ts) — called with the same arguments, in the same order.
 *
 * Two things are doubles, and both are acknowledged here:
 *
 *  1. BullMQ. `WalkScheduler` records every `add` (name, data, delay, jobId)
 *     and runs a job when its delay has elapsed on the walk clock, with the
 *     production handler. Like BullMQ it keeps the FIRST job of a jobId: a
 *     re-add of a jobId it has already seen is a no-op (completed jobs are
 *     retained, removeOnComplete: 100), which is what the E36 replay keys rely
 *     on. Repeatable sweeps run on the walk's sweep cadence instead of cron.
 *
 *  2. Time. The walk never fakes `Date`: Postgres stamps `now()` and Prisma
 *     stamps `@default(now())` / `@updatedAt` from the real clock, and a JS-only
 *     fake would leave the two clocks disagreeing. Instead, advancing the walk
 *     clock by Δ AGES the walk's own world by Δ: every timestamp column of its
 *     orders and of their child rows (any table with an `orderId`, dispatch
 *     searches, notifications of its people) moves Δ into the past, every
 *     Redis TTL in the walk's database shrinks by Δ (a key whose TTL is under Δ
 *     is gone), and every recorded job comes Δ closer to due. People stay
 *     alive: an online rider's location is re-pinged after every step, and
 *     sessions, stores and documents are not aged. Aging is the clock, not a
 *     change to the record: it runs in ONE transaction with
 *     `session_replication_role = replica` (test DB, superuser), so the
 *     append-only and immutability triggers (order_status_logs, evidence,
 *     stock movements) let the timestamps move with everything else. A table
 *     that still refuses FAILS the walk with the database's error: a world
 *     whose clocks disagree (aged notices, unaged status logs) is not the
 *     world production runs in.
 */
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { registerErrorHandler } from '../../middleware/error-handler';
import { authRoutes } from '../../modules/auth/auth.routes';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { makeDispatchService, reconcileStuckDispatch } from '../../modules/dispatch/dispatch.service';
import { isTerminalOrderStatus } from '../../modules/order/order-status';
import { autoCancelUnresponsiveOrder, inTenantOf, releaseHeldOrdersJob } from '../../jobs/queue';
import { NotificationService } from '../../modules/notification/notification.service';
import { loginWithOtp } from './otp';
import { testPhone, fixtureTag, wordFreeTag } from './fixture-ids';
import { TEST_ADMIN_REASON } from './admin-reason';
import { cleanupSecondApprovers, injectWithApproval } from './admin-approval';

export type QueueName = 'dispatch' | 'offer' | 'order' | 'notification';
export interface WalkJob {
  queue: QueueName;
  name: string;
  data: Record<string, unknown>;
  /** Real epoch ms at which the job is due; aged with the world. */
  dueAt: number;
  jobId?: string;
  seq: number;
}

/** The BullMQ double (see the file header). */
export class WalkScheduler {
  pending: WalkJob[] = [];
  /** Every job name ever added, for the coverage map. */
  added = new Map<string, number>();
  /** Jobs added that the walk has no handler for (named, never silent). */
  unhandled = new Map<string, number>();
  private seen = new Set<string>();
  private seq = 0;

  queue(queue: QueueName) {
    return {
      add: async (name: string, data: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => {
        const jobId = typeof opts['jobId'] === 'string' ? (opts['jobId'] as string) : undefined;
        this.added.set(name, (this.added.get(name) ?? 0) + 1);
        if (opts['repeat']) return { id: `repeat-${name}` };
        if (jobId) {
          const key = `${queue}:${jobId}`;
          if (this.seen.has(key)) return { id: jobId };
          this.seen.add(key);
        }
        const delay = typeof opts['delay'] === 'number' ? Math.max(0, opts['delay'] as number) : 0;
        this.seq += 1;
        this.pending.push({ queue, name, data: { ...data }, dueAt: Date.now() + delay, ...(jobId ? { jobId } : {}), seq: this.seq });
        return { id: jobId ?? `walk-${this.seq}` };
      },
      // A few call sites read these; the double answers like an empty queue.
      getJob: async () => null,
      remove: async () => 0,
      getDelayed: async () => [],
    };
  }

  age(ms: number): void {
    for (const j of this.pending) j.dueAt -= ms;
  }

  msToNextDue(): number {
    if (this.pending.length === 0) return Infinity;
    return Math.max(0, Math.min(...this.pending.map((j) => j.dueAt)) - Date.now());
  }

  takeDue(): WalkJob | null {
    const now = Date.now();
    const due = this.pending.filter((j) => j.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
    const first = due[0];
    if (!first) return null;
    this.pending = this.pending.filter((j) => j !== first);
    return first;
  }

}

export interface Person { userId: string; token: string; phone: string }
export interface RiderFx extends Person { riderId: string; lat: number; lng: number }
export interface Cast {
  customer: Person;
  vendorOwner: Person;
  vendorId: string;
  itemId: string;
  riders: RiderFx[];
}

export interface WalkWorld {
  app: FastifyInstance;
  sched: WalkScheduler;
  admin: Person;
  /** Wall-clock ms when the admin's access token was issued (it lives 15
   *  minutes of REAL time: the walk clock never fakes Date). */
  adminTokenAt: number;
  /** Every cast made in this world, so a suite can release them all (releaseWorld). */
  casts: Cast[];
  /** Every user and order a walk made, for ageing and cleanup. */
  userIds: Set<string>;
  orderIds: Set<string>;
  vendorIds: Set<string>;
  /** Runs after every tick of the walk clock (the walk stamps new notices with the live status). */
  onTick: (() => Promise<void>) | null;
  /** Total Δ the walk clock has advanced, ms. */
  clockMs: number;
  /** Errors a sweep or job threw (they never stop the walk; invariants read them). */
  jobErrors: Array<{ name: string; message: string }>;
}

const STORE_LAT = 6.8013;
const STORE_LNG = -58.1551;

export async function buildWalkWorld(): Promise<WalkWorld> {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  const sched = new WalkScheduler();
  app.decorate('dispatchQueue', sched.queue('dispatch') as never);
  app.decorate('offerQueue', sched.queue('offer') as never);
  app.decorate('queues', {
    orderQueue: sched.queue('order'),
    notificationQueue: sched.queue('notification'),
    dispatchQueue: sched.queue('dispatch'),
    offerQueue: sched.queue('offer'),
  } as never);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const adminPhone = testPhone();
  const adminUser = await app.prisma.user.create({
    data: { phone: adminPhone, firstName: 'Walk', lastName: 'Admin', roles: ['ADMIN'] as never, activeRole: 'ADMIN' as never, isPhoneVerified: true },
  });
  const adminToken = await accessTokenFor(app, adminPhone);
  const world: WalkWorld = {
    app, sched,
    admin: { userId: adminUser.id, token: adminToken, phone: adminPhone }, adminTokenAt: Date.now(),
    userIds: new Set([adminUser.id]), orderIds: new Set(), vendorIds: new Set(), onTick: null,
    clockMs: 0, jobErrors: [], casts: [],
  };
  return world;
}

async function personWithSession(w: WalkWorld, roles: UserRole[], activeRole: UserRole, name: string): Promise<Person> {
  const phone = testPhone();
  const user = await w.app.prisma.user.create({
    data: {
      phone, firstName: 'Walk', lastName: name, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  w.userIds.add(user.id);
  const token = w.app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await w.app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `walk-${fixtureTag(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 7 * 86_400_000) },
  });
  return { userId: user.id, token, phone };
}

/** A fresh customer, store (one item) and `riderCount` verified riders, ONLINE at the store. */
export async function castWalk(w: WalkWorld, riderCount: number): Promise<Cast> {
  const tag = fixtureTag(8);
  const customer = await personWithSession(w, ['CUSTOMER'], 'CUSTOMER', 'Customer');
  await w.app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '77 Walk Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8045, longitude: -58.1553, isDefault: true },
  });
  const vendorOwner = await personWithSession(w, ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', 'Store');
  const owner = await w.app.prisma.vendorOwner.create({ data: { userId: vendorOwner.userId } });
  const vendor = await w.app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Walk Kitchen ${wordFreeTag(8)}`, slug: `walk-kitchen-${tag}`, vendorType: 'RESTAURANT', phone: vendorOwner.phone,
      addressLine1: '42 Walk Road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: STORE_LAT, longitude: STORE_LNG,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  w.vendorIds.add(vendor.id);
  const category = await w.app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } });
  const item = await w.app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: category.id, name: 'Walk Pepperpot', basePrice: 2500, isAvailable: true },
  });
  const riders: RiderFx[] = [];
  for (let i = 0; i < riderCount; i += 1) {
    const p = await personWithSession(w, ['RIDER', 'CUSTOMER'], 'RIDER', `Rider${i}`);
    const lat = STORE_LAT + 0.0005 * (i + 1);
    const lng = STORE_LNG;
    const rider = await w.app.prisma.rider.create({
      data: { userId: p.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true, currentLat: lat, currentLng: lng, floatLimit: 1_000_000 },
    });
    riders.push({ ...p, riderId: rider.id, lat, lng });
  }
  const cast: Cast = { customer, vendorOwner, vendorId: vendor.id, itemId: item.id, riders };
  w.casts.push(cast);
  return cast;
}

/** The customer checks out ONE item, cash, through the real cart and checkout doors. */
export async function placeCashOrder(w: WalkWorld, cast: Cast): Promise<{ orderId: string | null; status: number; body: string }> {
  await call(w, 'DELETE', '/api/v1/customer/cart', cast.customer.token);
  await call(w, 'POST', '/api/v1/customer/cart/items', cast.customer.token, { vendorId: cast.vendorId, itemId: cast.itemId, quantity: 1 });
  const co = await call(w, 'POST', '/api/v1/customer/checkout', cast.customer.token, { paymentMethod: 'CASH' });
  const orderId = co.statusCode === 200 ? (co.json()?.data?.order?.id as string | undefined) ?? null : null;
  if (orderId) w.orderIds.add(orderId);
  return { orderId, status: co.statusCode, body: co.body };
}

async function accessTokenFor(app: FastifyInstance, phone: string): Promise<string> {
  const res = await loginWithOtp(app, phone);
  const token = res.json()?.data?.tokens?.accessToken;
  if (res.statusCode !== 200 || typeof token !== 'string') throw new Error(`walk: login for the walk admin answered ${res.statusCode}`);
  return token;
}

/** Every walk caller holds a live token, so a 401 is never a product answer:
 *  it means a walk token expired, and a door that answers it did nothing the
 *  walk asked for. That fails the walk instead of passing as a refusal. */
function refuseExpired(res: LightMyRequestResponse, method: string, url: string): LightMyRequestResponse {
  if (res.statusCode === 401) throw new Error(`walk: ${method} ${url} answered 401 (a walk token expired): ${res.body.slice(0, 160)}`);
  return res;
}

export async function call(
  w: WalkWorld, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const res = await w.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return refuseExpired(res, method, url);
}

/** The admin outlives the walks (one per run), so its token is renewed before
 *  it can expire: a slow run (machine load) passes 15 minutes. */
const ADMIN_TOKEN_RENEW_MS = 10 * 60_000;

export async function adminCall(w: WalkWorld, method: 'PUT' | 'POST', url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  if (Date.now() - w.adminTokenAt > ADMIN_TOKEN_RENEW_MS) {
    w.admin = { ...w.admin, token: await accessTokenFor(w.app, w.admin.phone) };
    w.adminTokenAt = Date.now();
  }
  const res = await (injectWithApproval(w.app, {
    method, url,
    headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${w.admin.token}`, 'content-type': 'application/json' },
    payload,
  } as never) as Promise<LightMyRequestResponse>);
  return refuseExpired(res, method, url);
}

/** Leave nothing of a cast that another walk or another suite could dispatch
 *  to or list: its riders go offline (no current order) and its store closes
 *  for good (CLOSED: browse lists closed-today stores too, by rating, and a
 *  suite sharing the database reads only the first page). */
export async function releaseCast(w: WalkWorld, cast: Cast): Promise<void> {
  for (const r of cast.riders) {
    await w.app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: false, currentOrderId: null } }).catch(() => {});
  }
  await w.app.prisma.vendor.update({ where: { id: cast.vendorId }, data: { acceptingOrders: false, isCurrentlyOpen: false, status: 'CLOSED' } }).catch(() => {});
}

/** Delete one unfinished order (a finished one stays: nothing dispatches it). */
export async function deleteUnfinished(w: WalkWorld, orderId: string): Promise<void> {
  const o = await w.app.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } }).catch(() => null);
  if (!o || isTerminalOrderStatus(o.status)) return;
  await w.app.prisma.$executeRawUnsafe('DELETE FROM dispatch_searches WHERE "subjectId" = $1', orderId).catch(() => {});
  await w.app.prisma.order.delete({ where: { id: orderId } }).then(() => w.orderIds.delete(orderId)).catch(() => {});
}

/** A suite's afterAll: release every cast, delete every unfinished order, and
 *  retire the world's admins. Ops pages go to EVERY admin, so admins left by
 *  earlier runs would multiply each page (and slow the walk) on a reused DB. */
export async function releaseWorld(w: WalkWorld): Promise<void> {
  w.onTick = null;
  w.sched.pending = [];
  for (const cast of w.casts) await releaseCast(w, cast);
  for (const id of [...w.orderIds]) await deleteUnfinished(w, id);
  await w.app.prisma.user.update({ where: { id: w.admin.userId }, data: { roles: ['CUSTOMER'] as never, activeRole: 'CUSTOMER' as never } }).catch(() => {});
  await cleanupSecondApprovers(w.app).catch(() => {});
}

// ─── Time ──────────────────────────────────────────────────────────────────

let timestampColumns: Map<string, string[]> | null = null;
let orderChildTables: string[] | null = null;

async function loadSchema(w: WalkWorld): Promise<void> {
  if (timestampColumns && orderChildTables) return;
  const cols = await w.app.prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; data_type: string }>>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'`,
  );
  timestampColumns = new Map();
  for (const c of cols) {
    const list = timestampColumns.get(c.table_name) ?? [];
    list.push(c.column_name);
    timestampColumns.set(c.table_name, list);
  }
  const children = await w.app.prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'orderId' AND table_name <> 'orders'`,
  );
  orderChildTables = children.map((r) => r.table_name).filter((t) => timestampColumns!.has(t)).sort();
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function ageStatement(table: string, keyColumn: string, keysParam: string): string | null {
  const cols = timestampColumns!.get(table) ?? [];
  if (cols.length === 0) return null;
  const set = cols.map((c) => `${q(c)} = ${q(c)} - make_interval(secs => $1::double precision)`).join(', ');
  return `UPDATE ${q(table)} SET ${set} WHERE ${q(keyColumn)} = ANY(${keysParam}::text[])`;
}

/** Every table the walk ages, as [table, key column, which key set]. */
function ageTargets(): Array<[string, string, 'orders' | 'users']> {
  return [
    ['orders', 'id', 'orders'],
    ...orderChildTables!.map((t): [string, string, 'orders'] => [t, 'orderId', 'orders']),
    ['dispatch_searches', 'subjectId', 'orders'],
    // A decision about a walk order is part of its history: the riderless
    // cutoff's grace runs from one (rescue.ts RIDERLESS_TOLD_OUTCOME).
    ['algo_decisions', 'subjectId', 'orders'],
    ['notifications', 'userId', 'users'],
  ];
}

async function ageRows(w: WalkWorld, ms: number): Promise<void> {
  const orders = [...w.orderIds];
  const users = [...w.userIds];
  const parts = ageTargets()
    .map(([t, k, set], i) => {
      const stmt = ageStatement(t, k, set === 'orders' ? '$2' : '$3');
      return stmt ? `a${i} AS (${stmt} RETURNING 1)` : null;
    })
    .filter((x): x is string => x !== null);
  if (parts.length === 0) return;
  // [REVIEW-G S4-1] One statement touches many tables in no fixed order, so a
  // product transaction holding some of the same rows can deadlock with it
  // (40P01; seen once locally). Postgres aborts the clock's side and nothing
  // was aged: retrying is exact. Any other error, or a third deadlock, fails.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await w.app.prisma.$transaction(async (tx) => {
        // Replica mode skips ordinary triggers for this transaction only, so the
        // append-only guards on status logs and evidence do not refuse the clock.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        // ONE round trip: every UPDATE as a data-modifying CTE of one statement.
        await tx.$executeRawUnsafe(`WITH ${parts.join(', ')} SELECT 1`, ms / 1000, orders, users);
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < 3 && /40P01|deadlock detected/.test(message)) continue;
      throw new Error(`walk clock: could not age the walk's rows by ${ms} ms (${message})`);
    }
  }
}

async function ageRedis(w: WalkWorld, ms: number): Promise<void> {
  const redis = w.app.redis;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    if (keys.length === 0) continue;
    const ttls = await keys.reduce((p, k) => p.pttl(k), redis.pipeline()).exec();
    const fix = redis.pipeline();
    keys.forEach((key, i) => {
      const pttl = Number(ttls?.[i]?.[1] ?? -1);
      if (pttl <= 0) return; // -1 no TTL, -2 gone
      if (pttl <= ms) fix.del(key);
      else fix.pexpire(key, pttl - ms);
    });
    await fix.exec();
  } while (cursor !== '0');
}

/** Age the walk's world by `ms` (see the file header). */
export async function ageWorld(w: WalkWorld, ms: number): Promise<void> {
  if (ms <= 0) return;
  await loadSchema(w);
  await ageRows(w, ms);
  await ageRedis(w, ms);
  w.sched.age(ms);
  w.clockMs += ms;
}

/** People stay alive while time passes: an online rider keeps pinging. */
export async function heartbeat(w: WalkWorld, cast: Cast): Promise<void> {
  for (const r of cast.riders) {
    const row = await w.app.prisma.rider.findUnique({ where: { id: r.riderId }, select: { isOnline: true, currentOrderId: true } });
    if (!row?.isOnline && !row?.currentOrderId) continue;
    await call(w, 'PUT', '/api/v1/rider/location', r.token, { latitude: r.lat, longitude: r.lng, accuracy: 8 });
  }
}

// ─── The production jobs and sweeps ────────────────────────────────────────

function jobCtx(w: WalkWorld) {
  return { prisma: w.app.prisma, io: w.app.io, redis: w.app.redis, log: w.app.log };
}

async function guarded(w: WalkWorld, name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    w.jobErrors.push({ name, message: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
}

/** Run ONE recorded job with the handler the production worker uses. */
export async function runJob(w: WalkWorld, job: WalkJob): Promise<void> {
  const orderId = String(job.data['orderId'] ?? '');
  const tenantId = typeof job.data['tenantId'] === 'string' ? (job.data['tenantId'] as string) : undefined;
  const dispatch = makeDispatchService(w.app);
  switch (job.name) {
    case 'dispatch-order':
      await guarded(w, job.name, () => inTenantOf(w.app.prisma, { order: orderId }, () =>
        dispatch.dispatchOrder(orderId, tenantId, `${job.jobId ?? `walk-${job.seq}`}@${job.dueAt}`)));
      return;
    case 'offer-timeout':
      await guarded(w, job.name, () => inTenantOf(w.app.prisma, { order: orderId }, () =>
        dispatch.handleOfferTimeout(orderId, String(job.data['riderId']), job.data['attemptId'] as string | undefined)));
      return;
    case 'auto-cancel':
      await guarded(w, job.name, () => inTenantOf(w.app.prisma, { order: orderId }, () => autoCancelUnresponsiveOrder(jobCtx(w), orderId)));
      return;
    default:
      w.sched.unhandled.set(job.name, (w.sched.unhandled.get(job.name) ?? 0) + 1);
  }
}

/** The repeatable sweeps that touch a store-delivery order, as jobs/queue.ts
 *  runs them: stale-movers (minus the GPS sweep: walk riders stay alive, and
 *  the taxi watchdog), reconcile-dispatch, release-held-orders and the
 *  checkout-outbox drains. */
export async function runSweeps(w: WalkWorld): Promise<void> {
  const ctx = jobCtx(w);
  const enqueue = async (orderId: string) => {
    await w.app.dispatchQueue!.add('dispatch-order', { orderId }, { removeOnComplete: 100, removeOnFail: 50 });
  };
  const notifications = () => new NotificationService(w.app.prisma, w.app.io);
  await guarded(w, 'stale-movers:delivery-watchdog', async () => {
    const { recoverStrandedDeliveries } = await import('../../modules/dispatch/delivery-watchdog');
    await recoverStrandedDeliveries(w.app.prisma, w.app.redis, w.app.io, enqueue);
  });
  await guarded(w, 'stale-movers:pickup-overdue', async () => {
    const { sweepPickupOverdue } = await import('../../modules/dispatch/pickup-overdue');
    await sweepPickupOverdue({ prisma: w.app.prisma, redis: w.app.redis, io: w.app.io, notifications: notifications() }, enqueue);
  });
  await guarded(w, 'stale-movers:food-age', async () => {
    const { sweepFoodAge } = await import('../../modules/dispatch/rescue');
    await sweepFoodAge({ prisma: w.app.prisma, redis: w.app.redis, io: w.app.io, notifications: notifications() });
  });
  await guarded(w, 'stale-movers:custody-escalation', async () => {
    const { escalateOverdueCases } = await import('../../modules/custody/custody-recovery');
    await escalateOverdueCases({ prisma: w.app.prisma, io: w.app.io, notifications: notifications() } as never);
  });
  await guarded(w, 'reconcile-dispatch', () => reconcileStuckDispatch(w.app.prisma, w.app.redis, enqueue));
  await guarded(w, 'release-held-orders', () => releaseHeldOrdersJob(ctx as never, { dispatchQueue: w.app.dispatchQueue, orderQueue: w.app.queues!.orderQueue, notificationQueue: w.app.queues!.notificationQueue } as never));
  await guarded(w, 'checkout-outbox', async () => {
    const { drainCheckoutOutbox } = await import('../../modules/order/checkout-outbox');
    await drainCheckoutOutbox({ prisma: w.app.prisma, queues: w.app.queues as never, log: w.app.log }, { limit: 200 });
  });
  await guarded(w, 'checkout-outbox:rescue-notice', async () => {
    const { drainRescueNotices } = await import('../../modules/dispatch/rescue');
    await drainRescueNotices({ prisma: w.app.prisma, redis: w.app.redis, io: w.app.io, notifications: notifications() }, { limit: 50 });
  });
  await guarded(w, 'checkout-outbox:rider-cancel-notice', async () => {
    const { drainRiderCancellationNotices } = await import('../../modules/order/rider-cancel-notice');
    await drainRiderCancellationNotices({ prisma: w.app.prisma, notifications: notifications() });
  });
  await guarded(w, 'checkout-outbox:handover-notice', async () => {
    const { drainHandoverNotices } = await import('../../modules/handover/handover-notice');
    await drainHandoverNotices({ prisma: w.app.prisma, notifications: notifications() });
  });
}

/** Run every job that is due now, including jobs those jobs schedule at once. */
export async function drainDue(w: WalkWorld): Promise<number> {
  let n = 0;
  for (let job = w.sched.takeDue(); job; job = w.sched.takeDue()) {
    await runJob(w, job);
    n += 1;
    if (n > 500) throw new Error('walk: more than 500 jobs due at one instant — a job loop');
  }
  return n;
}

/**
 * Advance the walk clock by `ms`: age the world in steps that stop at every
 * recorded job's due time and at every sweep tick, running what falls due.
 */
export async function advance(w: WalkWorld, cast: Cast, ms: number, sweepEveryMs: number, sinceSweep = { ms: 0 }): Promise<void> {
  let remaining = ms;
  await drainDue(w);
  while (remaining > 0) {
    const step = Math.min(remaining, w.sched.msToNextDue(), Math.max(0, sweepEveryMs - sinceSweep.ms));
    if (step > 0) {
      await ageWorld(w, step);
      remaining -= step;
      sinceSweep.ms += step;
      await heartbeat(w, cast);
    }
    await drainDue(w);
    if (sinceSweep.ms >= sweepEveryMs) {
      await runSweeps(w);
      await drainDue(w);
      sinceSweep.ms = 0;
    }
    if (w.onTick) await w.onTick();
  }
}
