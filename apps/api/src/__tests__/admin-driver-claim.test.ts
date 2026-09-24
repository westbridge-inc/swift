import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { APPROVAL_HEADER } from '../modules/admin/admin-approval';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { cleanupSecondApprovers, injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [DS110 #19 · G3-F1] TAXI GUARANTEE CLAIMS WERE INVISIBLE TO ADMINS.
//
// A driver claim stores `driverId` with `riderId NULL` (the database XOR
// allows exactly one mover leg). The admin child scope required
// `riderId IN (local riders)` — `NULL IN (...)` is never true — so every taxi
// guarantee claim vanished from the queue and approve/reject/paid answered
// NotFound, however many people had approved it. The scope now resolves the
// mover through EITHER local profile.
//
// This suite proves the claim is visible to its own tenant's admins, hidden
// from — and unchangeable by — a foreign tenant's admin, and approved and paid
// exactly once through the real two-person flow. Fixture range: +59242nnnnn
// (this file only).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_B = `driver-claim-b-${RUN}`;
const userIds: string[] = [];
const foreignUserIds: string[] = [];
const orderIds: string[] = [];
const driverIds: string[] = [];
const claimIds: string[] = [];
const RESERVE_NOTE = `driver-claim-fixture-${RUN}`;
const REASON = 'Guarantee payout approved after two-person review of the taxi evidence';
const DOOR = { lat: 6.8013, lng: -58.1553 };

type Actor = { token: string; userId: string };

const phone = () => `+59242${String(Math.floor(Math.random() * 90000) + 10000)}`;

async function makeUser(roles: string[], activeRole: string) {
  const user = await app.prisma.user.create({
    data: {
      phone: phone(), firstName: 'Taxi', lastName: `U${RUN}${userIds.length}`,
      roles: roles as never, activeRole: activeRole as never, status: 'ACTIVE', isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function mintSession(userId: string, role: 'ADMIN' | 'SUPER_ADMIN', label: string): Promise<Actor> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: label, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId };
}

async function makeAdmin(role: 'ADMIN' | 'SUPER_ADMIN'): Promise<Actor> {
  const user = await app.prisma.user.create({
    data: {
      phone: phone(), firstName: 'Taxi', lastName: `${role.slice(0, 3)}${RUN}${userIds.length}`,
      roles: [role, 'CUSTOMER'], activeRole: role, status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  return mintSession(user.id, role, 'admin-driver-claim');
}

/** An admin of ANOTHER tenant: the wrong party for this claim. */
async function makeForeignAdmin(): Promise<Actor> {
  return runWithoutTenant(async () => {
    await app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Driver Claim Tenant B', slug: TENANT_B, isActive: true } });
    const user = await app.prisma.user.create({
      data: {
        phone: phone(), firstName: 'Foreign', lastName: `Adm${RUN}`,
        roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true,
        tenantId: TENANT_B,
        admin: { create: { permissions: ['*'] } },
      },
    });
    foreignUserIds.push(user.id);
    return mintSession(user.id, 'ADMIN', 'admin-driver-claim-foreign');
  }, 'test-fixture:admin-driver-claim');
}

const headersFor = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON, ...extra,
});

const call = (token: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: headersFor(token, extra), ...(payload === undefined ? {} : { payload }) });

const approvalIdOf = (res: { statusCode: number; json: () => unknown }): string | null => {
  if (res.statusCode !== 202) return null;
  const body = res.json() as { error?: { code?: string; details?: { approvalId?: string } } };
  return body?.error?.code === 'APPROVAL_REQUIRED' ? (body.error.details?.approvalId ?? null) : null;
};

/** The queue is paginated oldest-first and the test database is shared, so
 *  walk the pages rather than assume the row is on the first one. */
async function inQueue(token: string, status: string, claimId: string): Promise<boolean> {
  for (let page = 1; page <= 40; page += 1) {
    const res = await call(token, 'GET', `/api/v1/admin/cash-rules/claims?status=${status}&page=${page}&limit=50`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: Array<{ id: string }>; meta: { hasNext: boolean } };
    if (body.data.some((row) => row.id === claimId)) return true;
    if (!body.meta.hasNext) return false;
  }
  return false;
}

const claimState = (claimId: string) => runWithoutTenant(() => app.prisma.reimbursementClaim.findUniqueOrThrow({
  where: { id: claimId },
  select: { status: true, reviewedBy: true, reviewedAt: true, paidAt: true, paymentRef: true, paidAmount: true, paidById: true },
}));

const effects = (claimId: string, moverUserId: string) => runWithoutTenant(async () => ({
  audit: await app.prisma.auditLog.count({ where: { entityId: claimId } }),
  notifications: await app.prisma.notification.count({ where: { userId: moverUserId } }),
  reserve: await app.prisma.rlpReserveEntry.count({ where: { claimId } }),
}));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    const everyone = [...userIds, ...foreignUserIds];
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: everyone } }, { entityId: { in: [...claimIds, ...everyone] } }] }, 'test-cleanup:admin-driver-claim').catch(() => 0);
    await app.prisma.rlpReserveEntry.deleteMany({ where: { OR: [{ claimId: { in: claimIds } }, { note: RESERVE_NOTE }] } }).catch(() => {});
    await app.prisma.reimbursementClaim.deleteMany({ where: { id: { in: claimIds } } }).catch(() => {});
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: everyone } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: everyone } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: everyone } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: everyone } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: everyone } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: everyone } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }).catch(() => {});
  }, 'test-cleanup:admin-driver-claim');
  await app.close();
});

describe('[DS110 #19 · G3-F1] a TAXI driver claim is tenant-owned: visible to its admins, hidden from strangers, payable once', () => {
  it('is in the queue, is refused to a foreign tenant unchanged, and completes approve → paid through the real two-person flow exactly once', async () => {
    const requester = await makeAdmin('ADMIN');
    const approver = await makeAdmin('SUPER_ADMIN');
    const foreign = await makeForeignAdmin();

    // The fixture: a taxi ride that ended in a no-show, claimed by the DRIVER
    // (driverId set, riderId NULL), at the drop-off point.
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const driver = await app.prisma.driver.create({
      data: {
        userId: mover.id,
        vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2024,
        vehicleColor: 'Silver', licensePlate: `TAXI-${RUN}`,
        driverLicenseUrl: 'storage://test/driver-license',
        vehicleInsuranceUrl: 'storage://test/vehicle-insurance',
      },
    });
    driverIds.push(driver.id);
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `DRV-${RUN}-${nanoid(6)}`, orderType: 'TAXI',
        customerId: customer.id, driverId: driver.id,
        status: 'FAILED',
        pickupAddress: 'Stabroek Market', pickupLat: 6.8134, pickupLng: -58.1626,
        deliveryAddress: 'Camp Street', deliveryLat: DOOR.lat, deliveryLng: DOOR.lng,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
        deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000,
        paymentMethod: 'CASH',
      },
    });
    orderIds.push(order.id);
    // Fund the named reserve line so the payout can actually be drawn.
    await app.prisma.rlpReserveEntry.create({
      data: { countryCode: 'GY', kind: 'ADJUSTMENT', amount: 2000, note: RESERVE_NOTE },
    });
    const claim = await app.prisma.reimbursementClaim.create({
      data: {
        orderId: order.id, driverId: driver.id, customerId: customer.id,
        amount: 2000, reason: 'no_show', gpsLat: DOOR.lat, gpsLng: DOOR.lng,
        status: 'PENDING_REVIEW', flags: [],
      },
    });
    claimIds.push(claim.id);
    expect(claim.riderId).toBeNull();

    // 1. Visible to an ordinary ADMIN of the claim's tenant. (riderId is NULL:
    //    the old riderId-only scope could never match this row.)
    expect(await inQueue(requester.token, 'PENDING_REVIEW', claim.id), 'the TAXI driver claim must be in the admin claims queue').toBe(true);

    // 2. The wrong party: a foreign tenant's admin neither sees it nor moves
    //    it — through the real two-person path, so the refusal is the tenancy
    //    law and not a missing signature — and the row is untouched.
    expect(await inQueue(foreign.token, 'PENDING_REVIEW', claim.id)).toBe(false);
    const stateBefore = await claimState(claim.id);
    const effectsBefore = await effects(claim.id, mover.id);
    const foreignApprove = await injectWithApproval(app, {
      method: 'PUT', url: `/api/v1/admin/cash-rules/claims/${claim.id}/approve`,
      headers: headersFor(foreign.token), payload: { reason: REASON },
    });
    expect(foreignApprove.statusCode, foreignApprove.body).toBe(404);
    expect(await claimState(claim.id)).toEqual(stateBefore);
    expect(await effects(claim.id, mover.id)).toEqual(effectsBefore);

    // 3. Approve: one person asks, the SAME person cannot decide, a different
    //    person decides, the requester re-issues carrying the approval.
    const approveAsk = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/approve`, { reason: REASON });
    expect(approveAsk.statusCode, approveAsk.body).toBe(202);
    const approveId = approvalIdOf(approveAsk);
    expect(approveId).toBeTruthy();
    expect((await claimState(claim.id)).status).toBe('PENDING_REVIEW');

    const selfDecide = await call(requester.token, 'POST', `/api/v1/admin/approvals/${approveId}/decide`, { approve: true, reason: REASON });
    expect(selfDecide.statusCode, selfDecide.body).toBe(403);
    const decided = await call(approver.token, 'POST', `/api/v1/admin/approvals/${approveId}/decide`, { approve: true, reason: REASON, note: 'Taxi guarantee evidence reviewed' });
    expect(decided.statusCode, decided.body).toBe(200);
    const approve = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/approve`, { reason: REASON }, { [APPROVAL_HEADER]: approveId! });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(await claimState(claim.id)).toMatchObject({ status: 'APPROVED', reviewedBy: requester.userId });
    expect(await inQueue(requester.token, 'APPROVED', claim.id)).toBe(true);

    // 4. Paid: the same ceremony, then durable money facts.
    const reference = `TAXI${nanoid(10).replace(/[^A-Za-z0-9]/g, '0').toUpperCase()}`;
    const payAsk = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/paid`, { reference, amount: 2000 });
    expect(payAsk.statusCode, payAsk.body).toBe(202);
    const payId = approvalIdOf(payAsk);
    expect(payId).toBeTruthy();
    const payDecided = await call(approver.token, 'POST', `/api/v1/admin/approvals/${payId}/decide`, { approve: true, reason: REASON });
    expect(payDecided.statusCode, payDecided.body).toBe(200);
    const paid = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/paid`, { reference, amount: 2000 }, { [APPROVAL_HEADER]: payId! });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().data.status).toBe('PAID');

    const after = await claimState(claim.id);
    expect({ ...after, paidAmount: Number(after.paidAmount) }).toMatchObject({
      status: 'PAID', paymentRef: reference, paidAmount: 2000, paidById: requester.userId, reviewedBy: requester.userId,
    });
    expect(after.paidAt).toBeTruthy();

    // 5. Paid exactly once: one reserve draw, and the DRIVER — not a rider —
    //    was told at each step.
    const payouts = await runWithoutTenant(() => app.prisma.rlpReserveEntry.findMany({ where: { claimId: claim.id } }));
    expect(payouts.map((e) => ({ kind: e.kind, amount: Number(e.amount) }))).toEqual([{ kind: 'PAYOUT', amount: -2000 }]);
    const told = await runWithoutTenant(() => app.prisma.notification.findMany({ where: { userId: mover.id }, select: { title: true }, orderBy: { createdAt: 'asc' } }));
    expect(told.map((n) => n.title)).toEqual(['Claim approved', 'Guarantee paid']);

    // The spent approval cannot be spent again: no second draw, no second PAID.
    const replay = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/paid`, { reference, amount: 2000 }, { [APPROVAL_HEADER]: payId! });
    expect(replay.statusCode, replay.body).toBe(403);
    expect(await effects(claim.id, mover.id)).toMatchObject({ reserve: 1 });
    expect(await claimState(claim.id)).toEqual(after);
  });
});
