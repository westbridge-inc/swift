import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { CashRulesService } from '../modules/cash/cash-rules.service';
import { LOSS_PROTECTION_DEFAULTS, provisionReserveForPreviousMonth, sweepLossProtection } from '../modules/cash/rlp';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [REVIEW-G2 S4-1 + REVIEW-M S4 on #2079] Rider loss protection is paid from Swift's reserve: a COUNTRY line
// (rlp_reserve_entries has no tenant). #2079 confined reading and topping it up to the default tenant. The
// rest of the census:
//   writers  adjustReserve (admin adjust: #2079), drawReserveForPayout (a claim PAID), monthly provisioning;
//   readers  reserveStatement (admin read: #2079), the daily sweep and provisioning notices.
// Like billing (requireDefaultTenantBilling), the program belongs to the default tenant until a per-operator
// reserve exists: another operator's claim is never paid from it (refused before the balance is read, so
// its refusal never states the balance), its partners' fees never provision it, and its admins are never
// paged with the line's balance (the notices are the default tenant's, not platform-wide).
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TENANT_B = `rlp-op-b-${RUN}`;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:rlp-default-tenant');

let app: FastifyInstance;
let notifications: NotificationService;
let cash: CashRulesService;
const userIds: string[] = [];
const orderIds: string[] = [];
const claimIds: string[] = [];

async function user(tenantId: string, roles: string[], active: string, extra: Record<string, unknown> = {}) {
  const u = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Reserve', lastName: `Op${userIds.length}`, roles: roles as never, activeRole: active as never, tenantId,
    status: 'ACTIVE', isPhoneVerified: true, trustLevel: 'L2', ...extra,
  } as never }));
  userIds.push(u.id);
  return u;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.ready();
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  notifications = new NotificationService(app.prisma, ioStub);
  cash = new CashRulesService(app.prisma, notifications, new OrderService(app.prisma, ioStub));
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'RLP operator B', slug: TENANT_B, isActive: true } }));
});

afterAll(async () => {
  // [FOLLOWUPS] Everything this file made goes, operator B included. Left behind, B was an ACTIVE PRODUCTION
  // tenant with users in it in a shared test DB: tenancy-foundation ('every seeded user and vendor belongs to an
  // existing tenant': all on the default) and checkout-integrity failed in any later run on that DB. Nothing here
  // is real money: the claim was refused before the reserve was read (no PAYOUT row), and the PROVISION rows
  // are on this run's own made-up countries, keyed to their period, with no tie to a user; they stay.
  await sys(async () => {
    // A claim has no foreign key to its order or people: found by its id AND by this file's customers, so a claim
    // never orphans (REVIEW-G S4 on #2235).
    await app.prisma.reimbursementClaim.deleteMany({ where: { OR: [{ id: { in: claimIds } }, { customerId: { in: userIds } }] } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:rlp-default-tenant').catch(() => 0);
    // Riders, customers, admins and notifications cascade from the user.
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
    // A cleanup that leaves the operator or its people behind fails this file, not a later one.
    expect(await app.prisma.tenant.count({ where: { id: TENANT_B } })).toBe(0);
    expect(await app.prisma.user.count({ where: { OR: [{ id: { in: userIds } }, { tenantId: TENANT_B }] } })).toBe(0);
    expect(await app.prisma.reimbursementClaim.count({ where: { OR: [{ id: { in: claimIds } }, { customerId: { in: userIds } }] } })).toBe(0);
    expect(await app.prisma.order.count({ where: { OR: [{ id: { in: orderIds } }, { tenantId: TENANT_B }] } })).toBe(0);
  });
  await app.close();
});

describe('[#2079 follow-up] another operator never draws on, funds, or hears about Swift\'s loss-protection reserve', () => {
  it('a claim on another operator\'s order is refused before the reserve is read: no payout, no balance in the answer, the claim stays approved', async () => {
    const customer = await user(TENANT_B, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
    const moverUser = await user(TENANT_B, ['MOVER'], 'MOVER');
    const admin = await user(TENANT_B, ['ADMIN', 'CUSTOMER'], 'ADMIN');
    const rider = await sys(() => app.prisma.rider.create({ data: { userId: moverUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }));
    const order = await sys(() => app.prisma.order.create({ data: {
      orderNumber: `RB${nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase()}`, tenantId: TENANT_B, customerId: customer.id, riderId: rider.id,
      status: 'DELIVERED', orderType: 'COURIER', fulfillment: 'DELIVERY', paymentMethod: 'CASH', paymentStatus: 'PENDING',
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 1000, tipAmount: 0, totalAmount: 1000,
      deliveryAddress: '1 Operator Street', deliveryLat: 6.8, deliveryLng: -58.15, pickupLat: 6.81, pickupLng: -58.16, pickupAddress: 'Pickup',
    } as never }));
    orderIds.push(order.id);
    const claim = await sys(() => app.prisma.reimbursementClaim.create({ data: {
      orderId: order.id, riderId: rider.id, customerId: customer.id, amount: 1000, reason: 'no_show', gpsLat: 6.8, gpsLng: -58.15, status: 'APPROVED', flags: [],
    } as never }));
    claimIds.push(claim.id);

    const tried = await sys(() => cash.markClaimPaid(claim.id, admin.id, `OPB-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`, '1000')).then(() => null, (err: unknown) => err as { code?: string; message?: string });
    expect(tried?.code).toBe('RLP_NOT_THIS_OPERATOR');
    expect(tried?.message ?? '').not.toMatch(/\d{2,}/);
    expect(await sys(() => app.prisma.rlpReserveEntry.count({ where: { claimId: claim.id } }))).toBe(0);
    expect((await sys(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } }))).status).toBe('APPROVED');

    // The daily sweep is about Swift's own claims: another operator's approved claim, however late, is neither
    // listed in its SLA page nor flagged by it.
    const sweep = await sys(() => sweepLossProtection(app.prisma, {
      now: new Date(Date.now() + 30 * 86_400_000), rulesFor: async () => ({ ...LOSS_PROTECTION_DEFAULTS }), gateFor: async () => 1,
    }));
    expect(sweep.breached.map((b) => b.claimId)).not.toContain(claim.id);
    expect((await sys(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claim.id } }))).flags).toEqual([]);
  });

  it('monthly provisioning counts only the default tenant\'s paid fees, and its notice pages the default tenant\'s admins only', async () => {
    // Two countries of this run's own (two letters, never a real market) so no other suite's revenue mixes in.
    const tag = RUN.replace(/[^a-z]/g, 'q').toUpperCase();
    const CO_B = `X${tag[0] ?? 'Q'}`;
    const CO_A = `Y${tag[1] ?? 'Q'}`;
    let year = 2041;
    while (await sys(() => app.prisma.rlpReserveEntry.count({ where: { countryCode: { in: [CO_A, CO_B] }, kind: 'PROVISION', periodKey: `${year}-03` } })) > 0) year += 1;
    const period = new Date(Date.UTC(year, 3, 1));
    const payer = async (tenantId: string, countryCode: string) => {
      const u = await user(tenantId, ['MOVER'], 'MOVER', { countryCode });
      const r = await sys(() => app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }));
      const sub = await sys(() => app.prisma.subscription.create({ data: { riderId: r.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 12000, currentPeriodStart: new Date(Date.UTC(year, 2, 1)), currentPeriodEnd: new Date(Date.UTC(year, 2, 8)), nextBillingDate: new Date(Date.UTC(year, 2, 8)) } as never }));
      await sys(() => app.prisma.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(year, 2, 1)), periodEnd: new Date(Date.UTC(year, 2, 8)), paidAt: new Date(Date.UTC(year, 2, 3)) } as never }));
      return sub;
    };
    const subs = [await payer(TENANT_B, CO_B), await payer('swift-default', CO_A)];
    const adminB = await user(TENANT_B, ['ADMIN', 'CUSTOMER'], 'ADMIN', { admin: { create: { permissions: ['*'] } } });
    const adminA = await user('swift-default', ['ADMIN', 'CUSTOMER'], 'ADMIN', { admin: { create: { permissions: ['*'] } } });
    try {
      const run = await sys(() => provisionReserveForPreviousMonth(app.prisma, { now: period, rulesFor: async () => ({ ...LOSS_PROTECTION_DEFAULTS, rlpReserveRatePct: 2 }), notifications }));
      expect(run.find((r) => r.countryCode === CO_B)).toBeUndefined();
      expect(run.find((r) => r.countryCode === CO_A)).toMatchObject({ created: true, revenue: 12000, provisioned: 240 });
      const told = async (userId: string) => sys(() => app.prisma.notification.count({ where: { userId, data: { path: ['kind'], equals: 'rlp_reserve_provisioned' } } }));
      expect(await told(adminA.id)).toBe(1);
      expect(await told(adminB.id)).toBe(0);
    } finally {
      for (const sub of subs) await sys(() => app.prisma.subscription.delete({ where: { id: sub.id } }));
    }
  });

  it('[BILL-PRO] a pro\'s paid weekly fee is fee revenue too: it provisions the reserve in the pro\'s country, only in the default tenant', async () => {
    const tag = RUN.replace(/[^a-z]/g, 'q').toUpperCase();
    const CO_B = `W${tag[2] ?? 'Q'}`;
    const CO_A = `V${tag[3] ?? 'Q'}`;
    let year = 2041;
    while (await sys(() => app.prisma.rlpReserveEntry.count({ where: { countryCode: { in: [CO_A, CO_B] }, kind: 'PROVISION', periodKey: `${year}-05` } })) > 0) year += 1;
    const period = new Date(Date.UTC(year, 5, 1));
    const providerIds: string[] = [];
    const proPayer = async (tenantId: string, countryCode: string) => {
      const u = await user(tenantId, ['CUSTOMER'], 'CUSTOMER', { countryCode });
      const p = await sys(() => app.prisma.serviceProvider.create({ data: { userId: u.id, trade: 'tutor', isVerified: true } }));
      providerIds.push(p.id);
      const sub = await sys(() => app.prisma.subscription.create({ data: { serviceProviderId: p.id, type: 'INDEPENDENT_PRO', status: 'ACTIVE', weeklyRate: 8000, currentPeriodStart: new Date(Date.UTC(year, 4, 1)), currentPeriodEnd: new Date(Date.UTC(year, 4, 8)), nextBillingDate: new Date(Date.UTC(year, 4, 8)) } as never }));
      await sys(() => app.prisma.subscriptionPayment.create({ data: { subscriptionId: sub.id, amount: 8000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(year, 4, 1)), periodEnd: new Date(Date.UTC(year, 4, 8)), paidAt: new Date(Date.UTC(year, 4, 3)) } as never }));
      return sub;
    };
    const subs = [await proPayer(TENANT_B, CO_B), await proPayer('swift-default', CO_A)];
    try {
      const run = await sys(() => provisionReserveForPreviousMonth(app.prisma, { now: period, rulesFor: async () => ({ ...LOSS_PROTECTION_DEFAULTS, rlpReserveRatePct: 2 }), notifications }));
      expect(run.find((r) => r.countryCode === CO_B)).toBeUndefined();
      expect(run.find((r) => r.countryCode === CO_A)).toMatchObject({ created: true, revenue: 8000, provisioned: 160 });
    } finally {
      for (const sub of subs) await sys(() => app.prisma.subscription.delete({ where: { id: sub.id } }));
      await sys(() => app.prisma.serviceProvider.deleteMany({ where: { id: { in: providerIds } } }));
    }
  });

  it('no loss-protection notice is platform-wide: each pages the default tenant (census of rlp.ts)', () => {
    const rlp = readFileSync(join(__dirname, '..', 'modules', 'cash', 'rlp.ts'), 'utf8');
    const calls = rlp.split('notifyAdmins(prisma').length - 1;
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(rlp).not.toMatch(/tenantId: null/);
    expect(rlp.match(/notifyAdmins\(prisma, opts\.notifications, \{\s*tenantId: RLP_TENANT,/g)?.length ?? 0).toBe(calls);
  });
});
