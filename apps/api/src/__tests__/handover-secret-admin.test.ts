import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { loginWithOtp } from './helpers/otp';
import { grantStepUp } from './helpers/step-up';
import { runWithoutTenant } from '../plugins/tenant-context';
import { handoverStatus, MAX_HANDOVER_ATTEMPTS } from '../modules/handover/handover-security';
import { rotatePickupCode } from '../modules/handover/handover-reveal';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [A-15] The pickup code is a CREDENTIAL, and the rule that makes it worth
// anything is that the verifier never holds it: the customer holds the code,
// the vendor types what the customer reads out, the server compares.
//
// The admin console printed it on the order list and the order detail. Both
// routes used `include:` with no projection, so the whole row went out — every
// admin, every screen share, every screenshot, every compromised session held
// a credential that completes a stranger's handover.
//
// These tests assert on the SERIALIZED response body, because the defect lived
// in serialization: a service-level assertion passes straight through it. Every
// fixture sets a REAL code — a null fixture serializes to nothing and would
// pass with the bug fully present.
// ---------------------------------------------------------------------------

const FORBIDDEN = ['pickupCode', 'ridePin', 'pickupCodeAttempts'];

let app: FastifyInstance;
let adminToken: string;
let vendorToken: string;
let vendorId: string;
let vendorOwnerId: string;
let customerId: string;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
// a per-run phone base: a suite that dies before cleanup must not poison the next run
const phoneBase = 592_609_000_000 + Math.floor(Math.random() * 800_000_000);

function assertNoSecrets(payload: string, where: string) {
  for (const key of FORBIDDEN) {
    expect(payload.includes(`"${key}"`), `${where} leaked ${key} into an admin response`).toBe(false);
  }
}

async function makeUser(roles: string[], activeRole: string) {
  seq += 1;
  // created in the ambient tenant, like every other fixture in this app: a
  // user written outside the tenant is invisible to the vendor's FK check
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Handover',
      lastName: `U${seq}`,
      roles: roles as never,
      activeRole: activeRole as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makePickupOrder(code: string | null, attempts = 0) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `HSA-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'PICKUP',
      customerId,
      vendorId,
      status: 'READY_FOR_PICKUP',
      deliveryAddress: 'Collect in store',
      deliveryLat: 6.801,
      deliveryLng: -58.156,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 0,
      totalAmount: 1000,
      paymentMethod: 'CASH',
      pickupCode: code,
      pickupCodeAttempts: attempts,
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await server.ready();
  app = server;

  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  vendorOwnerId = vo.id;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: 'Handover Counter',
      slug: `handover-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 900}`,
      addressLine1: '1 Counter St',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: 'ACTIVE',
      isVerified: true,
      acceptingOrders: true,
      isCurrentlyOpen: true,
    },
  });
  vendorId = vendor.id;
  const ownerLogin = await loginWithOtp(app, owner.phone);
  vendorToken = ownerLogin.json().data.tokens.accessToken;

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customerId = customer.id;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await purgeAuditLogs(app.prisma, { entityId: { in: orderIds } }, 'test-cleanup:handover-secret-admin');
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cartItem.deleteMany({ where: { cart: { vendorId } } });
    await app.prisma.cart.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: vendorOwnerId } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }, 'test-cleanup:handover-secret-admin');
  await app.close();
});

const adminGet = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });

describe('[A-15] the pickup code is not in any admin response', () => {
  it('the order list carries no handover secret, for an order that HAS one', async () => {
    const order = await makePickupOrder('654321');
    const res = await adminGet('/api/v1/admin/orders?limit=50');
    expect(res.statusCode).toBe(200);
    assertNoSecrets(res.payload, 'GET /admin/orders');
    // non-vacuous: the order really is in this response, and it really has a code
    expect(res.payload).toContain(order.orderNumber);
    expect(res.payload).not.toContain('654321');
    const stored = await app.prisma.order.findUnique({ where: { id: order.id }, select: { pickupCode: true } });
    expect(stored?.pickupCode).toBe('654321');
  });

  it('the order detail carries no handover secret, and says only THAT a code exists', async () => {
    const order = await makePickupOrder('112233', 2);
    const res = await adminGet(`/api/v1/admin/orders/${order.id}`);
    expect(res.statusCode).toBe(200);
    assertNoSecrets(res.payload, 'GET /admin/orders/:id');
    expect(res.payload).not.toContain('112233');
    const handover = res.json().data.handover;
    expect(handover).toMatchObject({ pickupCodeIssued: true, attempts: 2, locked: false });
    expect(JSON.stringify(handover)).not.toContain('112233');
  });

  it('the derived status tells the truth about a locked-out order without revealing anything', () => {
    expect(handoverStatus({ pickupCode: '000111', pickupCodeAttempts: MAX_HANDOVER_ATTEMPTS })).toMatchObject({
      pickupCodeIssued: true,
      locked: true,
      remaining: 0,
    });
    expect(handoverStatus({ pickupCode: null, pickupCodeAttempts: 0 })).toMatchObject({ pickupCodeIssued: false, locked: false });
    expect(handoverStatus({ ridePin: '9182' })).toMatchObject({ ridePinIssued: true, pickupCodeIssued: false });
  });
});

describe('[A-15] the one audited door', () => {
  it('refuses without a re-authentication, and refuses a reason that is not one', async () => {
    const order = await makePickupOrder('445566');
    const noStepUp = await adminGet(`/api/v1/admin/orders/${order.id}/handover-secret?reason=customer%20cannot%20open%20the%20app%20at%20the%20counter`);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(noStepUp.payload).not.toContain('445566');

    await grantStepUp(app, adminToken);
    const shrug = await adminGet(`/api/v1/admin/orders/${order.id}/handover-secret?reason=need%20it`);
    expect(shrug.statusCode).toBe(400);
    expect(shrug.payload).not.toContain('445566');

    const none = await adminGet(`/api/v1/admin/orders/${order.id}/handover-secret`);
    expect(none.statusCode).toBe(400);
    expect(none.payload).not.toContain('445566');
  });

  it('reveals the code only with a reason, and records the read before returning it', async () => {
    const order = await makePickupOrder('778899', 1);
    await grantStepUp(app, adminToken);
    const reason = 'customer at the counter cannot open the app to read the code';
    const res = await adminGet(`/api/v1/admin/orders/${order.id}/handover-secret?reason=${encodeURIComponent(reason)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.pickupCode).toBe('778899');

    const audit = await runWithoutTenant(
      () => app.prisma.auditLog.findFirst({ where: { entityId: order.id, action: 'REVEAL_PICKUP_CODE' } }),
      'test-read:handover-secret-admin',
    );
    expect(audit).toBeTruthy();
    expect(audit!.id).toBe(res.json().data.auditId);
    const changes = audit!.changes as Record<string, unknown>;
    expect(changes['reason']).toBe(reason);
    expect(changes['customerId']).toBe(customerId);
    expect(changes['attempts']).toBe(1);
    // the audit row records the circumstances, never the value
    expect(JSON.stringify(changes)).not.toContain('778899');
  });

  it('an order with no code is a 404 and is still recorded — asking for one that does not exist is probing', async () => {
    const order = await makePickupOrder(null);
    await grantStepUp(app, adminToken);
    const res = await adminGet(`/api/v1/admin/orders/${order.id}/handover-secret?reason=checking%20whether%20a%20code%20exists%20here`);
    expect(res.statusCode).toBe(404);
    const audit = await runWithoutTenant(
      () => app.prisma.auditLog.findFirst({ where: { entityId: order.id, action: 'REVEAL_PICKUP_CODE_MISS' } }),
      'test-read:handover-secret-admin',
    );
    expect(audit).toBeTruthy();
  });
});

describe('[A-15] a code that has been read is spent', () => {
  it('rotation issues a new code, clears the guessing budget, and the OLD code no longer completes the handover', async () => {
    const order = await makePickupOrder('123321', 3);
    await grantStepUp(app, adminToken);
    const rotate = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orders/${order.id}/handover-secret/rotate`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'the code was read out over a support call and is spent' },
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().data.rotated).toBe(true);
    expect(rotate.payload).not.toContain('123321');

    const after = await app.prisma.order.findUnique({ where: { id: order.id }, select: { pickupCode: true, pickupCodeAttempts: true } });
    expect(after?.pickupCode).not.toBe('123321');
    expect(after?.pickupCode).toMatch(/^\d{6}$/);
    expect(after?.pickupCodeAttempts).toBe(0);

    const audit = await runWithoutTenant(
      () => app.prisma.auditLog.findFirst({ where: { entityId: order.id, action: 'ROTATE_PICKUP_CODE' } }),
      'test-read:handover-secret-admin',
    );
    expect(audit).toBeTruthy();
    expect((audit!.changes as Record<string, unknown>)['attemptsCleared']).toBe(3);
    expect(JSON.stringify(audit!.changes)).not.toContain('123321');

    // the vendor still verifies server-side, and the old code is now wrong
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/vendor/orders/${order.id}/complete-pickup`,
      headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' },
      payload: { code: '123321' },
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error.code).toBe('WRONG_PICKUP_CODE');
    assertNoSecrets(stale.payload, 'PUT /vendor/orders/:id/complete-pickup');

    // and the new one closes it
    const fresh = await app.inject({
      method: 'PUT',
      url: `/api/v1/vendor/orders/${order.id}/complete-pickup`,
      headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' },
      payload: { code: after!.pickupCode },
    });
    expect(fresh.statusCode).toBe(200);
    assertNoSecrets(fresh.payload, 'PUT /vendor/orders/:id/complete-pickup (success)');
  });

  it('two operators rotating the same order do not hand out two different codes — the second is refused, not silently overwritten', async () => {
    const order = await makePickupOrder('909090');
    const reason = 'concurrent support calls on the same order number';

    // A real race, injected: the first rotation is held after it has read the
    // order and before it writes, the second runs to completion, then the first
    // is released. Its compare-and-set must now find a different code and
    // refuse — otherwise the operator on the phone reads out a code that the
    // second rotation has already replaced, and the customer's handover fails.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let firstReached = false;
    const first = rotatePickupCode(
      {
        prisma: app.prisma,
        failpoint: async (boundary) => {
          if (boundary === 'before-rotate') { firstReached = true; await held; }
        },
      },
      { orderId: order.id, actorId: 'race-operator-a', reason },
    );
    while (!firstReached) await new Promise((r) => setTimeout(r, 5));

    const second = await rotatePickupCode({ prisma: app.prisma }, { orderId: order.id, actorId: 'race-operator-b', reason });
    expect(second.rotated).toBe(true);
    const afterSecond = await app.prisma.order.findUnique({ where: { id: order.id }, select: { pickupCode: true } });

    release();
    await expect(first).rejects.toMatchObject({ code: 'ROTATION_RACED' });

    // the winner's code is what the customer holds; the loser wrote nothing
    const final = await app.prisma.order.findUnique({ where: { id: order.id }, select: { pickupCode: true } });
    expect(final?.pickupCode).toBe(afterSecond?.pickupCode);
    expect(final?.pickupCode).not.toBe('909090');
    const rotations = await runWithoutTenant(
      () => app.prisma.auditLog.count({ where: { entityId: order.id, action: 'ROTATE_PICKUP_CODE' } }),
      'test-read:handover-secret-admin',
    );
    expect(rotations).toBe(1);
  });
});
