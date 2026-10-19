/**
 * [item 20 · owner wall] Support tickets are walled to their person
 * (migration 20261018223000_owner_wall_support_tickets), the same way as the
 * inbox: only the person reads, updates or deletes a ticket through a request
 * login (owner_isolation*), a case may be OPENED for a person (ticket_write,
 * INSERT WITH CHECK (true)), and support staff work the queue through a named
 * capability inside their tenant boundary. Measured through the app's own
 * client on a per-suite walled request login (a swift_owner_wall member),
 * OWNER_RLS_BIND=1, system work on its bypass-member login:
 *  - fail closed: unbound, a job bound to a tenant only, and another person
 *    see none of a person's tickets; the person files and lists their own;
 *  - the MMG store-silent sweep, bound to the order's tenant only, opens the
 *    customer's case once (the existence check is a narrow SECURITY DEFINER
 *    action, the write the one ticket helper), and the store's "Paid by MMG"
 *    closes it from inside the store's transaction (the second action);
 *  - the admin queue lists and resolves another person's ticket;
 *  - GOLDEN: with the wall ON the helper and the actions write and answer what
 *    the OFF path (the call each replaced) does, field by field;
 *  - a census pins every ticket accessor; the person binding is
 *    transaction-local.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { withAdminReason } from './helpers/admin-reason';
import { readOwnerWallFacts } from '../lib/owner-rls';
import { insertTicketFor, orderCaseExists, closeOrderCase } from '../lib/owner-wall-tickets';
import { MMG_STORE_SILENT_SUBJECT } from '../modules/order/mmg-accept-expiry';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { customer: '', other: '', storeOwner: '', admin: '', vendor: '', vendorOwner: '', order: '', goldOrder: '', ticket: '', goldOff: '', goldOn: '', elsewhere: '', elsewhereTicket: '' };
const OTHER_TENANT = `owt-tenant-${RUN}`;
const tokens = { customer: '', other: '', admin: '' };
const users: string[] = [];
const orders: string[] = [];

async function sessionFor(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await owner.session.create({ data: {
    // [#1865] A raw client stores what the app stores: the credential digests.
    userId, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP', deviceId: `owt-${RUN}-${userId.slice(-6)}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  return token;
}
const mkUser = async (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Ticket', lastName: `Wall${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } })).id;
  users.push(id);
  return id;
};
const mkOrder = async (customerId: string, over: Record<string, unknown> = {}) => {
  const id = (await owner.order.create({ data: {
    orderNumber: `OWT-${nanoid(10).toUpperCase()}`, customerId, vendorId: ids.vendor, tenantId: PRODUCTION,
    orderType: 'FOOD_DELIVERY', status: 'ACCEPTED', deliveryAddress: '1 Wall St', deliveryLat: 6.8055, deliveryLng: -58.1553,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'MOBILE_MONEY',
    acceptedAt: new Date(Date.now() - 45 * 60_000), customerMmgClaim: 'PAID', customerMmgClaimAt: new Date(Date.now() - 40 * 60_000), customerClaimedPaidAt: new Date(Date.now() - 40 * 60_000), ...over,
  } as never })).id;
  orders.push(id);
  return id;
};
async function withBind<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
  const prior = process.env['OWNER_RLS_BIND'];
  process.env['OWNER_RLS_BIND'] = value;
  try { return await fn(); } finally { process.env['OWNER_RLS_BIND'] = prior; }
}
type TicketRow = Awaited<ReturnType<PrismaClient['supportTicket']['findUniqueOrThrow']>>;
/** A ticket without what differs by construction (id, times, whose ticket). */
const fields = (t: TicketRow) => ({
  orderId: t.orderId, category: t.category, subject: t.subject, message: t.message, status: t.status,
  adminNote: t.adminNote, resolution: t.resolution, resolvedById: t.resolvedById, resolvedAt: t.resolvedAt,
});

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  const requestRole = decodeURIComponent(new URL(logins.requestUrl).username);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);

  ids.customer = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.other = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.storeOwner = await mkUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  ids.admin = await mkUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });
  ids.goldOff = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.goldOn = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.vendorOwner = (await owner.vendorOwner.create({ data: { userId: ids.storeOwner } })).id;
  ids.vendor = (await owner.vendor.create({ data: {
    ownerId: ids.vendorOwner, name: `Ticket Store ${RUN}`, slug: `ticket-store-${RUN}`, vendorType: 'RESTAURANT', tenantId: PRODUCTION,
    phone: testPhone(), addressLine1: '1 Wall Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } })).id;
  ids.order = await mkOrder(ids.customer);
  ids.goldOrder = await mkOrder(ids.customer, { status: 'DELIVERED' });
  ids.ticket = (await owner.supportTicket.create({ data: { userId: ids.customer, category: 'OTHER', subject: `Mine ${RUN}`, message: 'my ticket' } })).id;
  // A person in ANOTHER tenant: the admin queue's tenant boundary must hold under the capability too.
  await owner.tenant.create({ data: { id: OTHER_TENANT, name: `Other ${RUN}`, slug: OTHER_TENANT } });
  ids.elsewhere = await mkUser(['CUSTOMER'], 'CUSTOMER', { tenantId: OTHER_TENANT });
  ids.elsewhereTicket = (await owner.supportTicket.create({ data: { userId: ids.elsewhere, category: 'OTHER', subject: `Elsewhere ${RUN}`, message: 'another tenant' } })).id;

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { customerRoutes } = await import('../modules/user/customer.routes');
  const { adminRoutes } = await import('../modules/admin/admin.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  tokens.customer = await sessionFor(ids.customer, 'CUSTOMER');
  tokens.other = await sessionFor(ids.other, 'CUSTOMER');
  tokens.admin = await sessionFor(ids.admin, 'SUPER_ADMIN');
});

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    if (users.length) {
      await owner.supportTicket.deleteMany({ where: { userId: { in: users } } });
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.order.deleteMany({ where: { id: { in: orders } } }).catch(() => undefined);
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeFixtureAuditTrail(owner, users, 'owner-wall-support-tickets');
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      if (ids.vendor) await owner.vendor.deleteMany({ where: { id: ids.vendor } }).catch(() => undefined);
      if (ids.vendorOwner) await owner.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } }).catch(() => undefined);
      await owner.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
      await owner.tenant.deleteMany({ where: { id: OTHER_TENANT } }).catch(() => undefined);
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('[item 20] support tickets: the owner wall fails closed', () => {
  it('unbound, a job bound to a tenant only, and another person see none of a person\'s tickets; the person sees their own', async () => {
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      expect(await raw.supportTicket.count({ where: { userId: ids.customer } })).toBe(0);
    } finally { await raw.$disconnect(); }
    expect(await tenant.runWithTenant(PRODUCTION, () => app.prisma.supportTicket.count({ where: { userId: ids.customer } }))).toBe(0);
    expect(await asPerson(ids.other, () => app.prisma.supportTicket.findUnique({ where: { id: ids.ticket } }))).toBeNull();
    expect((await asPerson(ids.other, () => app.prisma.supportTicket.updateMany({ where: { id: ids.ticket }, data: { status: 'RESOLVED' } }))).count).toBe(0);
    expect(await asPerson(ids.customer, () => app.prisma.supportTicket.count({ where: { userId: ids.customer } }))).toBeGreaterThan(0);
    expect((await readOwnerWallFacts(app.prisma)).unwalledTables).toEqual([]);
  });

  it('the person files and lists their own tickets; another person\'s list never shows them', async () => {
    const filed = await call('POST', '/api/v1/customer/support', tokens.customer, { category: 'OTHER', subject: `Filed ${RUN}`, message: 'a question from me' });
    expect(filed.statusCode, filed.body).toBe(200);
    expect(filed.json().data).toMatchObject({ status: 'OPEN' });
    const mine = await call('GET', '/api/v1/customer/support', tokens.customer);
    expect(JSON.stringify(mine.json())).toContain(`Filed ${RUN}`);
    expect(JSON.stringify((await call('GET', '/api/v1/customer/support', tokens.other)).json())).not.toContain(`Filed ${RUN}`);
  });
});

describe('[item 20] support tickets for someone else', () => {
  it('the MMG store-silent sweep opens the customer\'s case once; the store\'s "Paid by MMG" closes it from its own transaction', async () => {
    const { escalateStoreSilentMmgClaim } = await import('../jobs/queue');
    const ctx = { prisma: app.prisma, io: app.io, log: silentLog } as unknown as Parameters<typeof escalateStoreSilentMmgClaim>[0];
    expect(await tenant.runWithTenant(PRODUCTION, () => escalateStoreSilentMmgClaim(ctx, ids.order))).toBe(true);
    expect(await tenant.runWithTenant(PRODUCTION, () => escalateStoreSilentMmgClaim(ctx, ids.order))).toBe(false);
    const cases = await owner.supportTicket.findMany({ where: { orderId: ids.order, subject: MMG_STORE_SILENT_SUBJECT } });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ userId: ids.customer, category: 'PAYMENT', status: 'OPEN' });
    const { closeStoreSilentMmgCase } = await import('../modules/order/mmg-accept-expiry');
    const closedAt = new Date();
    expect(await asPerson(ids.storeOwner, () => app.prisma.$transaction((tx) => closeStoreSilentMmgCase(tx, ids.order, 'PAID_BY_MMG', closedAt)))).toBe(1);
    expect(await owner.supportTicket.findUniqueOrThrow({ where: { id: cases[0]!.id } })).toMatchObject({
      status: 'RESOLVED', resolution: 'ACTION_TAKEN', resolvedAt: closedAt, adminNote: expect.stringContaining('Paid by MMG'),
    });
  });

  it('the admin queue lists and resolves another person\'s ticket', async () => {
    const list = await call('GET', '/api/v1/admin/support?status=OPEN', tokens.admin);
    expect(list.statusCode, list.body).toBe(200);
    const listed = (list.json().data.tickets as Array<{ id: string }>).map((t) => t.id);
    expect(listed).toContain(ids.ticket);
    // ...inside its tenant boundary: another tenant's ticket is neither listed nor resolvable from here.
    expect(listed).not.toContain(ids.elsewhereTicket);
    const elsewhereUrl = `/api/v1/admin/support/${ids.elsewhereTicket}/resolve`;
    const refused = await call('PUT', elsewhereUrl, tokens.admin, withAdminReason('PUT', elsewhereUrl, { status: 'RESOLVED', resolution: 'ANSWERED', adminNote: 'Not mine.' }) as Record<string, unknown>);
    expect(refused.statusCode, refused.body).toBe(404);
    expect((await owner.supportTicket.findUniqueOrThrow({ where: { id: ids.elsewhereTicket } })).status).toBe('OPEN');
    const url = `/api/v1/admin/support/${ids.ticket}/resolve`;
    const resolved = await call('PUT', url, tokens.admin, withAdminReason('PUT', url, { status: 'RESOLVED', resolution: 'ANSWERED', adminNote: 'Answered by the suite.' }) as Record<string, unknown>);
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(await owner.supportTicket.findUniqueOrThrow({ where: { id: ids.ticket } })).toMatchObject({ status: 'RESOLVED', resolvedById: ids.admin });
  });
});

describe('[item 20] GOLDEN: with the wall ON the ticket helper and actions match the calls they replaced', () => {
  it('opening a case for someone: the same row both ways, an id of the same cuid shape', async () => {
    const make = (userId: string) => ({ userId, orderId: ids.goldOrder, category: 'PAYMENT' as const, subject: `Gold ${RUN}`, message: 'gold case' });
    const off = await withBind('0', () => owner.$transaction((tx) => insertTicketFor(tx, make(ids.goldOff))));
    const on = await withBind('1', () => owner.$transaction((tx) => insertTicketFor(tx, make(ids.goldOn))));
    const rowOff = await owner.supportTicket.findUniqueOrThrow({ where: { id: off.id } });
    const rowOn = await owner.supportTicket.findUniqueOrThrow({ where: { id: on.id } });
    expect(fields(rowOn)).toEqual(fields(rowOff));
    expect(rowOn.userId).toBe(ids.goldOn);
    for (const r of [rowOff, rowOn]) expect(r.id).toMatch(/^c[0-9a-z]{24}$/);
    expect(on).toEqual({ ...make(ids.goldOn), id: rowOn.id });
  });

  it('the case check and the case close answer and write what the plain query did', async () => {
    const orderOff = await mkOrder(ids.goldOff, { status: 'DELIVERED' });
    const orderOn = await mkOrder(ids.goldOn, { status: 'DELIVERED' });
    for (const [orderId, userId] of [[orderOff, ids.goldOff], [orderOn, ids.goldOn]] as const) {
      await owner.supportTicket.create({ data: { userId, orderId, category: 'PAYMENT', subject: MMG_STORE_SILENT_SUBJECT, message: 'open', status: 'IN_PROGRESS' } });
      await owner.supportTicket.create({ data: { userId, orderId, category: 'PAYMENT', subject: MMG_STORE_SILENT_SUBJECT, message: 'done', status: 'RESOLVED' } });
      await owner.supportTicket.create({ data: { userId, orderId, category: 'OTHER', subject: MMG_STORE_SILENT_SUBJECT, message: 'other category' } });
    }
    expect(await orderCaseExists(owner, orderOn, MMG_STORE_SILENT_SUBJECT)).toBe(Boolean(await owner.supportTicket.findFirst({ where: { orderId: orderOn, category: 'PAYMENT', subject: MMG_STORE_SILENT_SUBJECT } })));
    expect(await orderCaseExists(owner, ids.goldOrder, MMG_STORE_SILENT_SUBJECT)).toBe(false);
    const { closeStoreSilentMmgCase } = await import('../modules/order/mmg-accept-expiry');
    const at = new Date('2026-10-19T05:00:00.789Z');
    const nOff = await withBind('0', () => owner.$transaction((tx) => closeStoreSilentMmgCase(tx, orderOff, 'CANCELLED', at)));
    const nOn = await withBind('1', () => owner.$transaction((tx) => closeStoreSilentMmgCase(tx, orderOn, 'CANCELLED', at)));
    expect(nOn).toBe(nOff);
    expect(nOn).toBe(1);
    const rows = async (orderId: string) => (await owner.supportTicket.findMany({ where: { orderId }, orderBy: { message: 'asc' } })).map((t) => ({ ...fields(t), orderId: null }));
    expect(await rows(orderOn)).toEqual(await rows(orderOff));
    expect(await closeOrderCase(owner, orderOn, MMG_STORE_SILENT_SUBJECT, 'again', at)).toBe(0); // nothing left open
  });
});

describe('[item 20] support tickets: the census', () => {
  it('every ticket accessor is the person\'s own, the admin queue\'s capability, a wall-OFF branch, or a system job', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(path); }
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(root);
    const HELPER = 'lib/owner-wall-tickets.ts';
    const sites: Record<string, number> = {};
    const helperCalls: Record<string, number> = {};
    const actionCalls: Record<string, number> = {};
    const named: string[] = [];
    const relations: Record<string, number> = {};
    const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
    for (const path of files) {
      const rel = relative(root, path);
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/\.\s*supportTicket\s*\.\s*(\w+)\s*\(/g)) if (rel !== HELPER) bump(sites, `${rel} ${m[1]}`);
      for (const m of text.matchAll(/\binsertTicketFor\s*\(/g)) if (!/function\s+$/.test(text.slice(0, m.index))) bump(helperCalls, rel);
      for (const m of text.matchAll(/\b(orderCaseExists|closeOrderCase)\s*\(/g)) if (!/function\s+$/.test(text.slice(0, m.index))) bump(actionCalls, `${rel} ${m[1]}`);
      if (rel !== HELPER && /swift_owner_wall_(order_case_exists|close_order_case)/.test(text)) named.push(rel);
      for (let n = (text.match(/\bsupportTickets\s*:/g) ?? []).length; n > 0; n -= 1) bump(relations, rel);
    }
    expect(sites).toEqual({
      // The person's own: filing, listing, the closure request (in its own transaction).
      'modules/support/support.service.ts create': 1,
      'modules/support/support.service.ts findMany': 2, // listForUser (own) + listForAdmin (the queue: capability when on)
      // The admin queue (SupportService.queue: tenantPrisma off, the capability on): count, the resolve read (off/on), update.
      'modules/support/support.service.ts count': 1,
      'modules/support/support.service.ts findUnique': 1,
      'modules/support/support.service.ts findFirst': 1,
      'modules/support/support.service.ts update': 1,
      'modules/user/account.service.ts findFirst': 1,
      'modules/user/account.service.ts create': 1,
      // The admin closure completion: tenantPrisma off, the capability on (read and close).
      'modules/admin/admin.routes.ts findFirst': 1,
      'modules/admin/admin.routes.ts findUnique': 1,
      'modules/admin/admin.routes.ts updateMany': 2,
      // Wall-OFF branches of the narrow actions.
      'jobs/queue.ts findFirst': 1,
      'modules/order/mmg-accept-expiry.ts updateMany': 1,
    });
    expect(helperCalls).toEqual({ 'jobs/queue.ts': 1 });
    expect(actionCalls).toEqual({ 'jobs/queue.ts orderCaseExists': 1, 'modules/order/mmg-accept-expiry.ts closeOrderCase': 1 });
    expect(named).toEqual([]);
    // The sweep's order filter (a system job) and closeStoreSilentMmgCase's type.
    // (and the inactive-account sweep's user filter, a system job).
    expect(relations).toEqual({ 'modules/order/mmg-accept-expiry.ts': 1, 'modules/user/inactivity.ts': 1 });
    // The admin queue's service is given the capability.
    expect(readFileSync(join(root, 'modules/admin/admin.routes.ts'), 'utf8')).toMatch(/new SupportService\(tenantPrisma, notifications, \{ capability: 'admin:support-queue', client: app\.prisma \}\)/);
  });
});

describe('[item 20 · S4-1] support tickets: the person binding is transaction-local', () => {
  it('a pooled connection that served one person shows the next unbound query none of their tickets', async () => {
    const one = prismaModule.createScopedProcessClient({ datasourceUrl: logins!.singleConnectionUrl });
    const count = (c: { supportTicket: { count(a: { where: { userId: string } }): Promise<number> } }) => c.supportTicket.count({ where: { userId: ids.customer } });
    try {
      expect(await asPerson(ids.customer, () => count(one))).toBeGreaterThan(0);
      expect(await count(one)).toBe(0);
      expect(await asPerson(ids.customer, () => one.$transaction((tx: Prisma.TransactionClient) => count(tx)))).toBeGreaterThan(0);
      expect(await count(one)).toBe(0);
      expect((await asPerson(ids.customer, () => one.$transaction([one.supportTicket.count({ where: { userId: ids.customer } })])))[0]).toBeGreaterThan(0);
      expect(await count(one)).toBe(0);
      expect(await tenant.runWithTenant(PRODUCTION, () => count(one))).toBe(0);
    } finally { await one.$disconnect(); }
  });
});
