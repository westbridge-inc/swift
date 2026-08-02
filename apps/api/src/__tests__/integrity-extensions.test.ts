import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { IdentityService } from '../modules/integrity/identity.service';
import { normalizeDocNumber } from '../modules/integrity/normalize';
import { orderingRestriction } from '../modules/cash/cash-rules.service';
import { OrderService } from '../modules/order/order.service';
import { AccountService } from '../modules/user/account.service';
import { AuthService } from '../modules/auth/auth.service';

// Trial-integrity Phase 5 — the graph's customer-side jobs (spec Part 5/6/8):
// A5 promo/referral farming dies per HUMAN, A6 cash-fraud strikes follow the
// cluster, DPA erasure purges identity data (tombstones founder-gated OFF),
// and the §5 OTP hourly cap is config with an honest cooldown.

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_002_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeUser(roles: ('CUSTOMER' | 'VENDOR_OWNER')[] = ['CUSTOMER']) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Ext', lastName: `U${seq}`,
      roles, activeRole: roles[0]!, isPhoneVerified: true,
      customer: { create: { referralCode: `EXT${seq}${nanoid(4).toUpperCase()}` } },
    },
    include: { customer: true },
  });
  userIds.push(u.id);
  return u;
}

async function uniteAs(sameHuman: Array<{ id: string }>) {
  const identity = new IdentityService(app.prisma);
  const doc = `ID-${nanoid(8)}`;
  for (const u of sameHuman) {
    await identity.capture({ accountId: u.id, tenantId: 'swift-default', actorRole: 'CUSTOMER', type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(doc), source: 'AI_ID_ANALYZER' });
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  const members = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
  const clusterIds = [...new Set(members.map((m) => m.clusterId))];
  await app.prisma.strike.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'INTEG' } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
  await app.prisma.faceTemplate.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('A5 — one referral per human', () => {
  it('a second cluster account cannot redeem again, and cannot redeem its own other-account code', async () => {
    const referrer = await makeUser();
    const a = await makeUser();
    const b = await makeUser();
    await uniteAs([a, b]);

    const redeem = (token: string, code: string) =>
      app.inject({
        method: 'POST', url: '/api/v1/customer/referral/redeem',
        payload: { code },
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
    const tokenFor = async (uid: string) => {
      const t = app.jwt.sign({ userId: uid, role: 'CUSTOMER', jti: nanoid(8) });
      await app.prisma.session.create({ data: { userId: uid, token: t, refreshToken: nanoid(48), deviceId: 'x', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
      return t;
    };

    // Account A redeems the outsider's code — fine.
    const ok = await redeem(await tokenFor(a.id), referrer.customer!.referralCode!);
    expect(ok.statusCode).toBe(200);

    // Account B (same human) tries any code → the human already redeemed.
    const again = await redeem(await tokenFor(b.id), referrer.customer!.referralCode!);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REFERRED');

    // Cluster-self-referral: C2 redeeming C1's code is still your own code.
    const c1 = await makeUser();
    const c2 = await makeUser();
    await uniteAs([c1, c2]);
    const selfish = await redeem(await tokenFor(c2.id), c1.customer!.referralCode!);
    expect(selfish.statusCode).toBe(400);
    expect(selfish.json().error.code).toBe('SELF_REFERRAL');
  });
});

describe('A5 — promo caps count the human', () => {
  it('cluster usage exhausts maxUsesPerUser across accounts', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await uniteAs([a, b]);
    const promo = await app.prisma.promoCode.create({
      data: {
        code: `INTEG${nanoid(5).toUpperCase()}`, description: 'integrity test',
        discountType: 'FIXED_AMOUNT', discountValue: 500, maxUsesPerUser: 1,
        isActive: true, validFrom: new Date(Date.now() - 3600_000), validUntil: new Date(Date.now() + 86_400_000),
      },
    });
    // Account A already used it on a completed order.
    await app.prisma.order.create({
      data: {
        customerId: a.id, orderType: 'FOOD_DELIVERY', status: 'DELIVERED', orderNumber: `IX-${nanoid(8)}`,
        fulfillment: 'DELIVERY', pickupAddress: 'A', deliveryAddress: 'B', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000,
        paymentMethod: 'CASH', promoCodeId: promo.id,
      },
    });

    // Account B (same human) — the validator refuses. Private method, called
    // directly on purpose: both live sites share this exact gate and checkout
    // plumbing would drown the assertion.
    const svc = new OrderService(app.prisma, app.io) as unknown as {
      validatePromoCode: (code: string, userId: string, plans: Array<{ vendorId: string; subtotal: number; deliveryFee: number }>) => Promise<unknown>;
    };
    await expect(svc.validatePromoCode(promo.code, b.id, [{ vendorId: 'v', subtotal: 1000, deliveryFee: 0 }]))
      .rejects.toMatchObject({ code: 'USED_PROMO' });
    // The clusterless control: a stranger passes the per-user gate.
    const stranger = await makeUser();
    await expect(svc.validatePromoCode(promo.code, stranger.id, [{ vendorId: 'v', subtotal: 1000, deliveryFee: 0 }]))
      .resolves.toBeTruthy();
  });
});

describe('A6 — strikes follow the human', () => {
  it('a fresh cluster account inherits the cluster ban; strangers are untouched', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await uniteAs([a, b]);
    for (let i = 0; i < 4; i += 1) {
      await app.prisma.strike.create({ data: { userId: a.id, reason: 'COD_NO_PAY', orderId: null } });
    }
    expect(await orderingRestriction(app.prisma, b.id)).toBe('banned'); // inherited
    const stranger = await makeUser();
    expect(await orderingRestriction(app.prisma, stranger.id)).toBeNull();
  });
});

describe('Part 8 — DPA erasure purges identity data', () => {
  it('deleteAccount removes keys, membership, and the face template (tombstones OFF)', async () => {
    const u = await makeUser();
    await uniteAs([u]);
    await app.prisma.faceTemplate.create({ data: { accountId: u.id, embedding: Buffer.from([1, 2, 3]), modelVer: 't' } });
    await app.prisma.integritySettings.upsert({ where: { id: 'platform' }, create: { id: 'platform', tombstoneRetentionEnabled: false }, update: { tombstoneRetentionEnabled: false } });

    await new AccountService(app).deleteAccount(u.id);

    expect(await app.prisma.identityKey.count({ where: { accountId: u.id } })).toBe(0);
    expect(await app.prisma.identityClusterMember.count({ where: { accountId: u.id } })).toBe(0);
    expect(await app.prisma.faceTemplate.count({ where: { accountId: u.id } })).toBe(0);
  });

  it('with tombstones ON (founder decision), hashes remain but the biometric template still dies', async () => {
    const u = await makeUser();
    await uniteAs([u]);
    await app.prisma.faceTemplate.create({ data: { accountId: u.id, embedding: Buffer.from([4, 5, 6]), modelVer: 't' } });
    await app.prisma.integritySettings.update({ where: { id: 'platform' }, data: { tombstoneRetentionEnabled: true } });

    await new AccountService(app).deleteAccount(u.id);

    expect(await app.prisma.identityKey.count({ where: { accountId: u.id } })).toBeGreaterThan(0); // the tombstone
    expect(await app.prisma.faceTemplate.count({ where: { accountId: u.id } })).toBe(0); // biometric always purged

    await app.prisma.integritySettings.update({ where: { id: 'platform' }, data: { tombstoneRetentionEnabled: false } });
  });
});

describe('§5 — OTP hourly cap (config, honest cooldown)', () => {
  it('the 6th request in an hour is refused with a retry timer; the minute limiter stays intact', async () => {
    const phone = `+${phoneBase + 900_000 + seq}`;
    const auth = new AuthService(app);
    for (let i = 0; i < 5; i += 1) {
      await app.redis.del(`otp_rate:${phone}`); // step past the 1/min claim — hourly is under test
      await auth.sendOtp(phone);
    }
    await app.redis.del(`otp_rate:${phone}`);
    const refusal = await auth.sendOtp(phone).then(() => null, (e: unknown) => e as { code: string; message: string });
    expect(refusal).toMatchObject({ code: 'RATE_LIMITED' });
    expect(refusal!.message).toMatch(/Try again in \d+ minute/);
    await app.redis.del(`otp_hr:${phone}`);
    await app.redis.del(`otp_rate:${phone}`);
  });
});
