import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, PaymentStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { grantStepUp } from './helpers/step-up';
import { registerErrorHandler } from '../middleware/error-handler';
import { syntheticLocationOwner } from './helpers/online-mover';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// MKT-F057 — a customer-held delivery PIN for goods deliveries, verified at
// the door, like the taxi safety PIN.
//
// The proof is "the customer holds a 6-digit code, the rider enters it". The
// rider is the VERIFIER, so no rider-facing payload may ever carry the value
// (asserted on the raw serialized bodies below). Wrong guesses burn attempts
// (5, shared MAX_HANDOVER_ATTEMPTS) and lock to support; the documented
// no_show/refused outcomes never need the PIN. Legacy rows without a PIN
// complete as before.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Own geo sandbox, ~50 km from cash.test.ts's {7.2, -58.6} — online riders
// here must never enter another file's dispatch radius when suites run in
// parallel.
const GPS = { lat: 7.6, lng: -58.2 };
const DOOR = { lat: 7.6007, lng: -58.2007 };
// Phone prefix verified unused: the suites use 00122, 00133, 00144, 00166,
// 00177, 00188, 00077, 00087/88, 00201/02, 00797/98/99, 0029900… and none
// claims 00155.
const PHONE_PREFIX = '+59200155';
const RESERVE_NOTE = 'goods-door-pin fixture reserve';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
let vendorId = '';
let itemId = '';

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const riderIds = riders.map((r) => r.id);
  await app.prisma.rlpReserveEntry.deleteMany({ where: { note: RESERVE_NOTE } });
  await app.prisma.reimbursementClaim.deleteMany({
    where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
  });
  const orderIds = (
    await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
      select: { id: true },
    })
  ).map((o) => o.id);
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.strike.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'DoorPin',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'doorpin-test',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeRider() {
  const u = await makeUserWithSession(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: u.userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      isOnline: true,
      locationSessionId: syntheticLocationOwner('doorpin'),
      currentLat: GPS.lat,
      currentLng: GPS.lng,
      lastLocationUpdate: new Date(),
    },
  });
  return { ...u, riderId: rider.id };
}

/** A REAL at-door order: the status-log rows the transition machinery expects,
 *  and a rider standing where they say they are. */
async function arriveAtDoor(orderId: string, riderId: string) {
  await app.prisma.orderStatusLog.create({
    data: { orderId, status: 'PICKED_UP', changedBy: riderId, note: 'fixture pickup', createdAt: new Date(Date.now() - 40 * 60_000) },
  });
  await app.prisma.orderStatusLog.create({
    data: { orderId, status: 'ARRIVED', changedBy: riderId, note: 'fixture arrival', createdAt: new Date(Date.now() - 10 * 60_000) },
  });
  await app.prisma.rider.update({
    where: { id: riderId },
    data: { currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date() },
  });
}

/** Every fixture sets a REAL code (handover-secrets.test.ts's rule) — a null
 *  PIN serializes to nothing and would let a privacy assertion pass through. */
async function makeAtDoorOrder(
  customerId: string,
  riderId: string,
  pin: string,
  opts: { paymentMethod?: 'CASH' | 'MOBILE_MONEY'; paymentStatus?: PaymentStatus; status?: OrderStatus } = {},
) {
  const created = await app.prisma.order.create({
    data: {
      orderNumber: `DP-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      riderId,
      status: opts.status ?? 'ARRIVED',
      deliveryAddress: '9 Door Street, Georgetown',
      deliveryLat: DOOR.lat,
      deliveryLng: DOOR.lng,
      pickupLat: GPS.lat,
      pickupLng: GPS.lng,
      pickupAddress: 'Vendor corner',
      subtotalBase: 3000,
      subtotalMarkup: 0,
      subtotalCustomer: 3000,
      deliveryFee: 500,
      totalAmount: 3000,
      paymentMethod: opts.paymentMethod ?? 'CASH',
      paymentStatus: opts.paymentStatus ?? 'PENDING',
      ridePin: pin,
      items: {
        create: {
          itemId,
          name: 'Plate',
          quantity: 1,
          basePrice: 3000,
          markedUpPrice: 3000,
          markupAmount: 0,
          totalBase: 3000,
          totalMarkup: 0,
          totalCustomer: 3000,
          selectedOptions: {},
        },
      },
    },
  });
  createdOrderIds.push(created.id);
  if (created.status === 'ARRIVED' || created.status === 'FAILED') await arriveAtDoor(created.id, riderId);
  return created;
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** Next occurrence of a UTC weekday at a Guyana wall-clock time, as a TRUE instant. */
function nextGuyana(dayOfWeek: number, hours: number, minutes: number): Date {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  for (let i = 1; i <= 7; i++) {
    const day = new Date(Date.UTC(y!, m! - 1, d! + i));
    if (day.getUTCDay() !== dayOfWeek) continue;
    return instantOfGuyanaWallClock(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes)));
  }
  throw new Error('unreachable: every weekday occurs within seven days');
}

async function makeVendorWithItem(type: 'RESTAURANT' | 'SERVICE', extraItem: object = {}) {
  const owner = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `DoorPin ${type} ${seq}`,
      slug: `doorpin-${type.toLowerCase()}-${seq}`,
      vendorType: type,
      phone: `${PHONE_PREFIX}99${seq}`,
      addressLine1: '1 Door Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: GPS.lat,
      longitude: GPS.lng,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: category.id, name: `${type} item`, basePrice: 1000, ...extraItem },
  });
  return { ...owner, vendorId: vendor.id, itemId: item.id };
}

async function checkout(customerToken: string, body: Record<string, unknown>) {
  return inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', ...body }, customerToken);
}

async function addToCart(customerToken: string, vendorIdArg: string, itemIdArg: string, quantity = 1) {
  const res = await inject('POST', '/api/v1/customer/cart/items', { vendorId: vendorIdArg, itemId: itemIdArg, quantity }, customerToken);
  expect([200, 201]).toContain(res.statusCode);
}

const FORBIDDEN = (route: string) => (payload: string) => {
  for (const key of ['ridePin', 'pickupCode', 'pickupCodeAttempts']) {
    expect(payload.includes(`"${key}"`), `${route} leaked ${key} to the party that verifies it`).toBe(false);
  }
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  await purgeFixtures();

  const vendor = await makeVendorWithItem('RESTAURANT');
  vendorId = vendor.vendorId;
  itemId = vendor.itemId;
  // [P31-1] Payouts are drawn from the loss-protection reserve: fund it for the
  // no-show test's guarantee claim.
  await app.prisma.rlpReserveEntry.create({
    data: { countryCode: 'GY', kind: 'ADJUSTMENT', amount: 1_000_000, note: RESERVE_NOTE },
  });
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('MKT-F057 — the PIN is minted at checkout for every delivery rail', () => {
  it('DELIVERY checkout writes a 6-digit door PIN and no pickup code', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({
      data: {
        userId: customer.userId,
        label: 'Home',
        addressLine1: '9 Door Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: GPS.lat,
        longitude: GPS.lng,
        isDefault: true,
      },
    });
    await addToCart(customer.token, vendorId, itemId);
    const res = await checkout(customer.token, {});
    expect(res.statusCode).toBe(200);
    const order = res.json().data.order;
    createdOrderIds.push(order.id);
    expect(order.fulfillment).toBe('DELIVERY');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.ridePin).toMatch(/^\d{6}$/);
    expect(db.pickupCode).toBeNull();

    // The mint happens at checkout, but the HOLDER surface only opens at pickup:
    // a PENDING order's detail must not carry the code (owner decision 4 — the
    // tracking screen, not the confirmation screen, is the display surface).
    const detail = await inject('GET', `/api/v1/customer/orders/${order.id}`, undefined, customer.token);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.ridePin).toBeNull();
  });

  it('PICKUP checkout writes a pickup code and no door PIN', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({
      data: {
        userId: customer.userId,
        label: 'Home',
        addressLine1: '9 Door Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: GPS.lat,
        longitude: GPS.lng,
        isDefault: true,
      },
    });
    await addToCart(customer.token, vendorId, itemId);
    const res = await checkout(customer.token, { fulfillmentSelections: { [vendorId]: 'PICKUP' } });
    expect(res.statusCode).toBe(200);
    const order = res.json().data.order;
    createdOrderIds.push(order.id);
    expect(order.pickupCode).toMatch(/^\d{6}$/);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.fulfillment).toBe('PICKUP');
    expect(db.ridePin).toBeNull();
    expect(db.pickupCode).toMatch(/^\d{6}$/);
  });

  it('APPOINTMENT checkout writes neither code', async () => {
    const service = await makeVendorWithItem('SERVICE', {
      fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 30, slots: [{ dayOfWeek: 4, start: '09:00', end: '17:00' }] },
    });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({
      data: {
        userId: customer.userId,
        label: 'Home',
        addressLine1: '9 Door Street',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: GPS.lat,
        longitude: GPS.lng,
        isDefault: true,
      },
    });
    await addToCart(customer.token, service.vendorId, service.itemId);
    const slot = nextGuyana(4, 11, 0);
    const res = await checkout(customer.token, {
      appointments: [{ itemId: service.itemId, slotStart: slot.toISOString() }],
    });
    expect(res.statusCode).toBe(200);
    const order = res.json().data.order;
    createdOrderIds.push(order.id);
    expect(order.fulfillment).toBe('APPOINTMENT');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.ridePin).toBeNull();
    expect(db.pickupCode).toBeNull();
  });
});

describe('MKT-F057 — the cash door verifies the PIN before any money moves', () => {
  it('a missing PIN is refused with MISSING_PIN and nothing durable moves', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810');

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'paid',
      gps: DOOR,
    }, rider.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_PIN');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.status).toBe('ARRIVED');
    expect(db.paymentStatus).toBe('PENDING');
    expect(db.ridePinAttempts).toBe(0);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
    expect(await app.prisma.strike.count({ where: { orderId: order.id } })).toBe(0);
    expect(await app.prisma.reimbursementClaim.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('five wrong guesses burn five attempts with a countdown, then the door locks', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810');

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
        outcome: 'paid',
        gps: DOOR,
        ridePin: String(100000 + attempt), // never the real PIN
      }, rider.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PIN');
      expect(res.json().error.message).toContain(`${5 - attempt} attempt(s) remaining`);
    }

    const locked = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'paid',
      gps: DOOR,
      ridePin: '246810', // even the CORRECT PIN is refused once locked
    }, rider.token);
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.ridePinAttempts).toBe(5);
    expect(db.status).toBe('ARRIVED');
    expect(db.paymentStatus).toBe('PENDING');
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('the correct PIN captures the cash and completes the delivery', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810');

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'paid',
      gps: DOOR,
      ridePin: '246810',
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');
    // The verifier's own success payload must not echo the code.
    FORBIDDEN('POST /rider/orders/:id/handover')(res.payload);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.status).toBe('DELIVERED');
    expect(db.paymentStatus).toBe('CAPTURED');
    expect(db.ridePinAttempts).toBe(0);
    const earnings = await app.prisma.earning.findMany({ where: { orderId: order.id } });
    expect(earnings).toHaveLength(1);
    expect(earnings[0]!.status).toBe('AVAILABLE');
    expect(await app.prisma.strike.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('a rider who does not own the order is refused before the PIN gate (no attempt burns)', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const owner = await makeRider();
    const intruder = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, owner.riderId, '246810');

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'paid',
      gps: DOOR,
      ridePin: '246810',
    }, intruder.token);
    // The cash handover resolves ownership first and answers NOT_FOUND for a
    // non-owner (the same refusal main already returns) — and crucially that
    // refusal happens BEFORE the PIN gate, so no attempt burns.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.ridePinAttempts).toBe(0);
    expect(db.status).toBe('ARRIVED');
  });
});

describe('MKT-F057 — the MMG door verifies the PIN on PUT /delivered', () => {
  it('a missing PIN is refused with MISSING_PIN and the order stays ARRIVED', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810', {
      paymentMethod: 'MOBILE_MONEY',
      paymentStatus: 'CAPTURED',
    });

    const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {}, rider.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_PIN');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.status).toBe('ARRIVED');
    expect(db.ridePinAttempts).toBe(0);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('five wrong guesses lock the MMG door; the correct PIN still completes a fresh order', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810', {
      paymentMethod: 'MOBILE_MONEY',
      paymentStatus: 'CAPTURED',
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {
        ridePin: String(200000 + attempt),
      }, rider.token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PIN');
    }
    const locked = await inject('PUT', `/api/v1/rider/orders/${order.id}/delivered`, {
      ridePin: '246810',
    }, rider.token);
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).ridePinAttempts).toBe(5);

    const fresh = await makeAtDoorOrder(customer.userId, rider.riderId, '135790', {
      paymentMethod: 'MOBILE_MONEY',
      paymentStatus: 'CAPTURED',
    });
    const ok = await inject('PUT', `/api/v1/rider/orders/${fresh.id}/delivered`, {
      ridePin: '135790',
    }, rider.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.status).toBe('DELIVERED');
    FORBIDDEN('PUT /rider/orders/:id/delivered')(ok.payload);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(db.status).toBe('DELIVERED');
    expect(db.ridePinAttempts).toBe(0);
    const earnings = await app.prisma.earning.findMany({ where: { orderId: fresh.id } });
    expect(earnings).toHaveLength(1);
    expect(earnings[0]!.status).toBe('AVAILABLE');
  });
});

describe('MKT-F057 — a locked door has a support reset (decision 5: 5 attempts, then support)', () => {
  const REASON = 'the rider misread the code five times at the door; the customer is present';
  const resetUrl = (id: string) => `/api/v1/admin/orders/${id}/handover-secret/reset-delivery-pin`;

  it('five wrong tries lock the order; support sees the lock, resets on the record, and the customer\'s NEW PIN completes the delivery', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '135790');
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, { outcome: 'paid', gps: DOOR, ridePin: String(200000 + attempt) }, rider.token);
      expect(res.json().error.code).toBe('INVALID_PIN');
    }
    expect((await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, { outcome: 'paid', gps: DOOR, ridePin: '135790' }, rider.token)).json().error.code).toBe('MAX_ATTEMPTS');

    // Support sees THIS lock (the delivery PIN's own budget), never the value.
    const admin = await loginWithOtp(app, '+5926001000');
    const adminToken: string = admin.json().data.tokens.accessToken;
    const detail = await inject('GET', `/api/v1/admin/orders/${order.id}`, undefined, adminToken);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.handover).toMatchObject({ ridePinIssued: true, ridePinAttempts: 5, ridePinLocked: true });
    expect(detail.payload).not.toContain('135790');

    // The door: step-up first, then a written reason.
    const noStepUp = await inject('POST', resetUrl(order.id), { reason: REASON }, adminToken);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');
    await grantStepUp(app, adminToken);
    expect((await inject('POST', resetUrl(order.id), { reason: 'short' }, adminToken)).statusCode).toBe(400);
    const reset = await inject('POST', resetUrl(order.id), { reason: REASON }, adminToken);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().data.rotated).toBe(true);
    expect(reset.payload).not.toContain('135790');

    // Durable: a new PIN, a clear budget, and the reason on the record.
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { ridePin: true, ridePinAttempts: true, status: true } });
    expect(after.ridePin).toMatch(/^\d{6}$/);
    expect(after.ridePin).not.toBe('135790');
    expect(after).toMatchObject({ ridePinAttempts: 0, status: 'ARRIVED' });
    const audit = await app.prisma.auditLog.findFirst({ where: { action: 'RESET_DELIVERY_PIN', entityId: order.id } });
    expect(audit?.changes).toMatchObject({ reason: REASON, attemptsCleared: 5, orderStatus: 'ARRIVED' });

    // The holder reads the new PIN on their own screen; the old one is dead; the new one completes.
    const mine = await inject('GET', `/api/v1/customer/orders/${order.id}`, undefined, customer.token);
    expect(mine.json().data.ridePin).toBe(after.ridePin);
    expect((await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, { outcome: 'paid', gps: DOOR, ridePin: '135790' }, rider.token)).json().error.code).toBe('INVALID_PIN');
    const paid = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, { outcome: 'paid', gps: DOOR, ridePin: after.ridePin }, rider.token);
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERED');
  });

  it('only support resets, only at the door, only a delivery PIN', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '864200');
    expect((await inject('POST', resetUrl(order.id), { reason: REASON })).statusCode).toBe(401);
    const byCustomer = await inject('POST', resetUrl(order.id), { reason: REASON }, customer.token);
    expect([401, 403]).toContain(byCustomer.statusCode);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).ridePin).toBe('864200');

    const admin = await loginWithOtp(app, '+5926001000');
    const adminToken: string = admin.json().data.tokens.accessToken;
    await grantStepUp(app, adminToken);
    const delivered = await makeAtDoorOrder(customer.userId, rider.riderId, '112233', { status: 'DELIVERED' });
    const late = await inject('POST', resetUrl(delivered.id), { reason: REASON }, adminToken);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('NOT_AT_THE_DOOR');
    const pinless = await makeAtDoorOrder(customer.userId, rider.riderId, null as unknown as string);
    const none = await inject('POST', resetUrl(pinless.id), { reason: REASON }, adminToken);
    expect(none.statusCode).toBe(404);
    expect(none.json().error.code).toBe('NO_DELIVERY_PIN');
  });
});

describe('MKT-F057 — the documented no-show path stays open without a PIN', () => {
  it('a no-show still fails the order, strikes the customer and opens the guarantee claim', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810');

    const res = await inject('POST', `/api/v1/rider/orders/${order.id}/handover`, {
      outcome: 'no_show',
      gps: DOOR,
    }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('FAILED');

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(db.status).toBe('FAILED');
    expect(db.paymentStatus).toBe('FAILED');
    expect(db.ridePinAttempts).toBe(0);
    expect(await app.prisma.strike.count({ where: { orderId: order.id } })).toBeGreaterThan(0);
    expect(await app.prisma.reimbursementClaim.count({ where: { orderId: order.id } })).toBeGreaterThan(0);
  });
});

describe('MKT-F057 — privacy: the verifier never reads the PIN, the holder does', () => {
  it('every rider read of a PIN-carrying order omits the code; the customer detail carries it', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const order = await makeAtDoorOrder(customer.userId, rider.riderId, '246810');
    await app.prisma.rider.update({ where: { id: rider.riderId }, data: { currentOrderId: order.id } });

    const active = await inject('GET', '/api/v1/rider/orders/active', undefined, rider.token);
    expect(active.statusCode).toBe(200);
    FORBIDDEN('GET /rider/orders/active')(active.payload);
    expect(active.json().data?.id).toBe(order.id);

    const legs = await inject('GET', '/api/v1/rider/orders/active-legs', undefined, rider.token);
    expect(legs.statusCode).toBe(200);
    FORBIDDEN('GET /rider/orders/active-legs')(legs.payload);

    // The whole rider lifecycle on a fresh order, asserting the code never
    // appears in any 200 the verifier reads.
    const sweep = await makeAtDoorOrder(customer.userId, rider.riderId, '246810', { status: 'RIDER_ASSIGNED' });
    for (const rung of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived'] as const) {
      const res = await inject('PUT', `/api/v1/rider/orders/${sweep.id}/${rung}`, undefined, rider.token);
      expect(res.statusCode, `rung ${rung}`).toBe(200);
      FORBIDDEN(`PUT /rider/orders/:id/${rung}`)(res.payload);
    }
    const handover = await inject('POST', `/api/v1/rider/orders/${sweep.id}/handover`, {
      outcome: 'paid',
      gps: DOOR,
      ridePin: '246810',
    }, rider.token);
    expect(handover.statusCode).toBe(200);
    FORBIDDEN('POST /rider/orders/:id/handover')(handover.payload);
    const history = await inject('GET', '/api/v1/rider/orders', undefined, rider.token);
    expect(history.statusCode).toBe(200);
    FORBIDDEN('GET /rider/orders')(history.payload);

    // The open board is a rider read too: an unassigned PIN-carrying order
    // must not hand its code to the next rider who might take it.
    const boardOrder = await app.prisma.order.create({
      data: {
        orderNumber: `DPB-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        vendorId,
        status: 'READY_FOR_PICKUP',
        deliveryAddress: '9 Door Street, Georgetown',
        deliveryLat: DOOR.lat,
        deliveryLng: DOOR.lng,
        pickupLat: GPS.lat,
        pickupLng: GPS.lng,
        pickupAddress: 'Vendor corner',
        subtotalBase: 3000,
        subtotalMarkup: 0,
        subtotalCustomer: 3000,
        deliveryFee: 500,
        totalAmount: 3000,
        paymentMethod: 'CASH',
        ridePin: '112233',
      },
    });
    createdOrderIds.push(boardOrder.id);
    const scout = await makeRider();
    const board = await inject('GET', '/api/v1/rider/orders/available', undefined, scout.token);
    expect(board.statusCode).toBe(200);
    // Presence FIRST: a capacity short-circuit or any board filter legitimately
    // answers {success:true,data:[]}, which would let the negative checks below
    // pass without the projection ever running. The fixture must actually be on
    // the board before its absence of the code means anything.
    expect((board.json().data as Array<{ id: string }>).map((o) => o.id)).toContain(boardOrder.id);
    expect(board.payload.includes('"ridePin"')).toBe(false);
    expect(board.payload.includes('"pickupCode"')).toBe(false);

    // TAXI rows carry their own safety PIN, delivered to the passenger through
    // the rides module. The goods-detail mapping must not start carrying it
    // here — even the holder's order detail stays a goods-only surface.
    const taxiRide = await app.prisma.order.create({
      data: {
        orderNumber: `DPT-${nanoid(10)}`,
        orderType: 'TAXI',
        customerId: customer.userId,
        status: 'RIDE_IN_PROGRESS',
        fulfillment: 'DELIVERY',
        pickupAddress: 'A',
        pickupLat: GPS.lat,
        pickupLng: GPS.lng,
        deliveryAddress: 'B',
        deliveryLat: DOOR.lat,
        deliveryLng: DOOR.lng,
        subtotalBase: 2000,
        subtotalMarkup: 0,
        subtotalCustomer: 2000,
        deliveryFee: 0,
        totalAmount: 2000,
        taxiFareTotal: 2000,
        paymentMethod: 'CASH',
        ridePin: '654321',
      },
    });
    createdOrderIds.push(taxiRide.id);
    const taxiDetail = await inject('GET', `/api/v1/customer/orders/${taxiRide.id}`, undefined, customer.token);
    expect(taxiDetail.statusCode).toBe(200);
    expect(taxiDetail.json().data.ridePin).toBeNull();

    // The customer is the HOLDER: their order detail carries the PIN.
    const detail = await inject('GET', `/api/v1/customer/orders/${order.id}`, undefined, customer.token);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.ridePin).toBe('246810');
  });
});
