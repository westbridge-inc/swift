import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-TRUST F16] A referral code is matched as a code, never as a pattern.
// The lookup is case-insensitive (Postgres ILIKE), where % and _ are
// wildcards: a "code" made of them used to match, and credit, another
// customer. Every code Swift issues is letters and digits, so anything else is
// refused before the lookup with the unknown-code answer; and redeeming is
// limited per account like promo checks.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const REF_CODE = `F16REF${Date.now().toString(36).toUpperCase()}${nanoid(4).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase()}`;

let app: FastifyInstance;
const userIds: string[] = [];
let ip = 20;

async function makeCustomer(referralCode?: string) {
  const user = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Ref', lastName: 'Shape', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: referralCode ? { referralCode } : {} },
    },
    include: { customer: true },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'f16', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { token, customerId: user.customer!.id };
}

const redeem = (code: string, token: string) => {
  ip += 1;
  return app.inject({
    method: 'POST', url: '/api/v1/customer/referral/redeem',
    headers: { authorization: `Bearer ${token}` }, payload: { code }, remoteAddress: `198.51.100.${ip}`,
  });
};
const referredBy = async (customerId: string) => (await app.prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { referredBy: true } })).referredBy;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await makeCustomer(REF_CODE);
});

afterAll(async () => {
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[SEC-TRUST F16] a referral code is matched exactly', () => {
  it.each([
    ['a prefix and %', `${REF_CODE.slice(0, -3)}%`],
    ['one character as _', `${REF_CODE.slice(0, -1)}_`],
    ['all wildcards', '%%%'],
  ])('%s: refused as an unknown code, nobody credited', async (_label, code) => {
    const referee = await makeCustomer();
    const res = await redeem(code, referee.token);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('INVALID_REFERRAL');
    expect(await referredBy(referee.customerId)).toBeNull();
  });

  it('the real code still works, in any case', async () => {
    const referee = await makeCustomer();
    const res = await redeem(REF_CODE.toLowerCase(), referee.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(await referredBy(referee.customerId)).not.toBeNull();
  });

  it('an account trying code after code is slowed down', async () => {
    const guesser = await makeCustomer();
    const answers: number[] = [];
    for (let i = 0; i < 12; i += 1) answers.push((await redeem(`NOPE${i}X${nanoid(6).replace(/[^a-zA-Z0-9]/g, '0')}`, guesser.token)).statusCode);
    expect(answers.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(answers.slice(10)).toEqual([429, 429]);
  });
});
