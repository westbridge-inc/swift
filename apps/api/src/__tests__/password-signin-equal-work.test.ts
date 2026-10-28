import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-TRUST F13] Password sign-in answers an unknown account, an account with
// no password and a wrong password the same way — and now does the same work
// for each: one comparison AND one locked database transaction. Before, only a
// real account with a password ran the transaction, so the extra time told an
// account that has a password from one that does not.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const phones: string[] = [];
let ip = 10;

async function createUser(password: string | null) {
  const phone = testPhone();
  phones.push(phone);
  await app.prisma.user.create({ data: {
    phone, firstName: 'Equal', lastName: 'Work', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE',
    isPhoneVerified: true, passwordHash: password === null ? null : await bcrypt.hash(password, 4), customer: { create: {} },
  } });
  return phone;
}

/** One failed sign-in; returns its answer and how many database transactions it ran. */
async function failedSignIn(phone: string) {
  const spy = vi.spyOn(app.prisma, '$transaction');
  try {
    ip += 1;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/password/login',
      payload: { phone, password: 'not-the-password-1' },
      headers: { 'content-type': 'application/json' }, remoteAddress: `198.51.100.${ip}`,
    });
    return { status: res.statusCode, code: res.json().error?.code ?? res.json().code, transactions: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(async () => {
  if (phones.length) await app.prisma.user.deleteMany({ where: { phone: { in: phones } } });
  await app.close();
});

describe('[SEC-TRUST F13] every failed password sign-in does the same work', () => {
  it('a wrong password, an unknown account and an account without a password each run one locked transaction and give the same answer', async () => {
    const withPassword = await createUser('the-real-password-1');
    const withoutPassword = await createUser(null);
    const unknown = testPhone();

    const wrong = await failedSignIn(withPassword);
    const none = await failedSignIn(withoutPassword);
    const nobody = await failedSignIn(unknown);

    for (const answer of [wrong, none, nobody]) {
      expect(answer.status).toBe(401);
      expect(answer.code).toBe('INVALID_CREDENTIALS');
    }
    expect(wrong.transactions).toBe(1);
    expect(none.transactions).toBe(wrong.transactions);
    expect(nobody.transactions).toBe(wrong.transactions);
  });

  it('the mirrored work changes nothing on an account without a password', async () => {
    const phone = await createUser(null);
    await failedSignIn(phone);
    const row = await app.prisma.user.findUniqueOrThrow({ where: { phone }, select: { failedLoginAttempts: true, lockedUntil: true, passwordHash: true } });
    expect(row).toEqual({ failedLoginAttempts: 0, lockedUntil: null, passwordHash: null });
  });
});
