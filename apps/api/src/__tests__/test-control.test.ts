import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { registerErrorHandler } from '../middleware/error-handler';
import { testControlEnabled, verifyLoadLease, mintLoadLease, testControlIdentity } from '../modules/ops/test-control';
import { testControlRoutes } from '../modules/ops/test-control.routes';
import { persistCheckoutReceiptInTransaction } from '../modules/order/checkout-outbox';

// ---------------------------------------------------------------------------
// [SCR-003 / SCR-004] Write-load tools cannot target production; the
// idempotency verifier reports exact cardinality.
// ---------------------------------------------------------------------------

let app: FastifyInstance; const userIds: string[] = [];
const SECRET = `tc-${nanoid(12)}`;
async function makeUser() {
  const user = await app.prisma.user.create({ data: { phone: `+5927${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Load', lastName: 'U', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'tc', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}
const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test'; process.env['TEST_CONTROL_ENABLED'] = '1'; process.env['TEST_CONTROL_SECRET'] = SECRET; process.env['BUILD_SHA'] = 'sha-test-1';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin);
  // the same conditional the server uses
  if (testControlEnabled()) await app.register(testControlRoutes, { prefix: '/api/v1' });
  await app.ready();
});
afterAll(async () => {
  delete process.env['TEST_CONTROL_ENABLED']; delete process.env['BUILD_SHA'];
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[SCR-003] the identity exists only in isolated load builds', () => {
  it('production never enables test-control, whatever the flag says; loadtest and test do only with the flag', () => {
    expect(testControlEnabled({ NODE_ENV: 'production', TEST_CONTROL_ENABLED: '1' })).toBe(false);
    expect(testControlEnabled({ NODE_ENV: 'development', TEST_CONTROL_ENABLED: '1' })).toBe(false);
    expect(testControlEnabled({ NODE_ENV: 'loadtest', TEST_CONTROL_ENABLED: '1' })).toBe(true);
    expect(testControlEnabled({ NODE_ENV: 'loadtest' })).toBe(false);
    expect(testControlEnabled({ NODE_ENV: 'test', TEST_CONTROL_ENABLED: '1' })).toBe(true);
  });
  it('an authenticated caller gets the target’s identity with a signed, expiring lease; the lease verifies only for this deployment and while unexpired', async () => {
    const { token } = await makeUser();
    expect((await get('/api/v1/test-control/identity')).statusCode).toBe(401);
    const res = await get('/api/v1/test-control/identity', token);
    expect(res.statusCode).toBe(200);
    const id = res.json().data;
    expect(id).toMatchObject({ dataClassification: 'synthetic', buildSha: 'sha-test-1', testTenant: 'swift-default' });
    expect(typeof id.deploymentId).toBe('string');
    expect(verifyLoadLease(SECRET, id.lease, id.deploymentId)).toBe(true);
    expect(verifyLoadLease(SECRET, id.lease, 'another-deployment')).toBe(false);
    expect(verifyLoadLease('wrong-secret', id.lease, id.deploymentId)).toBe(false);
    expect(verifyLoadLease(SECRET, id.lease, id.deploymentId, new Date(Date.parse(id.lease.expiresAt) + 1000))).toBe(false);
    expect(verifyLoadLease(SECRET, { ...mintLoadLease(SECRET, id.deploymentId), signature: 'f'.repeat(64) }, id.deploymentId)).toBe(false);
  });
  it('a production-mode app has no such route at all', async () => {
    const prod = Fastify({ logger: false }); registerErrorHandler(prod);
    await prod.register(prismaPlugin); await prod.register(redisPlugin); await prod.register(authPlugin);
    if (testControlEnabled({ NODE_ENV: 'production', TEST_CONTROL_ENABLED: '1' })) await prod.register(testControlRoutes, { prefix: '/api/v1' });
    await prod.ready();
    const { token } = await makeUser();
    expect((await prod.inject({ method: 'GET', url: '/api/v1/test-control/identity', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    await prod.close();
    void testControlIdentity;
  });
});

describe('[SCR-004] the read-only verifier reports exact cardinality, for the caller only', () => {
  it('a recorded command answers its order set; another user’s key is nobody’s; an unrecorded key is a 404 verdict', async () => {
    const a = await makeUser(); const b = await makeUser();
    const key = `k-${nanoid(8)}`;
    await app.prisma.$transaction((tx) => persistCheckoutReceiptInTransaction(tx, { userId: a.userId, tenantId: 'swift-default', idempotencyKey: key, requestHash: 'h'.repeat(64), orderIds: ['o1', 'o2'], result: { orders: [{ id: 'o1' }, { id: 'o2' }] } }));
    const mine = await get(`/api/v1/test-control/checkout/${key}`, a.token);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toMatchObject({ orderCount: 2, orderIds: ['o1', 'o2'] });
    expect((await get(`/api/v1/test-control/checkout/${key}`, b.token)).statusCode).toBe(404);
    expect((await get(`/api/v1/test-control/checkout/never-${nanoid(4)}`, a.token)).statusCode).toBe(404);
  });
});
