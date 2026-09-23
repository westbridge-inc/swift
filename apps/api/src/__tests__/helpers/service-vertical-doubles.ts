import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';

/**
 * Service-free doubles for the service-vertical seams.
 *
 * The reads PROJECT: `findFirst`/`findUnique`/`findMany` apply the exact
 * `select` a route sends, so a projection that stops at the select — the
 * failure class the Home active-order contract was written for — fails here
 * exactly as it fails over the wire. `findMany`/`updateMany`/`count` grade the
 * `where` a seam sends against fixture rows (a predicate column the fixture
 * does not carry throws rather than being skipped). Anything a seam reaches
 * that is not modelled throws a TRIPWIRE. Nothing here opens PostgreSQL,
 * Redis, a socket or a queue.
 */
export type Row = Record<string, unknown>;
export type Where = Record<string, unknown>;

/** Anything not explicitly modelled throws: reaching it means a gate was passed. */
export function tripwireProxy<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'constructor') return undefined;
      if (prop in t) return (t as Record<string | symbol, unknown>)[prop];
      throw new Error(`TRIPWIRE[${label}]: .${String(prop)} reached — the seam proceeded past its modelled boundary`);
    },
  });
}

// ── where evaluation (the subset these seams send) ──────────────────────────

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

function ordinal(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return null;
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
}

function branches(cond: unknown): Where[] {
  return Array.isArray(cond) ? (cond as Where[]) : [cond as Where];
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'AND') {
      if (!branches(cond).every((c) => matchesWhere(row, c))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!branches(cond).some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (branches(cond).some((c) => matchesWhere(row, c))) return false;
      continue;
    }
    if (!(key in row)) {
      throw new Error(`service-vertical-doubles: fixture row has no column "${key}" — add it so the predicate is graded, not skipped`);
    }
    const value = row[key];
    if (!isOperatorObject(cond)) {
      if (!same(value, cond)) return false;
      continue;
    }
    for (const [op, bound] of Object.entries(cond)) {
      switch (op) {
        case 'equals':
          if (!same(value, bound)) return false;
          break;
        case 'in':
          if (value == null || !(bound as unknown[]).some((b) => same(value, b))) return false;
          break;
        case 'notIn':
          if (value == null || (bound as unknown[]).some((b) => same(value, b))) return false;
          break;
        case 'not':
          if (bound === null) {
            if (value == null) return false;
          } else if (isOperatorObject(bound)) {
            if (value == null || matchesWhere(row, { [key]: bound })) return false;
          } else if (value == null || same(value, bound)) {
            return false;
          }
          break;
        case 'lt': case 'lte': case 'gt': case 'gte': {
          const a = ordinal(value);
          const b = ordinal(bound);
          if (a === null || b === null) return false;
          if (op === 'lt' && !(a < b)) return false;
          if (op === 'lte' && !(a <= b)) return false;
          if (op === 'gt' && !(a > b)) return false;
          if (op === 'gte' && !(a >= b)) return false;
          break;
        }
        default:
          throw new Error(`service-vertical-doubles: unsupported operator "${op}" on "${key}"`);
      }
    }
  }
  return true;
}

// ── select projection ───────────────────────────────────────────────────────

/** Apply a Prisma `select` (with nested `{ select }` relations) to a row.
 *  Without a select the row is returned as a copy — `include` semantics: the
 *  fixture already carries its relations. */
export function project(row: Row, select?: Record<string, unknown>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, on] of Object.entries(select)) {
    if (on === false || on === undefined) continue;
    if (!(key in row)) {
      throw new Error(`service-vertical-doubles: select asked for "${key}" but the fixture row has no such column — add it so the projection is graded`);
    }
    const value = row[key];
    if (isOperatorObject(on) && 'select' in on) {
      const nested = (on as { select?: Record<string, unknown> }).select;
      if (Array.isArray(value)) out[key] = value.map((v) => project(v as Row, nested));
      else out[key] = value == null ? value : project(value as Row, nested);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ── the order store ─────────────────────────────────────────────────────────

export interface RecordedQuery { method: string; args: Record<string, unknown> }

export interface OrderStore {
  rows: Row[];
  /** Every order query as sent — the select and where a seam actually used. */
  queries: RecordedQuery[];
  order: {
    findFirst: (args: { where?: Where; select?: Record<string, unknown> }) => Promise<Row | null>;
    findUnique: (args: { where: { id: string }; select?: Record<string, unknown> }) => Promise<Row | null>;
    findUniqueOrThrow: (args: { where: { id: string }; select?: Record<string, unknown>; include?: Record<string, unknown> }) => Promise<Row>;
    findMany: (args: { where?: Where; select?: Record<string, unknown>; take?: number; skip?: number }) => Promise<Row[]>;
    count: (args: { where?: Where }) => Promise<number>;
    updateMany: (args: { where: Where; data: Row }) => Promise<{ count: number }>;
    update: (args: { where: { id: string }; data: Row; select?: Record<string, unknown> }) => Promise<Row>;
  };
}

/** Apply a Prisma `data` argument the way the database does: the atomic
 *  number operations (`{ increment: 1 }` and friends) change the stored number
 *  instead of replacing it with the operation object. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    const op = value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
    const current = row[key];
    if (op && Object.keys(op).length === 1 && typeof current === 'number') {
      const [name, amount] = Object.entries(op)[0] as [string, unknown];
      if (typeof amount === 'number') {
        if (name === 'increment') { row[key] = current + amount; continue; }
        if (name === 'decrement') { row[key] = current - amount; continue; }
        if (name === 'multiply') { row[key] = current * amount; continue; }
        if (name === 'divide') { row[key] = current / amount; continue; }
        if (name === 'set') { row[key] = amount; continue; }
      }
    }
    row[key] = value;
  }
}

export function orderStore(rows: Row[]): OrderStore {
  const queries: RecordedQuery[] = [];
  const store: OrderStore = {
    rows,
    queries,
    order: {
      findFirst: async (args) => {
        queries.push({ method: 'order.findFirst', args });
        const row = rows.find((r) => matchesWhere(r, args.where));
        return row ? project(row, args.select) : null;
      },
      findUnique: async (args) => {
        queries.push({ method: 'order.findUnique', args });
        const row = rows.find((r) => r['id'] === args.where.id);
        return row ? project(row, args.select) : null;
      },
      findUniqueOrThrow: async (args) => {
        queries.push({ method: 'order.findUniqueOrThrow', args });
        const row = rows.find((r) => r['id'] === args.where.id);
        if (!row) throw new Error(`orderStore: findUniqueOrThrow of a row that does not exist (${args.where.id})`);
        return project(row, args.select);
      },
      findMany: async (args) => {
        queries.push({ method: 'order.findMany', args });
        const hit = rows.filter((r) => matchesWhere(r, args.where));
        return hit.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? hit.length)).map((r) => project(r, args.select));
      },
      count: async (args) => {
        queries.push({ method: 'order.count', args });
        return rows.filter((r) => matchesWhere(r, args.where)).length;
      },
      updateMany: async (args) => {
        queries.push({ method: 'order.updateMany', args });
        const hit = rows.filter((r) => matchesWhere(r, args.where));
        for (const r of hit) applyData(r, args.data);
        return { count: hit.length };
      },
      update: async (args) => {
        queries.push({ method: 'order.update', args });
        const row = rows.find((r) => r['id'] === args.where.id);
        if (!row) throw new Error(`orderStore: update of a row that does not exist (${args.where.id})`);
        applyData(row, args.data);
        return project(row, args.select);
      },
    },
  };
  return store;
}

/** Enough of PrismaClient for the seams under test; unmodelled models are tripwires. */
export function prismaDouble(store: OrderStore, extra: Record<string, unknown> = {}): PrismaClient {
  return tripwireProxy({ order: store.order, ...extra }, 'prisma') as unknown as PrismaClient;
}

// ── recording socket server ─────────────────────────────────────────────────

export interface RecordedEmit { room: string; event: string; payload: unknown }
export interface RecordingIo { emits: RecordedEmit[] }

export function recordingIo(): Server & RecordingIo {
  const emits: RecordedEmit[] = [];
  const io = {
    emits,
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); return true; } }),
  };
  return io as unknown as Server & RecordingIo;
}

// ── recording Redis (the cache/lock commands these routes use) ──────────────

export interface RecordedCall { op: string; args: unknown[] }
export interface RecordingRedis { calls: RecordedCall[]; strings: Map<string, string> }

export function recordingRedis(seed: Record<string, string> = {}): Redis & RecordingRedis {
  const strings = new Map<string, string>(Object.entries(seed));
  const calls: RecordedCall[] = [];
  const record = (op: string, ...args: unknown[]) => { calls.push({ op, args }); };
  const modelled = {
    calls,
    strings,
    get: async (key: string) => { record('get', key); return strings.get(key) ?? null; },
    set: async (key: string, value: string, ...rest: unknown[]) => { record('set', key, value, ...rest); strings.set(key, value); return 'OK'; },
    setex: async (key: string, ttl: number, value: string) => { record('setex', key, ttl); strings.set(key, value); return 'OK'; },
    del: async (...keys: string[]) => { record('del', ...keys); let n = 0; for (const k of keys) if (strings.delete(k)) n += 1; return n; },
    scan: async (..._args: unknown[]) => { record('scan'); return ['0', []] as [string, string[]]; },
    ttl: async (key: string) => { record('ttl', key); return strings.has(key) ? 60 : -2; },
    expire: async (key: string, seconds: number) => { record('expire', key, seconds); return strings.has(key) ? 1 : 0; },
  };
  return tripwireProxy(modelled, 'redis') as unknown as Redis & RecordingRedis;
}

/** A Redis that must never be reached: the worker entering its offer phase is the finding. */
export function redisTripwire(): Redis {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => { throw new Error(`TRIPWIRE[redis]: redis.${String(prop)} reached — the worker entered the offer phase`); };
    },
  }) as unknown as Redis;
}

// ── route host ──────────────────────────────────────────────────────────────

export interface EnqueuedJob { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }

export interface RouteHost {
  app: FastifyInstance;
  /** Every job handed to `app.dispatchQueue.add` (enqueueDeliveryDispatch). */
  enqueued: EnqueuedJob[];
  /** Invoke a registered handler directly (`"get /home"`). Auth and tenant
   *  hooks are not the subject: the principal is bound on the request. */
  call: (route: string, request: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Host a REAL route plugin on a recording Fastify stand-in: route registrations
 * are captured by verb + path, hooks are inert, the dispatch queue records
 * instead of enqueuing. Nothing here listens, connects or authenticates.
 */
export async function hostRoutes(
  routes: (app: FastifyInstance) => Promise<void>,
  parts: { prisma: PrismaClient; redis: Redis; io: Server },
): Promise<RouteHost> {
  const handlers = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
  const enqueued: EnqueuedJob[] = [];
  const quiet = () => undefined;
  const app: Record<string, unknown> = {
    prisma: parts.prisma,
    redis: parts.redis,
    io: parts.io,
    log: { info: quiet, warn: quiet, error: quiet, debug: quiet, child: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) },
    prefix: '',
    authenticate: async () => undefined,
    authenticateOptional: async () => undefined,
    addHook: quiet,
    register: async () => undefined,
    decorate: quiet,
    queues: {},
    dispatchQueue: {
      add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => { enqueued.push({ name, data, opts }); },
    },
  };
  for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
    app[verb] = (path: string, ...args: unknown[]) => {
      handlers.set(`${verb} ${path}`, args.at(-1) as (request: unknown, reply: unknown) => Promise<unknown>);
    };
  }
  await routes(app as unknown as FastifyInstance);
  return {
    app: app as unknown as FastifyInstance,
    enqueued,
    call: async (route, request) => {
      const handler = handlers.get(route);
      if (!handler) throw new Error(`hostRoutes: no handler registered for "${route}"`);
      const reply = { type: () => reply, header: () => reply, code: () => reply, status: () => reply, log: app['log'] };
      return handler({ headers: {}, query: {}, params: {}, body: undefined, log: app['log'], ...request }, reply);
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** A SERVICE business's appointment as the database holds it TODAY: on the
 *  legacy FOOD_DELIVERY spine, distinguished only by its fulfillment and its
 *  business type. Every column the graded predicates and projections read. */
export function serviceBooking(id: string, extra: Row = {}): Row {
  const now = Date.now();
  return {
    id,
    orderNumber: `ORD-${id.toUpperCase()}`,
    tenantId: 'swift-default',
    orderType: 'FOOD_DELIVERY',
    fulfillment: 'APPOINTMENT',
    fulfillmentMode: null,
    fulfillmentModeVersion: 0,
    status: 'PENDING',
    customerId: 'user-customer',
    customer: { id: 'user-customer', firstName: 'Ama' },
    vendorId: 'vendor-svc',
    vendor: {
      id: 'vendor-svc', name: 'Kim’s Barbershop', slug: 'kims-barbershop', logoUrl: null, coverImageUrl: null,
      vendorType: 'SERVICE', phone: null, latitude: 6.8, longitude: -58.15, ownerId: 'owner-svc',
      selfDeliveryEnabled: false, estimatedPrepTime: null, owner: { userId: 'user-provider' },
    },
    riderId: null,
    driverId: null,
    rider: null,
    driver: null,
    items: [{ id: 'oi-1', itemId: 'item-haircut', name: 'Skin fade', quantity: 1, basePrice: 2000, markedUpPrice: 2000, totalCustomer: 2000, totalBase: 2000, specialInstructions: null, bulkUnits: null, selectedOptions: [] }],
    statusHistory: [],
    appointmentSlot: new Date(now + 26 * HOUR),
    scheduledFor: null,
    holdExpiresAt: null,
    releasedToVendorAt: null,
    placedAt: new Date(now - 10 * MINUTE),
    updatedAt: new Date(now - 10 * MINUTE),
    acceptedAt: null, preparingAt: null, readyAt: null, pickedUpAt: null, deliveredAt: null, cancelledAt: null,
    cancellationReason: null, cancelledBy: null, lateCancelFeeDue: null,
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    mmgPayUrlSnapshot: null,
    mmgRecipientNameSnapshot: null,
    mmgClaimMismatchAt: null,
    subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
    deliveryFee: 0, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, totalAmount: 2000,
    isExpress: false,
    pickupCode: null,
    courierTrackingToken: null,
    pickupAddress: '12 Camp St, Georgetown', pickupLat: 6.8, pickupLng: -58.15,
    deliveryAddress: '12 Camp St, Georgetown', deliveryLat: 6.8, deliveryLng: -58.15,
    deliveryInstructions: null,
    billableKm: null, billableKmSource: null,
    estimatedPrepTime: null, estimatedDeliveryTime: null,
    promisedAt: null, promiseRevisedAt: null, promiseRevisionReason: null, promiseRevisions: null,
    rideClass: null, taxiFareTotal: null, taxiPassengerCount: null, courierPackageSize: null,
    riskFlagged: false, riskReason: null,
    foodAgeHeldAt: null, foodAgeWaivedAt: null,
    ...extra,
  };
}

/** A restaurant delivery — the control that must keep every food word. */
export function foodDelivery(id: string, extra: Row = {}): Row {
  return serviceBooking(id, {
    fulfillment: 'DELIVERY',
    vendorId: 'vendor-food',
    vendor: {
      id: 'vendor-food', name: 'Trigger Diner', slug: 'trigger-diner', logoUrl: null, coverImageUrl: null,
      vendorType: 'RESTAURANT', phone: null, latitude: 6.81, longitude: -58.16, ownerId: 'owner-food',
      selfDeliveryEnabled: false, estimatedPrepTime: 20, owner: { userId: 'user-cook' },
    },
    items: [{ id: 'oi-2', itemId: 'item-roti', name: 'Chicken roti', quantity: 2, basePrice: 1200, markedUpPrice: 1200, totalCustomer: 2400, totalBase: 2400, specialInstructions: null, bulkUnits: null, selectedOptions: [] }],
    appointmentSlot: null,
    deliveryFee: 500,
    subtotalBase: 2400, subtotalCustomer: 2400, totalAmount: 2900,
    deliveryAddress: '4 Home St, Georgetown', deliveryLat: 6.82, deliveryLng: -58.17,
    estimatedPrepTime: 20,
    ...extra,
  });
}

/** A courier parcel: no vendor, born READY_FOR_PICKUP, released to riders by the hold tick. */
export function courierParcel(id: string, extra: Row = {}): Row {
  return serviceBooking(id, {
    orderType: 'COURIER',
    fulfillment: 'DELIVERY',
    status: 'READY_FOR_PICKUP',
    vendorId: null,
    vendor: null,
    items: [],
    appointmentSlot: null,
    ...extra,
  });
}
