import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;

// Tokens for each role
let customerToken: string;
let vendorToken: string;
let riderToken: string;

// Track created resources for cleanup
let createdOrderId: string;

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(customerRoutes, { prefix: '/api/v1/customer' });
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.register(riderRoutes, { prefix: '/api/v1/rider' });
  await server.register(searchRoutes, { prefix: '/api/v1' });
  await server.ready();
  return server;
}

// Phone-isolated fixtures: this file owns +59200111xx so parallel test files
// (auth/step3/...) can never race its sessions or OTP keys.
const FLOW_CUSTOMER = '+5920011101';
const FLOW_VENDOR = '+5920011102';
const FLOW_RIDER = '+5920011103';

let flowVendorId = '';

async function makeUserWithSession(phone: string, roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({
    data: {
      phone,
      firstName: 'Flow',
      lastName: activeRole,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'order-flow',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { userId: user.id, token };
}

async function purgeFlowFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { in: [FLOW_CUSTOMER, FLOW_VENDOR, FLOW_RIDER] } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { rider: { userId: { in: ids } } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();

  await purgeFlowFixtures();

  // Customer with a default address (checkout needs one)
  const customer = await makeUserWithSession(FLOW_CUSTOMER, ['CUSTOMER'], 'CUSTOMER');
  customerToken = customer.token;
  await app.prisma.address.create({
    data: {
      userId: customer.userId,
      label: 'Home',
      addressLine1: '77 Flow Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8045,
      longitude: -58.1553,
      isDefault: true,
    },
  });

  // Vendor owner with an open, verified restaurant and a small menu
  const vendorUser = await makeUserWithSession(FLOW_VENDOR, ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorToken = vendorUser.token;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: vendorUser.userId } });
  const vendor = await app.prisma.vendor.upsert({
    where: { slug: 'flow-cafe' },
    update: { ownerId: owner.id },
    create: {
      ownerId: owner.id,
      name: 'Flow Cafe',
      slug: 'flow-cafe',
      vendorType: 'RESTAURANT',
      phone: FLOW_VENDOR,
      addressLine1: '42 Lifecycle Road',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8013,
      longitude: -58.1551,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  flowVendorId = vendor.id;
  if ((await app.prisma.category.count({ where: { vendorId: vendor.id } })) === 0) {
    const category = await app.prisma.category.create({
      data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 },
    });
    await app.prisma.item.createMany({
      data: [
        { vendorId: vendor.id, categoryId: category.id, name: 'Flow Pepperpot', basePrice: 2500, isAvailable: true },
        { vendorId: vendor.id, categoryId: category.id, name: 'Flow Cook-Up', basePrice: 2000, isAvailable: true },
      ],
    });
  }

  // Verified rider, ready to go online
  const riderUser = await makeUserWithSession(FLOW_RIDER, ['RIDER', 'CUSTOMER'], 'RIDER');
  riderToken = riderUser.token;
  await app.prisma.rider.create({
    data: {
      userId: riderUser.userId,
      riderType: 'BOTH',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      currentLat: 6.8013,
      currentLng: -58.1551,
      // The direct accept now enforces the same CASH float gate as dispatch
      // (schema default is 0, which correctly refuses cash orders) — this
      // rider fronts the flow's cash order, so give it real headroom.
      floatLimit: 1_000_000,
    },
  });
});

afterAll(async () => {
  await purgeFlowFixtures();
  await app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };

  // Only set content-type and payload for methods that have a body.
  // Fastify rejects empty body with content-type: application/json.
  const hasBody = payload !== undefined;
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }

  return app.inject({
    method,
    url,
    ...(hasBody ? { payload: payload as Record<string, unknown> } : {}),
    headers,
  });
}

// ---------------------------------------------------------------------------
// Full Order Lifecycle Test
// ---------------------------------------------------------------------------

describe('Order Flow — Full Lifecycle', () => {
  let vendorId: string;
  let itemId: string;
  let orderNumber: string;

  // -----------------------------------------------------------------------
  // Step 1: Browse vendors
  // -----------------------------------------------------------------------

  it('Step 1: Customer browses vendors', async () => {
    const res = await inject('GET', '/api/v1/customer/vendors?limit=50', customerToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const flowCafe = body.data.find((v: { slug: string }) => v.slug === 'flow-cafe');
    expect(flowCafe).toBeDefined();
    expect(flowCafe.id).toBe(flowVendorId);
    vendorId = flowCafe.id;
  });

  // -----------------------------------------------------------------------
  // Step 2: Get menu items from vendor
  // -----------------------------------------------------------------------

  it('Step 2: Customer gets vendor menu', async () => {
    const res = await inject('GET', `/api/v1/customer/vendors/${vendorId}`, customerToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();

    // Get first available item
    const items = await app.prisma.item.findMany({
      where: { vendorId, isAvailable: true },
      take: 1,
    });
    expect(items.length).toBeGreaterThan(0);
    itemId = items[0]!.id;
  });

  // -----------------------------------------------------------------------
  // Step 3: Add item to cart
  // -----------------------------------------------------------------------

  it('Step 3: Customer adds item to cart', async () => {
    // Clear any existing cart first
    await inject('DELETE', '/api/v1/customer/cart', customerToken);

    const res = await inject('POST', '/api/v1/customer/cart/items', customerToken, {
      vendorId,
      itemId,
      quantity: 2,
    });
    const body = res.json();
    expect(res.statusCode === 200 || res.statusCode === 201).toBe(true);
    expect(body.success).toBe(true);
    expect(body.data.cart).toBeDefined();
    expect(body.data.cart.items.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Step 4: View cart
  // -----------------------------------------------------------------------

  it('Step 4: Customer views cart with computed totals', async () => {
    const res = await inject('GET', '/api/v1/customer/cart', customerToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.subtotalCustomer).toBeGreaterThan(0);
    expect(body.data.deliveryFee).toBeGreaterThanOrEqual(0);
    expect(body.data.totalAmount).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Step 5: Checkout
  // -----------------------------------------------------------------------

  it('Step 5: Customer checks out', async () => {
    const res = await inject('POST', '/api/v1/customer/checkout', customerToken, {
      paymentMethod: 'CASH',
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.order).toBeDefined();
    expect(body.data.order.orderNumber).toBeDefined();
    expect(body.data.order.status).toBe('PENDING');

    createdOrderId = body.data.order.id;
    orderNumber = body.data.order.orderNumber;
  });

  // -----------------------------------------------------------------------
  // Step 6: Vendor accepts order
  // -----------------------------------------------------------------------

  it('Step 6: Vendor accepts the order', async () => {
    const res = await inject('PUT', `/api/v1/vendor/orders/${createdOrderId}/accept`, vendorToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ACCEPTED');
  });

  // -----------------------------------------------------------------------
  // Step 7: Vendor starts preparing
  // -----------------------------------------------------------------------

  it('Step 7: Vendor marks order as preparing', async () => {
    const res = await inject('PUT', `/api/v1/vendor/orders/${createdOrderId}/preparing`, vendorToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('PREPARING');
  });

  // -----------------------------------------------------------------------
  // Step 8: Vendor marks order as ready
  // -----------------------------------------------------------------------

  it('Step 8: Vendor marks order as ready for pickup', async () => {
    const res = await inject('PUT', `/api/v1/vendor/orders/${createdOrderId}/ready`, vendorToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('READY_FOR_PICKUP');
  });

  // -----------------------------------------------------------------------
  // Step 9: Rider goes online and accepts order
  // -----------------------------------------------------------------------

  it('Step 9: Rider goes online', async () => {
    const res = await inject('POST', '/api/v1/rider/go-online', riderToken, {
      latitude: 6.8013,
      longitude: -58.1551,
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.isOnline).toBe(true);
  });

  it('Step 9b: Rider accepts the order', async () => {
    const res = await inject('POST', `/api/v1/rider/orders/${createdOrderId}/accept`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('RIDER_ASSIGNED');
    expect(body.data.orderId).toBe(createdOrderId);
  });

  // -----------------------------------------------------------------------
  // Step 10: Rider transitions through delivery statuses
  // -----------------------------------------------------------------------

  it('Step 10a: Rider en-route to pickup', async () => {
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/en-route-pickup`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('RIDER_EN_ROUTE_PICKUP');
  });

  it('Step 10b: Rider arrived at pickup', async () => {
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/arrived-pickup`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('RIDER_ARRIVED_PICKUP');
  });

  it('Step 10c: Rider picked up order', async () => {
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/picked-up`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('PICKED_UP');
  });

  it('Step 10d: Rider en-route to delivery', async () => {
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/en-route-delivery`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('EN_ROUTE_DELIVERY');
  });

  it('Step 10e: Rider arrived at delivery', async () => {
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/arrived`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('ARRIVED');
  });

  // -----------------------------------------------------------------------
  // Step 11: Rider marks as delivered
  // -----------------------------------------------------------------------

  it('Step 11: /delivered refuses a CASH order until payment is captured (golden rule)', async () => {
    // This order is CASH and payment has not been captured, so the final
    // /delivered step must be refused — the rider has to collect at the door
    // via /handover first. Guards against a cash order being closed unpaid.
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/delivered`, riderToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_NOT_CAPTURED');
  });

  it('Step 11b: Rider captures the cash via /handover, which completes the delivery', async () => {
    const res = await inject('POST', `/api/v1/rider/orders/${createdOrderId}/handover`, riderToken, {
      outcome: 'paid',
      gps: { lat: 6.8, lng: -58.15 },
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.status).toBe('DELIVERED');
    // Payment was captured as part of the handover — the books now match reality.
    const ord = await app.prisma.order.findUnique({ where: { id: createdOrderId }, select: { paymentStatus: true } });
    expect(ord?.paymentStatus).toBe('CAPTURED');
  });

  // -----------------------------------------------------------------------
  // Step 12: Verify order timeline has all statuses
  // -----------------------------------------------------------------------

  it('Step 12: Order timeline has all status transitions', async () => {
    const statusLogs = await app.prisma.orderStatusLog.findMany({
      where: { orderId: createdOrderId },
      orderBy: { createdAt: 'asc' },
    });

    const statuses = statusLogs.map((log) => log.status);

    // Verify key statuses are present
    expect(statuses).toContain('PENDING');
    expect(statuses).toContain('ACCEPTED');
    expect(statuses).toContain('PREPARING');
    expect(statuses).toContain('READY_FOR_PICKUP');
    expect(statuses).toContain('RIDER_ASSIGNED');
    expect(statuses).toContain('RIDER_EN_ROUTE_PICKUP');
    expect(statuses).toContain('RIDER_ARRIVED_PICKUP');
    expect(statuses).toContain('PICKED_UP');
    expect(statuses).toContain('EN_ROUTE_DELIVERY');
    expect(statuses).toContain('ARRIVED');
    expect(statuses).toContain('DELIVERED');
  });

  // -----------------------------------------------------------------------
  // Step 13: Verify rider earnings were created
  // -----------------------------------------------------------------------

  it('Step 13: Rider earnings exist for the delivered order', async () => {
    const earnings = await app.prisma.earning.findMany({
      where: { orderId: createdOrderId },
    });

    expect(earnings.length).toBeGreaterThan(0);

    // Should have at least a DELIVERY_FEE earning
    const deliveryFeeEarning = earnings.find((e) => e.type === 'DELIVERY_FEE');
    expect(deliveryFeeEarning).toBeDefined();
    expect(Number(deliveryFeeEarning!.amount)).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Step 14: Customer rates the order
  // -----------------------------------------------------------------------

  it('Step 14: Customer rates the order', async () => {
    const res = await inject('POST', `/api/v1/customer/orders/${createdOrderId}/rate`, customerToken, {
      vendorScore: 5,
      vendorComment: 'Delicious food!',
      riderScore: 5,
      riderComment: 'Fast delivery!',
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.ratings).toBeDefined();
    expect(body.data.ratings.length).toBe(2);

    const vendorRating = body.data.ratings.find((r: { type: string }) => r.type === 'vendor');
    const riderRating = body.data.ratings.find((r: { type: string }) => r.type === 'rider');
    expect(vendorRating.score).toBe(5);
    expect(riderRating.score).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Step 15: Verify final order state
  // -----------------------------------------------------------------------

  it('Step 15: Final order state is DELIVERED with all fields', async () => {
    const order = await app.prisma.order.findUnique({
      where: { id: createdOrderId },
      include: { items: true },
    });
    expect(order).not.toBeNull();
    expect(order!.status).toBe('DELIVERED');
    expect(order!.orderNumber).toBe(orderNumber);
    expect(order!.deliveredAt).not.toBeNull();
    expect(order!.acceptedAt).not.toBeNull();
    expect(order!.preparingAt).not.toBeNull();
    expect(order!.readyAt).not.toBeNull();
    expect(order!.pickedUpAt).not.toBeNull();
    expect(order!.items.length).toBeGreaterThan(0);
  });
});
