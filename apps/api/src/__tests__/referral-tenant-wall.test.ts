/**
 * [B-1 · SCOPE-299] A referral code belongs to one operator.
 *
 * Redeeming a code looked the referrer up by its code across EVERY tenant: a
 * customer of the store-review fiction (a REVIEW tenant) could redeem a real
 * production customer's code — the answer named that person, the fiction's
 * customer was linked to them, and their referral count went up — and a real
 * customer could link themselves to the fiction the same way. A code from
 * another tenant now reads exactly like an unknown code: 404 INVALID_REFERRAL,
 * nothing written, nobody named. Within one tenant nothing changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runAsSystem } from '../plugins/tenant-context';

const DAY = 86_400_000;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase();
const PRODUCTION = 'swift-default';
const REVIEW = `b1-review-${RUN.toLowerCase()}`;
const phone = () => `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const system = <T>(fn: () => Promise<T>) => runAsSystem('test-b1-referral', fn);

let app: FastifyInstance;
type Actor = { userId: string; customerId: string; code: string; token: string };
let prodReferrer: Actor;
let prodNewcomer: Actor;
let reviewReferrer: Actor;
let reviewNewcomer: Actor;
const userIds: string[] = [];

async function makeCustomer(tenantId: string, firstName: string, code: string): Promise<Actor> {
  const user = await system(() => app.prisma.user.create({ data: {
    phone: phone(), firstName, lastName: `B1${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId,
    customer: { create: { referralCode: code } },
  }, include: { customer: true } }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: `b1-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
  return { userId: user.id, customerId: user.customer!.id, code, token };
}

const redeem = (code: string, token: string) => app.inject({
  method: 'POST', url: '/api/v1/customer/referral/redeem', headers: { authorization: `Bearer ${token}` }, payload: { code },
});
const referredBy = (customerId: string) => system(() => app.prisma.customer.findUnique({ where: { id: customerId }, select: { referredBy: true } }))
  .then((c) => c?.referredBy ?? null);
const referredCount = (customerId: string) => system(() => app.prisma.customer.count({ where: { referredBy: customerId } }));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'B-1 fiction', slug: REVIEW, kind: 'REVIEW', isActive: false } });
    await app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + DAY) } });
  });
  prodReferrer = await makeCustomer(PRODUCTION, 'Prodref', `REFP${RUN}`);
  prodNewcomer = await makeCustomer(PRODUCTION, 'Prodnew', `REFQ${RUN}`);
  reviewReferrer = await makeCustomer(REVIEW, 'Demoref', `REFR${RUN}`);
  reviewNewcomer = await makeCustomer(REVIEW, 'Demonew', `REFS${RUN}`);
});

afterAll(async () => {
  await system(async () => {
    if (userIds.length) {
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.customer.updateMany({ where: { userId: { in: userIds } }, data: { referredBy: null } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app?.close();
});

describe('[B-1] a referral code is redeemed only inside its own tenant', () => {
  it('a REVIEW customer redeeming a PRODUCTION code: 404, nobody named, nothing linked, the count unchanged', async () => {
    const res = await redeem(prodReferrer.code, reviewNewcomer.token);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('INVALID_REFERRAL');
    expect(res.body).not.toContain('Prodref');
    expect(await referredBy(reviewNewcomer.customerId)).toBeNull();
    expect(await referredCount(prodReferrer.customerId)).toBe(0);
  });

  it('a PRODUCTION customer redeeming a REVIEW code: 404 and nothing linked', async () => {
    const res = await redeem(reviewReferrer.code.toLowerCase(), prodNewcomer.token);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('INVALID_REFERRAL');
    expect(res.body).not.toContain('Demoref');
    expect(await referredBy(prodNewcomer.customerId)).toBeNull();
    expect(await referredCount(reviewReferrer.customerId)).toBe(0);
  });

  it('inside one tenant a code still redeems (case-insensitive) and links the referrer', async () => {
    const res = await redeem(prodReferrer.code.toLowerCase(), prodNewcomer.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.referrerName).toBe('Prodref');
    expect(await referredBy(prodNewcomer.customerId)).toBe(prodReferrer.customerId);
    expect(await referredCount(prodReferrer.customerId)).toBe(1);
  });
});
