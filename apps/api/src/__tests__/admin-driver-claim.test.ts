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

// ---------------------------------------------------------------------------
// [DS110 #19 · G3-F1] TAXI GUARANTEE CLAIMS WERE INVISIBLE TO ADMINS.
//
// A driver claim stores `driverId` with `riderId NULL` (the database XOR
// allows exactly one mover leg). The admin child scope required
// `riderId IN (local riders)` — `NULL IN (...)` is false — so every taxi
// guarantee claim vanished from the queue and every approve/reject/paid
// returned NotFound, however many people approved it. The fix scopes the
// claim through EITHER local mover leg (and batched id lists under the bind
// ceiling). This suite proves a driver claim is visible, and can be approved
// and paid exactly once through the real two-person flow.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const orderIds: string[] = [];
const driverIds: string[] = [];
const claimIds: string[] = [];
const RESERVE_NOTE = `driver-claim-fixture-${RUN}`;
const REASON = 'Guarantee payout approved after two-person review of the taxi evidence';

async function makeUser(roles: string[], activeRole: string) {
  const user = await app.prisma.user.create({
    data: {
      phone: `+59242${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Taxi', lastName: `U${RUN}${userIds.length}`,
      roles: roles as never, activeRole: activeRole as never, status: 'ACTIVE', isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeAdmin(): Promise<{ token: string; userId: string }> {
  const user = await app.prisma.user.create({
    data: {
      phone: `+59242${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Taxi', lastName: `Admin${RUN}${userIds.length}`,
      roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-driver-claim', deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId: user.id };
}

const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const approvalIdOf = (res: { statusCode: number; json: () => unknown }): string | null => {
  if (res.statusCode !== 202) return null;
  try {
    const body = res.json() as { error?: { code?: string; details?: { approvalId?: string } } };
    return body?.error?.code === 'APPROVAL_REQUIRED' ? (body.error.details?.approvalId ?? null) : null;
  } catch { return null; }
};

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
  await runWithoutTenant(async () => {
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-driver-claim').catch(() => 0);
    await app.prisma.rlpReserveEntry.deleteMany({ where: { OR: [{ claimId: { in: claimIds } }, { note: RESERVE_NOTE }] } }).catch(() => {});
    await app.prisma.reimbursementClaim.deleteMany({ where: { id: { in: claimIds } } }).catch(() => {});
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-driver-claim');
  await app.close();
});

describe('[DS110 #19] a TAXI driver claim is tenant-owned and payable once', () => {
  it('appears in the admin queue and completes the approve → paid two-person flow exactly once', async () => {
    const requester = await makeAdmin();
    const approver = await makeAdmin();

    // The fixture: a taxi leg that was never completed, filed by the driver.
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
        status: 'CANCELLED',
        pickupAddress: 'Stabroek Market', pickupLat: 6.801, pickupLng: -58.156,
        deliveryAddress: 'Camp Street', deliveryLat: 6.801, deliveryLng: -58.156,
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
        amount: 2000, reason: 'no_show', gpsLat: 6.801, gpsLng: -58.156,
        status: 'PENDING_REVIEW', flags: [],
      },
    });
    claimIds.push(claim.id);

    // The claim is visible: riderId is NULL here, so the pre-fix scope hid it.
    // The queue is paginated (oldest first) and the test DB is shared, so walk
    // pages until the row is found rather than assuming it is on page one.
    const findInQueue = async (): Promise<boolean> => {
      for (let page = 1; page <= 10; page += 1) {
        const res = await call(requester.token, 'GET', `/api/v1/admin/cash-rules/claims?status=PENDING_REVIEW&page=${page}&limit=50`);
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json() as { data: Array<{ id: string }>; meta: { hasNext: boolean } };
        if (body.data.some((row) => row.id === claim.id)) return true;
        if (!body.meta.hasNext) return false;
      }
      return false;
    };
    expect(await findInQueue(), 'the TAXI driver claim must be in the admin claims queue').toBe(true);

    // Approve: one person asks, a DIFFERENT person decides, the requester
    // re-issues carrying the approval. The requester cannot self-approve.
    const approveAsk = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/approve`, { reason: REASON });
    expect(approveAsk.statusCode, approveAsk.body).toBe(202);
    const approveId = approvalIdOf(approveAsk);
    expect(approveId).toBeTruthy();
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('PENDING_REVIEW');

    const selfDecide = await call(requester.token, 'POST', `/api/v1/admin/approvals/${approveId}/decide`, { approve: true, reason: REASON });
    expect(selfDecide.statusCode, selfDecide.body).toBe(403);
    const decided = await call(approver.token, 'POST', `/api/v1/admin/approvals/${approveId}/decide`, { approve: true, reason: REASON, note: 'Taxi guarantee evidence reviewed' });
    expect(decided.statusCode, decided.body).toBe(200);
    const approve = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/approve`, { reason: REASON }, { [APPROVAL_HEADER]: approveId! });
    expect(approve.statusCode, approve.body).toBe(200);
    expect((await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe('APPROVED');

    // Pay: the same two-person ceremony, then durable money facts.
    const paymentRef = `TAXI-${RUN}-P1`;
    const payAsk = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/paid`, { reference: paymentRef, amount: 2000 });
    expect(payAsk.statusCode, payAsk.body).toBe(202);
    const payId = approvalIdOf(payAsk);
    expect(payId).toBeTruthy();
    const payDecided = await call(approver.token, 'POST', `/api/v1/admin/approvals/${payId}/decide`, { approve: true, reason: REASON });
    expect(payDecided.statusCode, payDecided.body).toBe(200);
    const paid = await call(requester.token, 'PUT', `/api/v1/admin/cash-rules/claims/${claim.id}/paid`, { reference: paymentRef, amount: 2000 }, { [APPROVAL_HEADER]: payId! });
    expect(paid.statusCode, paid.body).toBe(200);

    const after = await app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(after.status).toBe('PAID');
    expect(after.paymentRef).toBe(paymentRef.toUpperCase());
    expect(Number(after.paidAmount)).toBe(2000);
    expect(after.paidById).toBe(requester.userId);

    // Paid exactly once: one reserve draw, and the evidence is on the row.
    const payouts = await app.prisma.rlpReserveEntry.findMany({ where: { claimId: claim.id, kind: 'PAYOUT' } });
    expect(payouts).toHaveLength(1);
    expect(Number(payouts[0]!.amount)).toBe(-2000);
  });
});
