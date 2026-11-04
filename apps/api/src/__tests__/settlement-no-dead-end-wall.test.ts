/**
 * Swift support's close of a delivery-pay record is the first admin write to that table. Measured through the app's own
 * client on per-suite logins in the production posture (a walled request login in swift_owner_wall, TENANT_RLS_BIND=1,
 * TENANT_UNSCOPED_ACCESS=deny, OWNER_RLS_BIND=1, system work on its own bypass login): a second admin's approval, the
 * close, the audit row and both notices all commit, and the same read deletion uses stops counting the record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { partnerObligations } from '../modules/user/partner-wind-down';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;
const REASON = 'The store has left Swift and cannot confirm this handover; the rider asked to close it.';

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma');
const users: string[] = [];

async function person(roles: string[], extra: Record<string, unknown> = {}) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Settle', lastName: 'Wall', roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await owner.session.create({ data: {
    userId: user.id, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP',
    deviceId: `settle-wall-${user.id.slice(-6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${decodeURIComponent(new URL(logins.requestUrl).username)}`);
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { adminRoutes } = await import('../modules/admin/admin.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
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
      await owner.order.deleteMany({ where: { customerId: { in: users } } });
      await owner.vendor.deleteMany({ where: { owner: { userId: { in: users } } } });
      await owner.vendorOwner.deleteMany({ where: { userId: { in: users } } });
      await owner.rider.deleteMany({ where: { userId: { in: users } } });
      await owner.privilegedApproval.deleteMany({ where: { requestedBy: { in: users } } });
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeAuditLogs(owner, { userId: { in: users } }, 'test-cleanup:settlement-no-dead-end-wall');
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } });
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

describe('Swift support on a delivery-pay record, in the production posture', () => {
  it('a second admin agrees, the record closes, both people hold their notice, and it stops counting', async () => {
    const admin = await person(['ADMIN'], { status: 'ACTIVE', admin: { create: { permissions: ['*'] } } });
    const second = await person(['ADMIN'], { status: 'ACTIVE', admin: { create: { permissions: ['*'] } } });
    const customer = await person(['CUSTOMER']);
    const riderUser = await person(['MOVER', 'CUSTOMER']);
    const ownerUser = await person(['VENDOR_OWNER', 'CUSTOMER']);
    const rider = await owner.rider.create({ data: { userId: riderUser.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } });
    const vendor = await owner.vendor.create({ data: {
      owner: { create: { userId: ownerUser.userId } }, name: 'Settle wall', slug: `settle-wall-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`, vendorType: 'STORE',
      phone: '+5926001234', addressLine1: 'Fixture', city: 'Georgetown', region: '', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
    } });
    const order = await owner.order.create({ data: {
      orderNumber: `STW-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: customer.userId, vendorId: vendor.id, riderId: rider.id, status: 'DELIVERED',
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, totalAmount: 3500,
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15,
    } });
    const row = await owner.deliveryCashSettlement.create({ data: { orderId: order.id, riderId: rider.id, vendorId: vendor.id, amount: 500 } });
    const close = (approval?: string) => app.inject({
      method: 'POST', url: `/api/v1/admin/finance/cash-settlements/${row.id}/close`, payload: {},
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON, ...(approval ? { [APPROVAL_HEADER]: approval } : {}) },
    });
    const ask = await close();
    expect(ask.statusCode, ask.body).toBe(202);
    const approval = ask.json().error.details.approvalId as string;
    const decided = await app.inject({
      method: 'POST', url: `/api/v1/admin/approvals/${approval}/decide`, payload: { approve: true },
      headers: { authorization: `Bearer ${second.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    const closed = await close(approval);
    expect(closed.statusCode, closed.body).toBe(200);

    const after = await owner.deliveryCashSettlement.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.closedById).toBe(admin.userId);
    expect(after.status).toBe('OWED');
    expect(await owner.notification.count({ where: { userId: { in: [riderUser.userId, ownerUser.userId] }, title: 'Delivery pay record closed by Swift' } })).toBe(2);
    expect((await owner.$transaction((tx) => partnerObligations(tx, riderUser.userId))).unsettledCashCount).toBe(0);
  });
});
