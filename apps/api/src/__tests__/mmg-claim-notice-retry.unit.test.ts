/**
 * [ORDER-SPINE S1-6 · R2 · Sol review S2] A dispute or operator notice stays
 * OWED until its recipients hold durable inbox rows.
 *
 * R1 left an incomplete obligation unprocessed on the request's fast path, but
 * the generic outbox publisher then marked the row processed as soon as BullMQ
 * accepted the job, and the worker only logged an incomplete result. A page
 * that reached nobody, or an inbox write that failed, was consumed for good
 * while the disputed order stayed held.
 *
 * These run the sweep as production composes it — the generic
 * `drainCheckoutOutbox` publisher, then the sweep's own in-process drain of
 * obligations whose delivery must be confirmed — plus, as R1 did, a worker run
 * for anything the publisher handed to the queue. The `order_outbox` is in
 * memory, emulating the publisher's claim statement, with recipient-keyed
 * inbox dedupe.
 */
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../modules/admin/admin.routes';
import { NotificationService, notifyAdmins } from '../modules/notification/notification.service';
import { CHECKOUT_OUTBOX_VERSION, checkoutOutboxId, drainCheckoutOutbox } from '../modules/order/checkout-outbox';
import * as claim from '../modules/order/mmg-claim.service';
import type { MmgClaimNotice } from '../modules/order/mmg-claim.service';
import { runWithTenant } from '../plugins/tenant-context';

type Row = Record<string, any>;
const T0 = new Date('2026-09-22T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;
const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined };

const DISPUTED: Row = {
  id: 'order-1', tenantId: 'tenant-a', orderNumber: 'SW-3001', customerId: 'customer-1', vendorId: 'vendor-1',
  orderType: 'FOOD_DELIVERY', status: 'ACCEPTED', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED',
  customerMmgClaim: 'NOT_PAID', customerMmgClaimAt: T0, customerClaimedPaidAt: null, customerPaymentRef: null,
  mmgAttestedRef: 'MMGA0001', mmgClaimMismatchAt: T0, mmgClaimRevision: 2, mmgClaimResolution: null,
  mmgClaimResolvedAt: null, mmgClaimResolvedRevision: null, vendor: { owner: { userId: 'owner-user' } },
};

const OPENED: MmgClaimNotice = {
  orderId: 'order-1', tenantId: 'tenant-a', revision: 2, effect: 'DISAGREEMENT_OPENED',
  openedBy: 'CUSTOMER', reason: 'CUSTOMER_DENIED', resolution: null,
};

function obligation(notice: MmgClaimNotice = OPENED): Row {
  const dedupeKey = claim.mmgClaimNoticeDedupeKey(notice.orderId, notice.revision);
  return {
    id: checkoutOutboxId(dedupeKey), tenantId: notice.tenantId, dedupeKey, orderId: notice.orderId,
    kind: claim.MMG_CLAIM_NOTICE_KIND, queue: 'notification', payload: { version: CHECKOUT_OUTBOX_VERSION, ...notice },
    delayMs: 0, attempts: 0, availableAt: T0, claimedAt: null, processedAt: null, lastError: null, createdAt: T0,
  };
}

function matches(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) { if (value != null) return false; continue; }
    if (cond instanceof Date) { if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false; continue; }
    if (cond && typeof cond === 'object') {
      const c = cond as Row;
      if ('lte' in c && !(value instanceof Date && value.getTime() <= (c['lte'] as Date).getTime())) return false;
      if ('lt' in c && !(value instanceof Date && value.getTime() < (c['lt'] as Date).getTime())) return false;
      if ('in' in c && !(c['in'] as unknown[]).includes(value)) return false;
      if ('not' in c && value === c['not']) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Row)) row[key] = (row[key] as number) + ((value as Row)['increment'] as number);
    else row[key] = value;
  }
}

class FakeOutboxDb {
  now = at(1_000);
  order: Row = structuredClone(DISPUTED);
  inbox = new Map<string, string>();
  delivered: Row[] = [];
  pages: Row[] = [];
  adminsReachable = 0;
  failOnce = new Set<string>();
  sendCalls = 0;
  published: Array<{ name: string; payload: Row }> = [];
  constructor(public rows: Row[]) {}

  /** The generic publisher's claim statement (checkout-outbox claimNextRow),
   *  emulated clause by clause from the SQL it actually sends. */
  private claimForPublisher(q: { strings: readonly string[]; values: readonly unknown[] }): Row[] {
    const text = q.strings.join('$?');
    if (!text.includes('FROM "order_outbox"') || !text.includes('FOR UPDATE SKIP LOCKED')) throw new Error(`unexpected raw statement: ${text}`);
    let leaseMs = 60_000;
    let orderIds: string[] | null = null;
    let excludedKinds: string[] = [];
    q.values.forEach((value, i) => {
      const before = q.strings[i] ?? '';
      if (/"orderId" = ANY\($/.test(before)) orderIds = value as string[];
      else if (/NOT \("kind" = ANY\($/.test(before)) excludedKinds = value as string[];
      else if (typeof value === 'number') leaseMs = value;
    });
    const now = this.now.getTime();
    const due = this.rows
      .filter((r) => r['processedAt'] == null && (r['availableAt'] as Date).getTime() <= now)
      .filter((r) => r['claimedAt'] == null || (r['claimedAt'] as Date).getTime() < now - leaseMs)
      .filter((r) => !orderIds || orderIds.includes(r['orderId']))
      .filter((r) => !excludedKinds.includes(r['kind']))
      .sort((a, b) => (a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime());
    const row = due[0];
    if (!row) return [];
    row['claimedAt'] = new Date(now);
    row['attempts'] += 1;
    row['lastError'] = null;
    return [{ id: row['id'], orderId: row['orderId'], kind: row['kind'], queue: row['queue'], payload: structuredClone(row['payload']), delayMs: row['delayMs'], attempts: row['attempts'], createdAt: row['createdAt'] }];
  }

  get prisma(): Row {
    return {
      $queryRaw: async (q: { strings: readonly string[]; values: readonly unknown[] }) => this.claimForPublisher(q),
      orderOutbox: {
        update: async ({ where, data }: { where: Row; data: Row }) => {
          const row = this.rows.find((r) => r['id'] === where['id']);
          if (!row) throw new Error('no such outbox row');
          apply(row, data);
          return row;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const hit = this.rows.filter((r) => matches(r, where));
          for (const row of hit) apply(row, data);
          return { count: hit.length };
        },
        findFirst: async ({ where }: { where: Row }) => {
          const hit = this.rows.filter((r) => matches(r, where))
            .sort((a, b) => (a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime())[0];
          return hit ? structuredClone(hit) : null;
        },
      },
      order: {
        findFirst: async ({ where }: { where: Row }) =>
          (where['id'] === this.order['id'] && where['tenantId'] === this.order['tenantId'] ? structuredClone(this.order) : null),
      },
    };
  }

  get deps(): Row {
    return {
      prisma: this.prisma,
      now: () => this.now,
      notifications: {
        send: async (p: Row) => {
          this.sendCalls += 1;
          if (this.failOnce.delete(p['userId'])) return ''; // the inbox write failed; nothing persisted
          const key = `${p['userId']}|${p['dedupeKey']}`;
          const existing = this.inbox.get(key);
          if (existing) return existing;
          const id = `inbox-${this.inbox.size + 1}`;
          this.inbox.set(key, id);
          this.delivered.push(p);
          return id;
        },
      },
      pageAdmins: async (p: Row) => {
        if (this.adminsReachable === 0) return 0;
        const key = `operators|${p['dedupeKey']}`;
        if (!this.inbox.has(key)) { this.inbox.set(key, 'page'); this.pages.push(p); }
        return this.adminsReachable;
      },
    };
  }
}

/** The production sweep: publish → worker → the sweep's in-process drain. */
async function sweep(db: FakeOutboxDb): Promise<void> {
  const queue = { add: async (name: string, payload: Row) => { db.published.push({ name, payload }); return {}; } };
  await drainCheckoutOutbox(
    { prisma: db.prisma as never, queues: { orderQueue: queue, notificationQueue: queue, dispatchQueue: queue } as never, log: SILENT },
    { limit: 20 },
  );
  for (const job of db.published) {
    if (job.name === claim.MMG_CLAIM_NOTICE_KIND) await claim.runMmgClaimNoticeJob(db.deps as never, job.payload);
  }
  const drain = (claim as Record<string, unknown>)['drainMmgClaimNotices'] as undefined | ((deps: unknown, options: unknown) => Promise<unknown>);
  if (drain) await drain(db.deps, { limit: 20 });
}

describe('an incomplete dispute notice stays owed until delivered', () => {
  it('no operator reachable: the obligation survives the sweep, and the page lands exactly once when one is', async () => {
    const db = new FakeOutboxDb([obligation()]);
    await sweep(db);
    const row = db.rows[0]!;
    expect(row['processedAt'], 'a page that reached nobody must not be consumed').toBeNull();
    expect(db.pages).toHaveLength(0);
    expect(db.delivered.map((n) => n['dedupeKey'])).toEqual(['mmg-claim:order-1:r2:customer', 'mmg-claim:order-1:r2:business']);

    db.adminsReachable = 2;
    db.now = at(HOUR);
    await sweep(db);
    expect(row['processedAt'], 'delivered, so done').not.toBeNull();
    expect(db.pages).toHaveLength(1);
    expect(db.pages[0]).toMatchObject({ tenantId: 'tenant-a', dedupeKey: 'mmg-claim:order-1:r2:admin', data: { kind: 'mmg_claim_mismatch', orderId: 'order-1' } });
    expect(db.delivered, 'the recipients who already had it get nothing twice').toHaveLength(2);
  });

  it('a failed inbox write stays owed and is retried; nobody is notified twice', async () => {
    const db = new FakeOutboxDb([obligation()]);
    db.adminsReachable = 1;
    db.failOnce.add('owner-user');
    await sweep(db);
    const row = db.rows[0]!;
    expect(row['processedAt'], 'the store never received it').toBeNull();
    expect(db.delivered.map((n) => n['userId'])).toEqual(['customer-1']);

    db.now = at(HOUR);
    await sweep(db);
    expect(row['processedAt']).not.toBeNull();
    expect(db.delivered.map((n) => n['userId'])).toEqual(['customer-1', 'owner-user']);
    expect(db.pages).toHaveLength(1);
  });

  it('an obligation that became moot is closed without speaking', async () => {
    const db = new FakeOutboxDb([obligation()]);
    await sweep(db);
    expect(db.rows[0]!['processedAt']).toBeNull();
    Object.assign(db.order, {
      mmgClaimMismatchAt: null, mmgClaimRevision: 3, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: at(2_000), mmgClaimResolvedRevision: 3,
    });
    db.adminsReachable = 3;
    db.now = at(HOUR);
    await sweep(db);
    expect(db.rows[0]!['processedAt'], 'nothing is owed any more').not.toBeNull();
    expect(db.pages, 'a resolved dispute is never paged as open').toHaveLength(0);
  });

  it('a retry waits for its backoff, and is not repeated by a sweep that runs sooner', async () => {
    const db = new FakeOutboxDb([obligation()]);
    await sweep(db);
    const row = db.rows[0]!;
    expect(row['processedAt']).toBeNull();
    expect(row['claimedAt'], 'the lease is released for the next attempt').toBeNull();
    expect(row['lastError'], 'roles and counts only — no person, order or payment detail').toBe('incomplete: sent customer,business; operators reached 0');
    expect((row['availableAt'] as Date).getTime()).toBeGreaterThan(db.now.getTime());
    const attempts = row['attempts'];
    db.adminsReachable = 1;
    db.now = at(2_000);
    await sweep(db);
    expect(row['attempts'], 'still backing off').toBe(attempts);
    expect(db.pages).toHaveLength(0);
  });

  it('the queue publisher never consumes a confirmed-delivery obligation; ordinary outbox work still flows', async () => {
    const alert = {
      ...obligation(), id: 'oob_alert', dedupeKey: 'order:order-1:vendor-alert-escalate', kind: 'vendor-alert-escalate',
      payload: { version: CHECKOUT_OUTBOX_VERSION, orderId: 'order-1', level: 0 }, createdAt: at(-1),
    };
    const db = new FakeOutboxDb([alert, obligation()]);
    db.adminsReachable = 1;
    const queue = { add: async (name: string, payload: Row) => { db.published.push({ name, payload }); return {}; } };
    await drainCheckoutOutbox(
      { prisma: db.prisma as never, queues: { orderQueue: queue, notificationQueue: queue, dispatchQueue: queue } as never, log: SILENT },
      { limit: 20 },
    );
    expect(db.published.map((j) => j.name)).toEqual(['vendor-alert-escalate']);
    expect(db.rows.find((r) => r['kind'] === claim.MMG_CLAIM_NOTICE_KIND)!['processedAt']).toBeNull();
    expect(db.rows.find((r) => r['kind'] === 'vendor-alert-escalate')!['processedAt']).not.toBeNull();
  });

  it('two sweeps draining at once: one lease, one delivery attempt', async () => {
    const db = new FakeOutboxDb([obligation()]);
    db.adminsReachable = 1;
    const drain = (claim as Record<string, unknown>)['drainMmgClaimNotices'] as (deps: unknown, options: unknown) => Promise<unknown>;
    await Promise.all([drain(db.deps, { limit: 5 }), drain(db.deps, { limit: 5 })]);
    const row = db.rows[0]!;
    expect(row['attempts'], 'exactly one sweep leased it').toBe(1);
    expect(row['processedAt']).not.toBeNull();
    expect(db.sendCalls, 'customer + business, once').toBe(2);
    expect(db.pages).toHaveLength(1);
  });

  it('a drain that died holding the lease: the row waits for the lease to lapse, then is delivered once', async () => {
    const db = new FakeOutboxDb([{ ...obligation(), claimedAt: at(1_000), attempts: 1 }]);
    db.adminsReachable = 1;
    db.now = at(30_000);
    await sweep(db);
    const row = db.rows[0]!;
    expect(row['attempts'], 'a live lease is respected').toBe(1);
    expect(db.sendCalls).toBe(0);
    db.now = at(62_000);
    await sweep(db);
    expect(row['attempts']).toBe(2);
    expect(row['processedAt']).not.toBeNull();
    expect(db.delivered).toHaveLength(2);
    expect(db.pages).toHaveLength(1);
  });

  it('a poison obligation is kept and backed off with its reason — never consumed, never touching the order', async () => {
    const poison = { ...obligation(), payload: { version: CHECKOUT_OUTBOX_VERSION, orderId: 'order-1', tenantId: 'tenant-a', revision: 'two', effect: 'DISAGREEMENT_OPENED' } };
    const db = new FakeOutboxDb([poison]);
    db.adminsReachable = 1;
    const orderBefore = structuredClone(db.order);
    await sweep(db);
    const row = db.rows[0]!;
    expect(row['processedAt'], 'an undeliverable obligation is not silently dropped').toBeNull();
    expect(row['lastError']).toMatch(/^failed: mmg-claim-notice: revision/);
    expect((row['availableAt'] as Date).getTime()).toBeGreaterThan(db.now.getTime());
    expect(db.sendCalls + db.pages.length).toBe(0);
    expect(db.order, 'delivery never replays or changes the claim').toEqual(orderBefore);
  });
});

// ─── [R3 · F-R2-ASTRA-01] the operator page as production runs it ──────────
//
// A retried obligation re-runs its operator page. The inbox dedupe collapses
// it into the first delivery (no second row, no second push); the ADMIN_OPS
// tracking row — the sent evidence any reader of `alert_deliveries` counts —
// must collapse with it, or every sweep of a still-owed dispute manufactures a
// page nobody was sent. Everything on the operator path is production code:
// the drain's default `pageAdmins`, `notifyAdmins`, `NotificationService.send`
// and `publishPersisted`, and the `/alerts/health` handler `adminRoutes`
// registers, read through the admin routes' own tenant child scope. [R4 ·
// F-PR1262-SOL-04] That scoped read counts only rows about the tenant's own
// orders sent to the tenant's own users (REPORT-007), so it counts no ADMIN_OPS
// page at all — the page's subject is its kind — and these tests pin exactly
// that, beside a positive control it does count. Only storage and transport
// are in memory: an inbox with its (userId, dedupeKey) unique index, an
// `alert_deliveries` table whose primary key a plain insert violates and
// `skipDuplicates` (ON CONFLICT DO NOTHING) passes over, and a socket and push
// channel that record what they carry.

/** The filters the scoped health read sends: its `sentAt` window and the
 *  child scope's `AND` of `in` lists. Anything else fails loudly. */
function alertMatches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((c) => alertMatches(row, c));
    if (key === 'OR') return (cond as Row[]).some((c) => alertMatches(row, c));
    if (cond instanceof Date || cond === null || typeof cond !== 'object') return row[key] === cond;
    const unmodelled = Object.keys(cond).filter((op) => op !== 'in' && op !== 'gte');
    if (unmodelled.length > 0) throw new Error(`unmodelled alertDelivery filter on ${key}: ${unmodelled.join(', ')}`);
    if ('in' in cond && !(cond['in'] as unknown[]).includes(row[key])) return false;
    if ('gte' in cond && !((row[key] as Date).getTime() >= (cond['gte'] as Date).getTime())) return false;
    return true;
  });
}

/** Prisma's query extension as `adminRoutes` declares one: a model's hook
 *  (`$allOperations`, or one named operation) wraps that model's operations,
 *  and its `query` runs the base operation with the hook's arguments. */
function extendWithQueryHooks(base: Row, extension: { query?: Record<string, Row> }): Row {
  const extended: Row = { ...base };
  for (const [model, hooks] of Object.entries(extension.query ?? {})) {
    const delegate = base[model] as Row | undefined;
    if (!delegate) continue;
    extended[model] = Object.fromEntries(Object.entries(delegate).map(([operation, run]) => {
      const hook = (hooks['$allOperations'] ?? hooks[operation]) as ((p: Row) => Promise<unknown>) | undefined;
      const query = (args: Row) => (run as (a: Row) => Promise<unknown>)(args);
      return [operation, hook ? (args: Row = {}) => hook({ model, operation, args, query }) : query];
    }));
  }
  return extended;
}

const TENANTS = ['tenant-a', 'swift-default', 'tenant-b'] as const;

function personMatches(person: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => personMatches(person, c));
    if (key === 'roles' && 'hasSome' in cond) return (cond['hasSome'] as string[]).some((r) => person['roles'].includes(r));
    if (key === 'roles' && 'has' in cond) return person['roles'].includes(cond['has']);
    if (cond && typeof cond === 'object') throw new Error(`unmodelled user filter on ${key}`);
    return person[key] === cond;
  });
}

class OperatorPathDb extends FakeOutboxDb {
  people: Row[] = [
    { id: 'customer-1', tenantId: 'tenant-a', status: 'ACTIVE', roles: ['CUSTOMER'] },
    { id: 'owner-user', tenantId: 'tenant-a', status: 'ACTIVE', roles: ['VENDOR_OWNER'] },
    { id: 'ops-a', tenantId: 'tenant-a', status: 'ACTIVE', roles: ['ADMIN'] },
    { id: 'ops-root', tenantId: 'swift-default', status: 'ACTIVE', roles: ['SUPER_ADMIN'] },
    { id: 'ops-b', tenantId: 'tenant-b', status: 'ACTIVE', roles: ['ADMIN'] },
  ];
  /** Recipients whose inbox writes keep failing; `failOnce` fails just the next one. */
  inboxDown = new Set<string>(['customer-1']);
  notices: Row[] = [];
  alerts = new Map<string, Row>();
  fanouts: string[] = [];
  private ids = 0;
  private health?: Promise<(request: unknown) => Promise<unknown>>;

  override get prisma(): Row {
    const base = super.prisma;
    return {
      ...base,
      order: {
        ...base['order'],
        // The admin child scope resolves "this tenant's orders" through here.
        findMany: async ({ where }: { where: Row }) => {
          const unmodelled = Object.keys(where).filter((k) => k !== 'tenantId');
          if (unmodelled.length > 0) throw new Error(`unmodelled order filter on ${unmodelled.join(', ')}`);
          return where['tenantId'] === this.order['tenantId'] ? [{ id: this.order['id'] }] : [];
        },
      },
      user: {
        findMany: async ({ where }: { where: Row }) => this.people.filter((p) => personMatches(p, where)).map((p) => ({ id: p['id'] })),
        findUnique: async ({ where }: { where: Row }) => (this.people.some((p) => p['id'] === where['id']) ? { notificationPrefs: null } : null),
      },
      notification: {
        create: async ({ data }: { data: Row }) => {
          if (this.inboxDown.has(data['userId']) || this.failOnce.delete(data['userId'])) throw new Error('synthetic inbox unavailable');
          if (data['dedupeKey'] != null && this.notices.some((n) => n['userId'] === data['userId'] && n['dedupeKey'] === data['dedupeKey'])) {
            throw Object.assign(new Error('Unique constraint failed on the fields: (`userId`,`dedupeKey`)'), { code: 'P2002' });
          }
          const row = { ...data, id: `notice-${++this.ids}`, isRead: false, createdAt: new Date() };
          this.notices.push(row);
          return row;
        },
        findUnique: async ({ where }: { where: Row }) => {
          const key = where['userId_dedupeKey'] as Row | undefined;
          const hit = key
            ? this.notices.find((n) => n['userId'] === key['userId'] && n['dedupeKey'] === key['dedupeKey'])
            : this.notices.find((n) => n['id'] === where['id']);
          return hit ? { ...hit } : null;
        },
      },
      deviceToken: {
        findMany: async ({ where }: { where: Row }) => [{ token: `device:${where['userId']}` }],
      },
      alertDelivery: {
        // One INSERT statement: a key conflict aborts all of it, unless it is ON CONFLICT DO NOTHING.
        createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
          const rows = data.map((d) => ({ sentAt: new Date(), seenAt: null, acknowledgedAt: null, ...d, id: d['id'] ?? `alert-${++this.ids}` }));
          const taken = new Set(this.alerts.keys());
          let conflict = false;
          for (const r of rows) {
            if (taken.has(r.id)) conflict = true;
            taken.add(r.id);
          }
          if (conflict && !skipDuplicates) throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' });
          let count = 0;
          for (const r of rows) {
            if (!this.alerts.has(r.id)) { this.alerts.set(r.id, r); count += 1; }
          }
          return { count };
        },
        findMany: async ({ where }: { where: Row }) => [...this.alerts.values()].filter((a) => alertMatches(a, where)).map((a) => ({ ...a })),
      },
    };
  }

  override get deps(): Row {
    const prisma = this.prisma;
    const io = { to: (room: string) => ({ emit: () => { this.fanouts.push(`socket:${room.replace(/^user:/, '')}`); } }) };
    const push = {
      sendPush: async (tokens: string[]) => {
        this.fanouts.push(...tokens.map((t) => `push:${t.replace(/^device:/, '')}`));
        return { invalidTokens: [] };
      },
    };
    // No `pageAdmins`: the drain pages operators through its default, `notifyAdmins`.
    return { prisma, now: () => this.now, notifications: new NotificationService(prisma as never, io as never, { push } as never) };
  }

  /** `GET /alerts/health` as `adminRoutes` registers it, reading through the
   *  routes' own tenant child scope: `$extends` applies the query hooks the
   *  routes declare, so `alertDelivery` is narrowed exactly as in production. */
  private alertsHealth(): Promise<(request: unknown) => Promise<unknown>> {
    this.health ??= (async () => {
      const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
      const prisma: Row = { ...this.prisma };
      prisma['$extends'] = (extension: { query?: Record<string, Row> }) => extendWithQueryHooks(prisma, extension);
      const app: Row = { prisma, io: {}, log: SILENT, prefix: '', addHook: () => undefined };
      for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
        app[verb] = (path: string, ...args: unknown[]) => { handlers.set(`${verb} ${path}`, args.at(-1) as never); };
      }
      await adminRoutes(app as never);
      return handlers.get('get /alerts/health')!;
    })();
    return this.health;
  }

  /** What `/alerts/health` reports sent for `kind`, as each tenant's admin sees it. */
  async scopedHealth(kind: string): Promise<Record<(typeof TENANTS)[number], number>> {
    const handler = await this.alertsHealth();
    const sent = {} as Record<(typeof TENANTS)[number], number>;
    for (const tenant of TENANTS) {
      const health = (await runWithTenant(tenant, () => handler({ query: {} }))) as { data: { kinds: Row[] } };
      sent[tenant] = health.data.kinds.find((k) => k['kind'] === kind)?.['sent'] ?? 0;
    }
    return sent;
  }

  /** What every operator holds, and what the scoped health read reports for ops pages. */
  async operatorRecord(): Promise<Row> {
    const operators = new Set(this.people.filter((p) => p['roles'].some((r: string) => r === 'ADMIN' || r === 'SUPER_ADMIN')).map((p) => p['id']));
    return {
      inbox: this.notices.map((n) => n['userId']).filter((id) => operators.has(id)).sort(),
      fanout: this.fanouts.filter((f) => operators.has(f.slice(f.indexOf(':') + 1))).sort(),
      tracking: [...this.alerts.values()].filter((a) => a['kind'] === 'ADMIN_OPS').map((a) => a['recipientId']).sort(),
      scopedHealthSent: await this.scopedHealth('ADMIN_OPS'),
    };
  }
}

describe('a retried operator page is one delivery with one tracking row [R3 · F-R2-ASTRA-01]', () => {
  /** [R4 · F-PR1262-SOL-04] The tenant-scoped health read counts no ops page
   *  (its subject is the page kind, not one of the tenant's orders) — before a
   *  retry and after it. The positive control at the end shows it does count. */
  const UNCOUNTED = { 'tenant-a': 0, 'swift-default': 0, 'tenant-b': 0 };
  const ONCE = {
    inbox: ['ops-a', 'ops-root'],
    fanout: ['push:ops-a', 'push:ops-root', 'socket:ops-a', 'socket:ops-root'],
    tracking: ['ops-a', 'ops-root'],
    scopedHealthSent: UNCOUNTED,
  };

  it.each([
    { who: 'the customer', down: ['customer-1'], sent: 'business,admin' },
    { who: 'the store', down: ['owner-user'], sent: 'customer,admin' },
    { who: 'the customer and the store', down: ['customer-1', 'owner-user'], sent: 'admin' },
  ])('$who unreachable through two retries: each operator keeps one notice, one fan-out and one tracking row, the scoped health read is unmoved, and the obligation completes once they can be reached', async ({ down, sent }) => {
    const db = new OperatorPathDb([obligation()]);
    db.inboxDown = new Set(down);
    const row = db.rows[0]!;
    for (const [attempt, now] of [[1, at(1_000)], [2, at(HOUR)], [3, at(2 * HOUR)]] as const) {
      db.now = now;
      await sweep(db);
      expect(row['attempts'], `attempt ${attempt} ran`).toBe(attempt);
      expect(row['processedAt'], 'a recipient is still owed').toBeNull();
      expect(row['lastError'], 'deduped operators still count as reached').toBe(`incomplete: sent ${sent}; operators reached 2`);
      expect(await db.operatorRecord(), `after attempt ${attempt}`).toEqual(ONCE);
    }

    db.inboxDown.clear();
    db.now = at(3 * HOUR);
    await sweep(db);
    expect(row['processedAt'], 'every recipient holds it now').not.toBeNull();
    expect(await db.operatorRecord(), 'completion adds nothing for the operators').toEqual(ONCE);
    expect(db.notices.map((n) => n['userId']).sort(), 'one notice per recipient; the other tenant\'s admin none').toEqual(['customer-1', 'ops-a', 'ops-root', 'owner-user']);
  });

  it('an operator added between retries gets the notice and one tracking row; the operators already paged get neither again', async () => {
    const db = new OperatorPathDb([obligation()]);
    db.now = at(1_000);
    await sweep(db);
    db.people.push({ id: 'ops-new', tenantId: 'tenant-a', status: 'ACTIVE', roles: ['ADMIN'] });
    db.now = at(HOUR);
    await sweep(db);
    expect(db.rows[0]!['processedAt'], 'the customer is still owed').toBeNull();
    expect(await db.operatorRecord()).toEqual({
      inbox: ['ops-a', 'ops-new', 'ops-root'],
      fanout: ['push:ops-a', 'push:ops-new', 'push:ops-root', 'socket:ops-a', 'socket:ops-new', 'socket:ops-root'],
      tracking: ['ops-a', 'ops-new', 'ops-root'],
      scopedHealthSent: UNCOUNTED,
    });
  });

  it('an operator whose inbox write failed is reached on the retry: still one notice, one fan-out and one tracking row each', async () => {
    const db = new OperatorPathDb([obligation()]);
    db.failOnce.add('ops-a');
    db.now = at(1_000);
    await sweep(db);
    expect(db.rows[0]!['lastError'], 'one operator reached').toBe('incomplete: sent business,admin; operators reached 1');
    db.now = at(HOUR);
    await sweep(db);
    expect(db.rows[0]!['lastError'], 'both hold it now').toBe('incomplete: sent business,admin; operators reached 2');
    expect(await db.operatorRecord()).toEqual(ONCE);
  });

  it('the request fast path and a sweep delivering one obligation at once: one notice, one fan-out and one tracking row per operator', async () => {
    const db = new OperatorPathDb([obligation()]);
    db.inboxDown.clear();
    const row = db.rows[0]!;
    await Promise.all([
      claim.completeMmgClaimNotice(db.deps as never, { outboxId: row['id'], notice: OPENED }),
      claim.drainMmgClaimNotices(db.deps as never, { limit: 5 }),
    ]);
    expect(row['attempts'], 'the sweep leased it while the fast path ran').toBe(1);
    expect(row['processedAt']).not.toBeNull();
    expect(await db.operatorRecord()).toEqual(ONCE);
  });

  it('a dispute reopened at a later revision is a new page: each generation keeps one notice and one tracking row per operator', async () => {
    const db = new OperatorPathDb([obligation()]);
    db.inboxDown.clear();
    await sweep(db);
    expect(db.rows[0]!['processedAt'], 'r2 delivered').not.toBeNull();
    // Upheld at r3, paid at r4, denied again at r5 — and the customer is unreachable this time.
    Object.assign(db.order, { mmgClaimRevision: 5, mmgClaimMismatchAt: at(HOUR) });
    db.rows.push({ ...obligation({ ...OPENED, revision: 5 }), availableAt: at(HOUR), createdAt: at(HOUR) });
    db.inboxDown.add('customer-1');
    for (const now of [at(HOUR), at(2 * HOUR)]) {
      db.now = now;
      await sweep(db);
    }
    expect(db.rows[1]!['attempts'], 'r5 was retried').toBe(2);
    expect(db.rows[1]!['processedAt'], 'the customer is still owed r5').toBeNull();
    expect(await db.operatorRecord()).toEqual({
      inbox: ['ops-a', 'ops-a', 'ops-root', 'ops-root'],
      fanout: ['push:ops-a', 'push:ops-a', 'push:ops-root', 'push:ops-root', 'socket:ops-a', 'socket:ops-a', 'socket:ops-root', 'socket:ops-root'],
      tracking: ['ops-a', 'ops-a', 'ops-root', 'ops-root'],
      scopedHealthSent: UNCOUNTED,
    });
  });

  it('a page without a dedupe key is unchanged: each call is a new notice with its own tracking row', async () => {
    const db = new OperatorPathDb([]);
    const { prisma, notifications } = db.deps;
    for (let i = 0; i < 2; i += 1) {
      await notifyAdmins(prisma as never, notifications as never, { tenantId: 'tenant-a', title: 'Ops condition', body: 'Still happening', data: { kind: 'ops_test_condition' } });
    }
    expect(await db.operatorRecord()).toEqual({
      inbox: ['ops-a', 'ops-a', 'ops-root', 'ops-root'],
      fanout: ['push:ops-a', 'push:ops-a', 'push:ops-root', 'push:ops-root', 'socket:ops-a', 'socket:ops-a', 'socket:ops-root', 'socket:ops-root'],
      tracking: ['ops-a', 'ops-a', 'ops-root', 'ops-root'],
      scopedHealthSent: UNCOUNTED,
    });
  });

  it('[R4 · F-PR1262-SOL-04] the health read is the tenant-scoped production one: it counts a tenant’s own order alert, never another tenant’s, and no ops page', async () => {
    const db = new OperatorPathDb([obligation()]);
    db.now = at(1_000);
    await sweep(db);
    // A store alert about tenant A's own order, sent to tenant A's own store
    // owner: exactly what the scope exists to count — for tenant A only.
    db.alerts.set('vendor-alert-1', {
      id: 'vendor-alert-1', kind: 'VENDOR_ORDER', subjectId: 'order-1', recipientId: 'owner-user',
      sentAt: new Date(), seenAt: null, acknowledgedAt: null,
    });
    expect(await db.scopedHealth('VENDOR_ORDER')).toEqual({ 'tenant-a': 1, 'swift-default': 0, 'tenant-b': 0 });
    // The ops page's rows are real — one per operator — and the scoped read
    // counts none of them: their subject is the page kind, not an order.
    expect((await db.operatorRecord())['tracking']).toEqual(['ops-a', 'ops-root']);
    expect(await db.scopedHealth('ADMIN_OPS')).toEqual(UNCOUNTED);
  });
});
