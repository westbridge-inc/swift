import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { runWeeklySettlement, type JobContext } from '../jobs/queue';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D7-01 — the weekly settlement snapshot is a money-adjacent write
// with no natural unique key (period bounds are computed from wall-clock at
// run time), so its idempotency must come from an explicit covered-window
// guard: a vendor whose latest settlement already reaches into this run's
// window is skipped. This is what makes a BullMQ retry (mid-loop crash) or an
// operator DLQ-requeue safe. Driven directly, without queue plumbing.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let vendorId: string;
let ownerUserId: string;
let customerUserId: string;

function ctx(): JobContext {
  return {
    prisma: app.prisma,
    redis: undefined,
    io: { to: () => ({ emit: () => {} }) },
    log: app.log,
  } as unknown as JobContext;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();

  const owner = await app.prisma.user.create({
    data: {
      phone: '+5920076201', firstName: 'Settle', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  ownerUserId = owner.id;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Settle Diner', slug: `settle-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920076201', addressLine1: '1 Test St',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920076202', firstName: 'Settle', lastName: 'Cust',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  customerUserId = customer.id;

  await app.prisma.order.create({
    data: {
      orderNumber: `STL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.id, vendorId, status: 'DELIVERED',
      deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    },
  });
});

afterAll(async () => {
  await app.prisma.settlement.deleteMany({ where: { vendorId } });
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } });
  await app.prisma.customer.deleteMany({ where: { userId: customerUserId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [ownerUserId, customerUserId] } } });
  await app.close();
});

describe('runWeeklySettlement — idempotent weekly snapshot [SWIFT-AUD-D7-01]', () => {
  it('creates exactly one settlement for the delivered week', async () => {
    await runWeeklySettlement(ctx());
    const rows = await app.prisma.settlement.findMany({ where: { vendorId } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.totalOrders).toBe(1);
    expect(Number(rows[0]!.totalBase)).toBe(1000);
    expect(rows[0]!.status).toBe('PENDING');
  });

  it('a retry / requeue of the same week creates NOTHING new', async () => {
    await runWeeklySettlement(ctx()); // second delivery of the same job
    const rows = await app.prisma.settlement.findMany({ where: { vendorId } });
    expect(rows.length).toBe(1); // still exactly one — the covered-window guard
  });
});
