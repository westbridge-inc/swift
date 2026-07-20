import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { computeActiveLegEta, refreshLegEta, cachedLegEta } from '../modules/dispatch/live-eta';

// ---------------------------------------------------------------------------
// SWIFT-UG-RT-01 — live tracking previously streamed only the mover's
// position; the ETA was computed once at assignment and went stale. These
// tests pin the leg-targeting logic (pickup before PICKED_UP, dropoff after)
// and the redis cache the socket stream reads between refreshes.
// Provider = deterministic haversine (test default), so distances map to
// stable minute values: the pickup sits ~minutes away, the dropoff far.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let orderId: string;
let customerUserId: string;
let vendorOwnerUserId: string;
let vendorId: string;

// Mover position ≈ on top of the pickup, ~35 km from the dropoff.
const MOVER = { lat: 6.8, lng: -58.15 };
const PICKUP = { lat: 6.802, lng: -58.151 }; // a few blocks
const DROPOFF = { lat: 7.1, lng: -58.4 }; // far out

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();

  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920078201', firstName: 'Eta', lastName: 'Cust',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} },
    },
  });
  customerUserId = customer.id;
  const owner = await app.prisma.user.create({
    data: {
      phone: '+5920078202', firstName: 'Eta', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  vendorOwnerUserId = owner.id;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Eta Diner', slug: `eta-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920078202', addressLine1: '1 Eta St',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `ETA-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.id, vendorId, status: 'RIDER_EN_ROUTE_PICKUP',
      pickupAddress: 'Eta Diner', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'Far away', deliveryLat: DROPOFF.lat, deliveryLng: DROPOFF.lng,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  await app.redis.del(`mover:eta:${orderId}`);
  await app.prisma.order.deleteMany({ where: { id: orderId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: vendorOwnerUserId } });
  await app.prisma.customer.deleteMany({ where: { userId: customerUserId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [customerUserId, vendorOwnerUserId] } } });
  await app.close();
});

describe('live-eta — active-leg targeting + cache [SWIFT-UG-RT-01]', () => {
  it('targets the PICKUP while the mover is en route to it (small ETA)', async () => {
    const eta = await computeActiveLegEta(app, orderId, MOVER);
    expect(eta).not.toBeNull();
    expect(eta!).toBeLessThanOrEqual(3); // blocks away at urban speed
  });

  it('switches the target to the DROPOFF once picked up (much larger ETA)', async () => {
    await app.prisma.order.update({ where: { id: orderId }, data: { status: 'EN_ROUTE_DELIVERY' } });
    const eta = await computeActiveLegEta(app, orderId, MOVER);
    expect(eta).not.toBeNull();
    expect(eta!).toBeGreaterThan(30); // ~35 km out — clearly the other leg
  });

  it('refreshLegEta caches; cachedLegEta serves the value between refreshes', async () => {
    const fresh = await refreshLegEta(app, orderId, MOVER);
    expect(fresh).not.toBeNull();
    const cached = await cachedLegEta(app, orderId);
    expect(cached).toBe(fresh);
  });

  it('an unknown order and a cache miss both answer null, never throw', async () => {
    expect(await computeActiveLegEta(app, 'cmq00000000000000000000000', MOVER)).toBeNull();
    expect(await cachedLegEta(app, 'cmq00000000000000000000000')).toBeNull();
  });
});
