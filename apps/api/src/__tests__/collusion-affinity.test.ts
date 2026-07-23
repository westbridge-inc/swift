import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { scanVendorRiderClaimAffinity } from '../modules/cash/cash-rules.service';

// ---------------------------------------------------------------------------
// SWIFT-164 — vendor↔rider collusion affinity. The per-claim guardrails model
// rider↔customer collusion, but a vendor funnelling fabricated failed deliveries
// to one favoured rider is invisible on the first cycle. The periodic scan
// counts guarantee claims by (vendorId, riderId) and surfaces the outliers.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorId: string;
const DAY = 24 * 60 * 60 * 1000;
const base = 592_460_000_000 + Math.floor(Math.random() * 400_000_000);
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: string) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${base + seq}`, firstName: 'Coll', lastName: `U${seq}`,
      roles, activeRole: activeRole as any, isPhoneVerified: true,
    },
  });
  userIds.push(u.id);
  return u;
}

async function makeRider() {
  const u = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const r = await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  return r.id;
}

/** One guarantee claim from (vendorId, riderId), backdated `daysAgo`. */
async function plantClaim(riderId: string, customerId: string, daysAgo: number, vId = vendorId) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `COL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId, vendorId: vId, riderId, status: 'FAILED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2000, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return app.prisma.reimbursementClaim.create({
    data: {
      orderId: order.id, riderId, customerId, amount: 2000, reason: 'no_show',
      gpsLat: 6.8, gpsLng: -58.15, status: 'AUTO_APPROVED', flags: [],
      createdAt: new Date(Date.now() - daysAgo * DAY),
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Collusion Diner', slug: `coll-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `+${base + 900}`, addressLine1: '1 Coll St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('scanVendorRiderClaimAffinity [SWIFT-164]', () => {
  it('surfaces a vendor–rider pair over the claim threshold, ignores an occasional one', async () => {
    const favoured = await makeRider();
    const occasional = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    // The favoured rider: 3 claims against this vendor inside the window.
    await plantClaim(favoured, customer.id, 1);
    await plantClaim(favoured, customer.id, 5);
    await plantClaim(favoured, customer.id, 10);
    // A one-off, legitimate-looking claim from another rider.
    await plantClaim(occasional, customer.id, 3);

    const pairs = await scanVendorRiderClaimAffinity(app.prisma, { minClaims: 3 });

    const flagged = pairs.find((p) => p.vendorId === vendorId && p.riderId === favoured);
    expect(flagged).toBeTruthy();
    expect(flagged!.claims).toBeGreaterThanOrEqual(3);
    // The occasional pair is below threshold — not surfaced.
    expect(pairs.some((p) => p.riderId === occasional)).toBe(false);
  });

  it('respects the time window — claims older than sinceDays do not count', async () => {
    const rider = await makeRider();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    // Two recent + one ancient: only two fall inside a 30-day window.
    await plantClaim(rider, customer.id, 2);
    await plantClaim(rider, customer.id, 4);
    await plantClaim(rider, customer.id, 200);

    const inWindow = await scanVendorRiderClaimAffinity(app.prisma, { sinceDays: 30, minClaims: 3 });
    expect(inWindow.some((p) => p.riderId === rider)).toBe(false); // only 2 in window < 3

    const allTime = await scanVendorRiderClaimAffinity(app.prisma, { sinceDays: 365, minClaims: 3 });
    expect(allTime.some((p) => p.riderId === rider)).toBe(true); // all 3 count
  });
});
