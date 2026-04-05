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

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();

  // Clean up stale sessions from prior test runs to avoid unique constraint
  // violations on JWT tokens (deterministic in dev mode for same user+secret).
  await app.prisma.session.deleteMany({
    where: {
      user: { phone: { in: ['+5926003000', '+5926002000', '+5926004000'] } },
    },
  });

  // Login all three test accounts
  customerToken = await loginAndGetToken('+5926003000');
  vendorToken = await loginAndGetToken('+5926002000');
  riderToken = await loginAndGetToken('+5926004000');
});

afterAll(async () => {
  // Cleanup: delete order-related data created during the test
  if (createdOrderId) {
    try {
      await app.prisma.rating.deleteMany({ where: { orderId: createdOrderId } });
      await app.prisma.earning.deleteMany({ where: { orderId: createdOrderId } });
      await app.prisma.orderStatusLog.deleteMany({ where: { orderId: createdOrderId } });
      await app.prisma.orderItem.deleteMany({ where: { orderId: createdOrderId } });
      await app.prisma.order.delete({ where: { id: createdOrderId } });
    } catch {
      // Order may already be cleaned up
    }
  }

  // Clean up any cart left behind by the customer
  const customerUser = await app.prisma.user.findUnique({ where: { phone: '+5926003000' } });
  if (customerUser) {
    await app.prisma.cart.deleteMany({ where: { customerId: customerUser.id } }).catch(() => {});
  }

  // Reset rider state
  const riderUser = await app.prisma.user.findUnique({ where: { phone: '+5926004000' } });
  if (riderUser) {
    const rider = await app.prisma.rider.findUnique({ where: { userId: riderUser.id } });
    if (rider) {
      await app.prisma.rider.update({
        where: { id: rider.id },
        data: { isOnline: false, isAvailable: false, currentOrderId: null },
      }).catch(() => {});
    }
  }

  await app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loginAndGetToken(phone: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-otp',
    payload: { phone, code: '123456' },
    headers: { 'content-type': 'application/json' },
  });
  const body = res.json();
  if (!body.data.tokens) {
    throw new Error(`Login failed for ${phone}: isNewUser=${body.data.isNewUser}`);
  }
  return body.data.tokens.accessToken;
}

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
    const res = await inject('GET', '/api/v1/customer/vendors', customerToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    // Find Oasis Cafe
    const oasis = body.data.find((v: { slug: string }) => v.slug === 'oasis-cafe');
    expect(oasis).toBeDefined();
    vendorId = oasis.id;
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
    const res = await inject('POST', '/api/v1/rider/go-online', riderToken);
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

  it('Step 11: Rider marks order as delivered', async () => {
    const res = await inject('PUT', `/api/v1/rider/orders/${createdOrderId}/delivered`, riderToken);
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DELIVERED');
    expect(body.data.earning).toBeGreaterThan(0);
    expect(body.data.isAvailable).toBe(true);
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
