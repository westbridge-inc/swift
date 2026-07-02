import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Referral — real attribution. Redeeming a code writes Customer.referredBy and
// shows up in the referrer's profile count. Failure paths first (unknown code,
// self-referral, double redemption), then the happy path. Owns phone prefix
// +59200266 so it can run in parallel with the rest of the suite.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PREFIX = '+59200266';
const REF_CODE = `REFTEST${Date.now().toString(36).toUpperCase()}`;

let app: FastifyInstance;
let referrerToken: string;
let refereeToken: string;
let referrerCustomerId: string;

async function purge() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeCustomer(phone: string, referralCode?: string) {
  const user = await app.prisma.user.create({
    data: {
      phone,
      firstName: 'Ref',
      lastName: 'Tester',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: referralCode ? { referralCode } : {} },
    },
    include: { customer: true },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'reftest',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { user, token, customer: user.customer! };
}

const redeem = (code: string, tok: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/customer/referral/redeem',
    headers: { authorization: `Bearer ${tok}` },
    payload: { code },
  });

const profile = (tok: string) =>
  app.inject({ method: 'GET', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${tok}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  await purge();
  const referrer = await makeCustomer(`${PREFIX}1`, REF_CODE);
  referrerToken = referrer.token;
  referrerCustomerId = referrer.customer.id;
  const referee = await makeCustomer(`${PREFIX}2`);
  refereeToken = referee.token;
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('Referral redemption', () => {
  it('rejects an unknown code (404 INVALID_REFERRAL)', async () => {
    const res = await redeem('NOPE-NOT-A-REAL-CODE', refereeToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('INVALID_REFERRAL');
  });

  it('rejects using your own code (400 SELF_REFERRAL)', async () => {
    const res = await redeem(REF_CODE, referrerToken);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SELF_REFERRAL');
  });

  it('redeems a valid code (case-insensitive) and writes referredBy', async () => {
    const res = await redeem(REF_CODE.toLowerCase(), refereeToken);
    expect(res.statusCode).toBe(200);
    const referee = await app.prisma.customer.findFirst({ where: { user: { phone: `${PREFIX}2` } } });
    expect(referee?.referredBy).toBe(referrerCustomerId);
  });

  it('shows the referral in the referrer’s profile count', async () => {
    const res = await profile(referrerToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.customer.referredCount).toBe(1);
  });

  it('rejects a second redemption (409 ALREADY_REFERRED)', async () => {
    const res = await redeem(REF_CODE, refereeToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_REFERRED');
  });
});
