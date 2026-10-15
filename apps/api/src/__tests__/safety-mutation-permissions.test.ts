import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { EvidenceService } from '../modules/safety/evidence.service';
import { TripShareService } from '../modules/safety/trip-share.service';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] Cleanup disables the evidence triggers on the TEST database (a sealed bundle cannot otherwise be deleted).
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [AUD-G7-004 · row 203] Every safety MUTATION route, over HTTP, by the
// route's real policy: the person a record belongs to (or ops of its tenant)
// may act on it; another person, and anyone in another tenant, may not — and
// a refused call changes nothing.
//
// The permission matrix (authz-matrix.test.ts) already proves every safety
// route refuses a caller with no token, and the ops-only ones refuse a
// customer, a store owner and a mover. What it cannot see is ownership and
// tenancy: a customer acting on SOMEONE ELSE's alert, contact or trip share,
// or a tenant ADMIN acting on ANOTHER tenant's alert, case or evidence. Each
// row below builds one fresh record in tenant A and fires the route as each
// outsider (refused: 403 or 404, record unchanged), then as the rightful
// actor on the very same record (it passes the gate) — so a refusal is about
// the caller, never a broken fixture. Routes that take no record id act only
// on the caller (they are listed with that reason), and the two that accept a
// context id prove a stranger's id attaches nothing. The table must name
// every live safety mutation route, so a new one cannot ship unclassified.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_A = 'swift-default';
const TENANT_B = `perm-b-${RUN}`;
const SUITE_START = new Date();
const userIds: string[] = []; const orderIds: string[] = []; const alertIds: string[] = []; const opsAlertIds: string[] = []; const bundleIds: string[] = [];
const phoneBase = 592_771_000_000 + Math.floor(Math.random() * 100_000_000);
let seq = 0;
const liveRoutes: string[] = [];

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:safety-permissions');

type Actor = { userId: string; token: string };
type ActorName = 'owner' | 'stranger' | 'outsiderB' | 'adminA' | 'adminB' | 'superAdmin';
const actors = {} as Record<ActorName, Actor>;

async function makeUser(roles: UserRole[], tenantId?: string): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Perm', lastName: `P${RUN}${seq}`, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true,
      ...(tenantId ? { tenantId } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'perm', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 86_400_000) } }));
  return { userId: user.id, token };
}

const LIVE_DONE = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
async function makeOrder(customerId: string, status = 'COMPLETED') {
  // One live taxi trip per passenger at a time: an earlier row's live fixture trip is ended first.
  if (!LIVE_DONE.includes(status)) await sys(() => app.prisma.order.updateMany({ where: { id: { in: orderIds }, customerId, status: { notIn: LIVE_DONE as never } }, data: { status: 'CANCELLED' } }));
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `PERM-${nanoid(8)}`, orderType: 'TAXI', customerId, status: status as never, fulfillment: 'DELIVERY', tenantId: TENANT_A,
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
    },
  }));
  orderIds.push(order.id);
  return order;
}

async function makeAlert(status: 'TRIGGER_PENDING' | 'ACTIVE') {
  const alert = await sys(() => app.prisma.sosAlert.create({ data: {
    actorUserId: actors.owner.userId, actorRole: 'CUSTOMER', status, triggerSource: 'BUTTON', triggeredAt: new Date(), tenantId: TENANT_A,
    ...(status === 'TRIGGER_PENDING' ? { graceEndsAt: new Date(Date.now() + 10 * 60_000) } : {}),
  } }));
  alertIds.push(alert.id);
  return alert;
}

async function makeCase(status: 'OPEN' | 'TRIAGED' | 'DECIDED' = 'OPEN') {
  return sys(() => app.prisma.incidentCase.create({ data: {
    tenantId: TENANT_A, status, caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S2', category: 'SAFETY_THREAT', intake: 'OPS_CREATED',
    subjectUserId: actors.owner.userId, summary: 'permission fixture', slaAckBy: new Date(Date.now() + 3_600_000), slaDecideBy: new Date(Date.now() + 86_400_000),
  } }));
}

async function makeBundle() {
  const alert = await makeAlert('ACTIVE');
  const bundle = await sys(() => new EvidenceService(app.prisma, app.io).openForSos(alert.id));
  bundleIds.push(bundle!.id);
  return bundle!;
}

async function makeShare() {
  const order = await makeOrder(actors.owner.userId, 'ACCEPTED');
  const share = await sys(() => new TripShareService(app.prisma, app.redis, { sms: { sendSms: async () => ({ ref: 'x' }) } } as never).mint(actors.owner.userId, order.id));
  return { order, token: (share as { token: string }).token };
}

const fire = (method: string, url: string, actor: Actor, payload?: unknown) =>
  app.inject({ method: method as 'POST', url, headers: { authorization: `Bearer ${actor.token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const read = <T>(fn: () => Promise<T>) => sys(fn);
/** A row as plain JSON, without its updatedAt (a refused call must not even touch it, but the clock is not the claim). */
const strip = (row: Record<string, unknown> | null) => (row ? JSON.parse(JSON.stringify({ ...row, updatedAt: undefined })) : null);

/** One fresh record in tenant A: the URL to fire, the body, and what "unchanged" means. */
type Arranged = { url: string; payload?: unknown; state: () => Promise<unknown> };
interface RouteRow {
  route: string;
  policy: 'OWNER' | 'OPS';
  arrange: () => Promise<Arranged>;
  /** The outsiders: each is refused (403/404) and the record is unchanged. */
  refused: ActorName[];
  /** The rightful actor on the SAME record, and the status they get (2xx unless a business rule answers). */
  allowed: { actor: ActorName; status?: number };
}

const S = '/api/v1/safety';
const sosState = (id: string) => () => read(async () => strip(await app.prisma.sosAlert.findUnique({ where: { id } }) as never));
const caseState = (id: string) => () => read(async () => strip(await app.prisma.incidentCase.findUnique({ where: { id } }) as never));
const bundleState = (id: string) => () => read(async () => ({
  bundle: strip(await app.prisma.evidenceBundle.findUnique({ where: { id } }) as never),
  accessLog: await app.prisma.safetyAccessLog.count({ where: { bundleId: id } }),
}));
const caseRow = (path: string, from: 'OPEN' | 'TRIAGED' | 'DECIDED' = 'OPEN', payload?: unknown, status?: number): RouteRow => ({
  route: `POST ${S}/incidents/:id/${path}`, policy: 'OPS', refused: ['adminB', 'owner'], allowed: { actor: 'adminA', ...(status ? { status } : {}) },
  arrange: async () => { const c = await makeCase(from); return { url: `${S}/incidents/${c.id}/${path}`, payload, state: caseState(c.id) }; },
});
const evidenceRow = (path: string, status?: number): RouteRow => ({
  route: `POST ${S}/evidence/:id/${path}`, policy: 'OPS', refused: ['adminB', 'owner'], allowed: { actor: 'adminA', ...(status ? { status } : {}) },
  arrange: async () => { const b = await makeBundle(); return { url: `${S}/evidence/${b.id}/${path}`, payload: { reason: 'permission matrix check' }, state: bundleState(b.id) }; },
});

const ID_ROUTES: RouteRow[] = [
  // ── the person who raised the SOS ──
  { route: `POST ${S}/sos/:id/confirm`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const a = await makeAlert('TRIGGER_PENDING'); return { url: `${S}/sos/${a.id}/confirm`, payload: {}, state: sosState(a.id) }; } },
  { route: `POST ${S}/sos/:id/cancel`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const a = await makeAlert('TRIGGER_PENDING'); return { url: `${S}/sos/${a.id}/cancel`, payload: {}, state: sosState(a.id) }; } },
  { route: `POST ${S}/sos/:id/mark-safe`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const a = await makeAlert('ACTIVE'); return { url: `${S}/sos/${a.id}/mark-safe`, payload: {}, state: sosState(a.id) }; } },
  // ── ops of the alert's tenant ──
  { route: `POST ${S}/sos/:id/ack`, policy: 'OPS', refused: ['adminB', 'owner'], allowed: { actor: 'adminA' },
    arrange: async () => { const a = await makeAlert('ACTIVE'); return { url: `${S}/sos/${a.id}/ack`, payload: {}, state: sosState(a.id) }; } },
  { route: `POST ${S}/sos/:id/resolve`, policy: 'OPS', refused: ['adminB', 'owner'], allowed: { actor: 'adminA' },
    arrange: async () => { const a = await makeAlert('ACTIVE'); return { url: `${S}/sos/${a.id}/resolve`, payload: { resolutionCode: 'SAFE_CONFIRMED' }, state: sosState(a.id) }; } },
  { route: `POST ${S}/ops-alerts/:id/ack`, policy: 'OPS', refused: ['adminB', 'owner'], allowed: { actor: 'adminA' },
    arrange: async () => {
      const o = await sys(() => app.prisma.opsAlert.create({ data: { tenantId: TENANT_A, kind: 'SOS', title: `Permission page ${RUN}`, body: 'b', ackDeadlineAt: new Date(Date.now() + 120_000), recipients: { create: [{ tenantId: TENANT_A, userId: actors.adminA.userId }] } } }));
      opsAlertIds.push(o.id);
      return { url: `${S}/ops-alerts/${o.id}/ack`, payload: {}, state: () => read(async () => ({ alert: strip(await app.prisma.opsAlert.findUnique({ where: { id: o.id } }) as never), receipts: await app.prisma.opsAlertRecipient.findMany({ where: { opsAlertId: o.id }, select: { userId: true, ackedAt: true }, orderBy: { userId: 'asc' } }) })) };
    } },
  // ── the person whose emergency contact it is ──
  { route: `POST ${S}/emergency-contacts/:id/verify`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner', status: 400 /* gate passed: the code is wrong */ },
    arrange: async () => { const c = await makeContact(); return { url: `${S}/emergency-contacts/${c.id}/verify`, payload: { code: '000000' }, state: contactState(c.id) }; } },
  { route: `POST ${S}/emergency-contacts/:id/resend`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const c = await makeContact(); return { url: `${S}/emergency-contacts/${c.id}/resend`, payload: {}, state: contactState(c.id) }; } },
  { route: `DELETE ${S}/emergency-contacts/:id`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const c = await makeContact(); return { url: `${S}/emergency-contacts/${c.id}`, state: contactState(c.id) }; } },
  // ── the passenger of the trip ──
  { route: `POST ${S}/trips/:id/share`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const o = await makeOrder(actors.owner.userId, 'ACCEPTED'); return { url: `${S}/trips/${o.id}/share`, payload: {}, state: sharesState(o.id) }; } },
  { route: `DELETE ${S}/trips/:id/shares`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const { order } = await makeShare(); return { url: `${S}/trips/${order.id}/shares`, state: sharesState(order.id) }; } },
  { route: `DELETE ${S}/share/:token`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' },
    arrange: async () => { const { order, token } = await makeShare(); return { url: `${S}/share/${token}`, state: sharesState(order.id) }; } },
  { route: `POST ${S}/rides/:id/not-my-driver`, policy: 'OWNER', refused: ['stranger', 'outsiderB'], allowed: { actor: 'owner' /* no driver yet: an honest no-op */ },
    arrange: async () => { const o = await makeOrder(actors.owner.userId, 'PENDING'); return { url: `${S}/rides/${o.id}/not-my-driver`, payload: {}, state: () => read(async () => strip(await app.prisma.order.findUnique({ where: { id: o.id } }) as never)) }; } },
  // ── ops of the case's tenant ──
  { route: `POST ${S}/incidents/:id/merge`, policy: 'OPS', refused: ['adminB', 'owner'], allowed: { actor: 'adminA' },
    arrange: async () => { const dup = await makeCase(); const into = await makeCase(); return { url: `${S}/incidents/${dup.id}/merge`, payload: { intoCaseId: into.id }, state: caseState(dup.id) }; } },
  caseRow('ack'),
  caseRow('investigate', 'TRIAGED'),
  caseRow('close', 'DECIDED'),
  caseRow('escalate-police'),
  caseRow('lift-interim'),
  caseRow('shadow-restrict'),
  caseRow('decide', 'TRIAGED', { decisionCode: 'DISMISSED' }),
  // ── ops of the bundle's tenant ──
  evidenceRow('view'),
  evidenceRow('seal'),
  evidenceRow('legal-hold'),
  evidenceRow('export'),
];

/** Routes that take NO record id: they act on the caller alone. Each names why (and where it is proved). */
const CALLER_ONLY: Record<string, string> = {
  [`POST ${S}/sos`]: 'raises the caller\'s own alert; a context id attaches only for a participant (proved below)',
  [`POST ${S}/emergency-contacts`]: 'adds a contact to the caller\'s own list (emergency-contacts.test.ts)',
  [`POST ${S}/guardian/checkin`]: 'the session is resolved from the caller alone (safety-guardian-ladder.test.ts)',
  [`POST ${S}/guardian/driver-confirm`]: 'the caller\'s own hard-check cycle and its one-time nonce (safety-guardian-cycle-bound.test.ts)',
  [`POST ${S}/liveness-check`]: 'the caller\'s own selfie for their own shift (safety-liveness.test.ts)',
  [`PUT ${S}/monitoring-preference`]: 'the caller\'s own row only (proved below)',
  [`POST ${S}/incidents`]: 'the reporter must be a party to the order it names (proved below)',
  [`POST ${S}/incidents/ops`]: 'ops intake: the subject must be in the caller\'s tenant (proved below; safety-authority-tuple.test.ts)',
  [`POST ${S}/ops-alerts/drill`]: 'a platform drill: SUPER_ADMIN only (proved below)',
};

const contactIds: string[] = [];
async function makeContact() {
  const c = await sys(() => app.prisma.emergencyContact.create({ data: { userId: actors.owner.userId, name: 'Sis', phoneE164: `+5926${String(phoneBase + (seq += 1)).slice(-6)}`, priority: 1 } }));
  contactIds.push(c.id);
  return c;
}
const contactState = (id: string) => () => read(async () => strip(await app.prisma.emergencyContact.findUnique({ where: { id } }) as never));
const sharesState = (orderId: string) => () => read(async () => app.prisma.tripShareToken.findMany({ where: { orderId }, select: { id: true, revokedAt: true }, orderBy: { id: 'asc' } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  app.addHook('onRoute', (r) => {
    for (const m of ([] as string[]).concat(r.method as string | string[])) {
      if (r.url.startsWith(`${S}/`) && !['GET', 'HEAD', 'OPTIONS'].includes(m)) liveRoutes.push(`${m} ${r.url}`);
    }
  });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: S });
  await app.ready();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Safety permissions tenant B', slug: TENANT_B, isActive: true } }));
  actors.owner = await makeUser(['CUSTOMER']);
  actors.stranger = await makeUser(['CUSTOMER']);
  actors.outsiderB = await makeUser(['CUSTOMER'], TENANT_B);
  actors.adminA = await makeUser(['ADMIN']);
  actors.adminB = await makeUser(['ADMIN'], TENANT_B);
  actors.superAdmin = await makeUser(['SUPER_ADMIN']);
}, 120_000);

afterAll(async () => {
  await sys(async () => {
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceItem" DISABLE TRIGGER evidence_item_no_mutation`).catch(() => {});
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" DISABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
    await app.prisma.evidenceBundle.deleteMany({ where: { id: { in: bundleIds } } }).catch(() => {});
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceItem" ENABLE TRIGGER evidence_item_no_mutation`).catch(() => {});
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" ENABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
    await app.prisma.safetyAccessLog.deleteMany({ where: { bundleId: { in: bundleIds } } }).catch(() => {});
    await app.prisma.legalHold.deleteMany({ where: { case: { subjectUserId: { in: userIds } } } }).catch(() => {});
    await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } }).catch(() => {});
    const sosOps = await app.prisma.opsAlert.findMany({ where: { OR: [{ id: { in: opsAlertIds } }, { sosAlertId: { in: alertIds } }, { kind: 'DRILL', createdAt: { gte: SUITE_START } }] }, select: { id: true } });
    await app.prisma.opsAlertRecipient.deleteMany({ where: { opsAlertId: { in: sosOps.map((o) => o.id) } } }).catch(() => {});
    await app.prisma.opsAlert.deleteMany({ where: { id: { in: sosOps.map((o) => o.id) } } }).catch(() => {});
    await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: userIds } } }).catch(() => {});
    await app.prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, ...alertIds.map((id) => ({ data: { path: ['sosAlertId'], equals: id } }))] } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });
  await app.close();
});

describe('[row 203] the table names every live safety mutation route', () => {
  it('every live safety mutation route is classified, and every classified route is live', () => {
    const live = [...new Set(liveRoutes)].sort();
    const declared = [...ID_ROUTES.map((r) => r.route), ...Object.keys(CALLER_ONLY)].sort();
    expect(live.length).toBeGreaterThan(30);
    expect(live.filter((r) => !declared.includes(r)), 'a new safety mutation route must be added to this table').toEqual([]);
    expect(declared.filter((r) => !live.includes(r)), 'a declared route no longer exists').toEqual([]);
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe('[row 203] a record-bearing safety route refuses everyone but its rightful actor, and a refusal changes nothing', () => {
  for (const row of ID_ROUTES) {
    it(`${row.route} (${row.policy}): ${row.refused.join(', ')} refused; ${row.allowed.actor} passes`, async () => {
      const [method] = row.route.split(' ') as [string];
      const { url, payload, state } = await row.arrange();
      const before = await state();
      for (const who of row.refused) {
        const res = await fire(method, url, actors[who], payload);
        expect([403, 404], `${who} on ${row.route} -> ${res.statusCode} ${res.body.slice(0, 200)}`).toContain(res.statusCode);
        expect(await state(), `${who}'s refused call changed the record`).toEqual(before);
      }
      const ok = await fire(method, url, actors[row.allowed.actor], payload);
      if (row.allowed.status) expect(ok.statusCode, ok.body.slice(0, 300)).toBe(row.allowed.status);
      else expect(ok.statusCode, ok.body.slice(0, 300)).toBeLessThan(300);
    });
  }
});

describe('[row 203] routes with no record id act on the caller alone', () => {
  it('POST /sos: a stranger or another tenant naming someone else\'s trip raises their own alert with nothing attached', async () => {
    const order = await makeOrder(actors.owner.userId, 'ACCEPTED');
    for (const who of ['stranger', 'outsiderB'] as const) {
      const res = await fire('POST', `${S}/sos`, actors[who], { orderId: order.id });
      expect(res.statusCode).toBe(200);
      const alert = await read(() => app.prisma.sosAlert.findUniqueOrThrow({ where: { id: res.json().data.id } }));
      alertIds.push(alert.id);
      expect(alert.actorUserId).toBe(actors[who].userId);
      expect(alert.orderId, `${who} must not attach the owner's trip`).toBeNull();
      expect(alert.counterpartyUserId, `${who} must not learn or bind the owner`).toBeNull();
    }
    const own = await fire('POST', `${S}/sos`, actors.owner, { orderId: order.id });
    const mine = await read(() => app.prisma.sosAlert.findUniqueOrThrow({ where: { id: own.json().data.id } }));
    alertIds.push(mine.id);
    expect(mine.orderId).toBe(order.id);
  });

  it('PUT /monitoring-preference changes the caller\'s row only', async () => {
    await sys(() => app.prisma.user.update({ where: { id: actors.owner.userId }, data: { enhancedSafetyMonitoring: false } }));
    const res = await fire('PUT', `${S}/monitoring-preference`, actors.stranger, { enabled: true });
    expect(res.statusCode).toBe(200);
    expect((await read(() => app.prisma.user.findUniqueOrThrow({ where: { id: actors.owner.userId } }))).enhancedSafetyMonitoring).toBe(false);
    expect((await read(() => app.prisma.user.findUniqueOrThrow({ where: { id: actors.stranger.userId } }))).enhancedSafetyMonitoring).toBe(true);
  });

  it('POST /incidents: only a party to the order may report on it; a stranger or another tenant gets 404 and no case', async () => {
    const order = await makeOrder(actors.owner.userId, 'COMPLETED');
    const body = { orderId: order.id, category: 'SAFETY_THREAT', summary: 'Permission matrix report.' };
    for (const who of ['stranger', 'outsiderB'] as const) {
      const res = await fire('POST', `${S}/incidents`, actors[who], body);
      expect(res.statusCode, `${who} -> ${res.body.slice(0, 200)}`).toBe(404);
    }
    expect(await read(() => app.prisma.incidentCase.count({ where: { orderId: order.id } }))).toBe(0);
    // The passenger passes the gate (the trip has no other party to report yet).
    const own = await fire('POST', `${S}/incidents`, actors.owner, body);
    expect(own.statusCode, own.body.slice(0, 200)).toBe(409);
    expect(own.json().error.code).toBe('NO_COUNTERPARTY');
  });

  it('POST /incidents/ops: another tenant\'s ADMIN cannot log a case on this tenant\'s person; this tenant\'s ADMIN can', async () => {
    const body = { subjectUserId: actors.owner.userId, category: 'HARASSMENT', severity: 'S3', summary: 'Logged by phone after the trip.' };
    const res = await fire('POST', `${S}/incidents/ops`, actors.adminB, body);
    expect(res.statusCode).toBe(404);
    expect(await read(() => app.prisma.incidentCase.count({ where: { subjectUserId: actors.owner.userId, intake: 'OPS_CREATED', summary: body.summary } }))).toBe(0);
    const own = await fire('POST', `${S}/incidents/ops`, actors.adminA, body);
    expect(own.statusCode, own.body.slice(0, 200)).toBe(200);
  });

  it('POST /ops-alerts/drill: a tenant ADMIN is refused and opens nothing; a SUPER_ADMIN opens the drill', async () => {
    const drills = () => read(() => app.prisma.opsAlert.count({ where: { kind: 'DRILL', createdAt: { gte: SUITE_START } } }));
    const before = await drills();
    expect((await fire('POST', `${S}/ops-alerts/drill`, actors.adminA, {})).statusCode).toBe(403);
    expect(await drills()).toBe(before);
    expect((await fire('POST', `${S}/ops-alerts/drill`, actors.superAdmin, {})).statusCode).toBe(200);
    expect(await drills()).toBe(before + 1);
  });
});
