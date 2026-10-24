/**
 * [REVIEW-PARTNER · L04] A store-review demo login is SHARED by every reviewer
 * who reads the store notes. Setting or changing its password would let one
 * reviewer lock the others out of the demo (and a new credential ends the
 * other sessions). So a REVIEW-tenant account can neither set nor reset a
 * password:
 *  - /password/set answers with a plain demo refusal and changes nothing;
 *  - /password/reset answers exactly as an invalid code does (a pre-auth path
 *    discloses nothing about the account) and changes nothing.
 * A production account keeps both, unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { authRoutes } from '../modules/auth/auth.routes';
import { storePasswordResetOtp } from '../modules/auth/signup-continuation';
import { grantStepUp } from './helpers/step-up';
import { AuthService } from '../modules/auth/auth.service';
import { devChannelLog } from '../providers/notifications/channels';
import { requestPasswordResetOtp } from './helpers/otp';
import { REVIEW_DEMO_NO_CREDENTIALS } from '../modules/review/demo-policy';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REVIEW = `review-pw-${RUN}`;
const PHONE_BASE = 7000 + Math.floor(Math.random() * 2000);
let seq = 0;
const nextPhone = () => `+592000${String(PHONE_BASE + seq++).padStart(4, '0')}`.slice(0, 11);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:review-demo-password');

let app: FastifyInstance;
const userIds: string[] = [];
const phones: string[] = [];

async function account(tenantId: string | undefined) {
  const phone = nextPhone();
  phones.push(phone);
  const user = await system(() => app.prisma.user.create({ data: {
    phone, firstName: 'Demo', lastName: 'Login', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true,
    passwordHash: 'unchanged-hash-marker', ...(tenantId ? { tenantId } : {}),
  } }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `revpw-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
  return { id: user.id, phone, token };
}
const hashOf = async (userId: string) => (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } }))).passwordHash;
const sessionsOf = (userId: string) => app.prisma.session.count({ where: { userId } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Password demo fiction', slug: REVIEW, kind: 'REVIEW', isActive: true } });
    await app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + 86_400_000) } });
  });
});

afterAll(async () => {
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await system(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  for (const phone of phones) await app.redis.del(`otp_rate:${phone}`).catch(() => {});
  await app.close();
});

describe('[REVIEW-PARTNER] a shared store-review demo login cannot set or reset a password', () => {
  it('a REVIEW account without a credential row receives no reset text', async () => {
    const demo = await account(REVIEW);
    const start = devChannelLog.length;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password/reset-request', payload: { phone: demo.phone } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ message: 'OTP sent successfully', expiresIn: 300 });
    expect(devChannelLog.slice(start).filter((entry) => entry.to === demo.phone)).toHaveLength(0);
    expect(await hashOf(demo.id)).toBe('unchanged-hash-marker');
  });

  it('the service itself refuses a REVIEW password change with a valid step-up', async () => {
    const demo = await account(REVIEW);
    await grantStepUp(app, demo.token);
    const session = await app.prisma.session.findUniqueOrThrow({ where: { token: demo.token } });
    const result = await new AuthService(app).setPassword(demo.id, session.id, 'another demo password')
      .then(() => ({ changed: true }), (error: { code: string }) => ({ code: error.code }));
    expect(result).toEqual({ code: REVIEW_DEMO_NO_CREDENTIALS });
    expect(await hashOf(demo.id)).toBe('unchanged-hash-marker');
    expect(await sessionsOf(demo.id)).toBe(1);
  });

  it('/password/set: a demo account gets the plain demo refusal; its password and sessions are untouched', async () => {
    const demo = await account(REVIEW);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password/set', headers: { authorization: `Bearer ${demo.token}` }, payload: { password: 'a new demo password' } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe(REVIEW_DEMO_NO_CREDENTIALS);
    expect(res.json().error.message).toMatch(/App Review demo/);
    expect(await hashOf(demo.id)).toBe('unchanged-hash-marker');
    expect(await sessionsOf(demo.id)).toBe(1);
  });

  it('/password/reset: a demo account is answered exactly as an invalid code; its password is untouched', async () => {
    const demo = await account(REVIEW);
    await storePasswordResetOtp(app.redis, demo.phone, '864201');
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/password/reset', payload: { phone: demo.phone, code: '864201', newPassword: 'a new demo password' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_OTP');
    expect(await hashOf(demo.id)).toBe('unchanged-hash-marker');
    expect(await sessionsOf(demo.id)).toBe(1);
  });

  it('a production account still sets and resets its password', async () => {
    const real = await account(undefined);
    await grantStepUp(app, real.token);
    const set = await app.inject({ method: 'POST', url: '/api/v1/auth/password/set', headers: { authorization: `Bearer ${real.token}` }, payload: { password: 'a real new password' } });
    expect(set.statusCode, set.body).toBe(200);
    const afterSet = await hashOf(real.id);
    expect(afterSet).not.toBe('unchanged-hash-marker');
    const code = await requestPasswordResetOtp(app, real.phone);
    const reset = await app.inject({ method: 'POST', url: '/api/v1/auth/password/reset', payload: { phone: real.phone, code, newPassword: 'another real password' } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await hashOf(real.id)).not.toBe(afterSet);
  });
});
