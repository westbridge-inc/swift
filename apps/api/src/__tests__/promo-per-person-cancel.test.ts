import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { customAlphabet, nanoid } from 'nanoid';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { OrderStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { IdentityService } from '../modules/integrity/identity.service';
import { normalizeDocNumber } from '../modules/integrity/normalize';
import { OrderService } from '../modules/order/order.service';
import { promoUsesByPersonWhere } from '../modules/promo/promo-uses';

// ---------------------------------------------------------------------------
// [Row 29 · DS109 S3] The per-person promo cap counted only orders that were
// not CANCELLED or REFUNDED, so a customer could place an order with a
// one-per-person code, cancel it themselves and place again, as often as they
// liked. The rule now (delegated ruling, recorded in the PR):
//   - an order the customer (or anyone in their identity cluster) cancelled
//     COUNTS: their own cancel uses the code;
//   - an order cancelled by someone else (the store, Swift, the system: no
//     rider, food too old, payment window) does NOT count: the customer did
//     not choose to give it up;
//   - a REFUNDED order does not count (a refund is decided by the store or
//     Swift, never by the customer alone).
// ONE predicate, used by the preview, the cart check and the checkout lock.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
// Referral codes are letters and digits only (customer.routes REFERRAL_CODE_SHAPE); nanoid() can give '-' or '_'.
const codeSuffix = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 4);
const phoneBase = 592_003_100_000 + Math.floor(Math.random() * 800_000);

async function makeUser() {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Promo', lastName: `P${seq}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: { referralCode: `PPC${seq}${codeSuffix()}` } },
    },
  });
  userIds.push(u.id);
  return u;
}

async function makePromo() {
  return app.prisma.promoCode.create({
    data: {
      code: `PPC${nanoid(6).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase()}`, description: 'per-person test',
      discountType: 'FIXED_AMOUNT', discountValue: 500, maxUsesPerUser: 1,
      isActive: true, validFrom: new Date(Date.now() - 3600_000), validUntil: new Date(Date.now() + 86_400_000),
    },
  });
}

/** An order created directly in its final state (an INSERT is not a status change). */
async function orderWith(customerId: string, promoCodeId: string, status: OrderStatus, cancelledBy: string | null = null) {
  return app.prisma.order.create({
    data: {
      customerId, orderType: 'FOOD_DELIVERY', status, orderNumber: `PPC-${nanoid(8)}`,
      fulfillment: 'DELIVERY', pickupAddress: 'A', deliveryAddress: 'B', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000,
      paymentMethod: 'CASH', promoCodeId,
      ...(status === 'CANCELLED' ? { cancelledAt: new Date(), cancelledBy } : {}),
    },
  });
}

type Validator = { validatePromoCode: (code: string, userId: string, plans: Array<{ vendorId: string; subtotal: number; deliveryFee: number }>) => Promise<unknown> };
const validator = () => new OrderService(app.prisma, app.io) as unknown as Validator;
const PLANS = [{ vendorId: 'v', subtotal: 1000, deliveryFee: 0 }];

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
  await app.ready();
});

afterAll(async () => {
  const members = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
  const clusterIds = [...new Set(members.map((m) => m.clusterId))];
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'PPC' } } });
  await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[Row 29] cancel and re-order does not reset the per-person promo cap', () => {
  it('the customer cancelled their own promo order: the code is used', async () => {
    const a = await makeUser();
    const promo = await makePromo();
    await orderWith(a.id, promo.id, 'CANCELLED', a.id);
    expect(await app.prisma.order.count({ where: promoUsesByPersonWhere([a.id], promo.id) })).toBe(1);
    await expect(validator().validatePromoCode(promo.code, a.id, PLANS)).rejects.toMatchObject({ code: 'USED_PROMO' });
  });

  it('another account of the same person cancelled it: still used (the cap counts the human)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const identity = new IdentityService(app.prisma);
    const doc = normalizeDocNumber(`ID-${nanoid(8)}`);
    for (const u of [a, b]) await identity.capture({ accountId: u.id, actorRole: 'CUSTOMER', type: 'ID_DOC_NUMBER', normalizedValue: doc, source: 'AI_ID_ANALYZER' });
    const promo = await makePromo();
    await orderWith(b.id, promo.id, 'CANCELLED', b.id);
    await expect(validator().validatePromoCode(promo.code, a.id, PLANS)).rejects.toMatchObject({ code: 'USED_PROMO' });
  });

  it('the store, Swift or the system cancelled it: the code is still the customer\'s to use', async () => {
    const storeUser = await makeUser();
    for (const by of ['system', storeUser.id, null]) {
      const a = await makeUser();
      const promo = await makePromo();
      await orderWith(a.id, promo.id, 'CANCELLED', by);
      expect(await app.prisma.order.count({ where: promoUsesByPersonWhere([a.id], promo.id) }), String(by)).toBe(0);
      await expect(validator().validatePromoCode(promo.code, a.id, PLANS)).resolves.toBeTruthy();
    }
  });

  it('a refunded order does not use the code; a live or delivered one does', async () => {
    const a = await makeUser();
    const promo = await makePromo();
    await orderWith(a.id, promo.id, 'REFUNDED');
    await expect(validator().validatePromoCode(promo.code, a.id, PLANS)).resolves.toBeTruthy();
    await orderWith(a.id, promo.id, 'DELIVERED');
    await expect(validator().validatePromoCode(promo.code, a.id, PLANS)).rejects.toMatchObject({ code: 'USED_PROMO' });
  });
});

describe('[Row 29] one predicate at every per-person promo check', () => {
  const SRC = join(process.cwd(), 'src');
  const sites: Array<[string, number]> = [
    ['modules/order/order.service.ts', 2], // checkout lock + validatePromoCode
    ['modules/user/customer.routes.ts', 1], // POST /promo/validate
  ];

  it.each(sites)('%s counts per-person uses only through promoUsesByPersonWhere', (file, n) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(text.match(/promoUsesByPersonWhere\(/g)?.length ?? 0).toBe(n);
    // The old exclusion, written inline next to a promo code, is gone.
    expect(text).not.toMatch(/promoCodeId[^\n]*status: \{ notIn: \['CANCELLED', 'REFUNDED'\] \}/);
  });
});
