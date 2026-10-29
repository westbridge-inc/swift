import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { maskPhone } from '../modules/auth/step-up';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S4-5 · privacy] The Compliance page showed every flagged mover's FULL phone number: in every screen
// share and screenshot of it, while every other console list masks it. Nobody is called from this page (it forces
// movers offline and asks for a document re-check), and the full number is only ever an audited reveal on the order
// desk (O-1). So GET /admin/compliance sends each person's phone masked the order desk's way (+592•••••1234).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';
const moverPhone = testPhone();
const reviewPhone = testPhone();

async function makeUser(firstName: string, phone: string, admin = false) {
  const user = await runWithoutTenant(() => app.prisma.user.create({ data: {
    phone, firstName, lastName: `Mask${RUN}`, status: 'ACTIVE', isPhoneVerified: true, tenantId: 'swift-default',
    ...(admin ? { roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', admin: { create: { permissions: ['*'] } } } : { roles: ['CUSTOMER'], activeRole: 'CUSTOMER' }),
  } }));
  userIds.push(user.id);
  return user;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await makeUser('Vera', testPhone(), true);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await runWithoutTenant(() => app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'compliance-mask', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
  } }));
  const mover = await makeUser('Ravi', moverPhone);
  const sampled = await makeUser('Asha', reviewPhone);
  await runWithoutTenant(async () => {
    await app.prisma.complianceViolation.create({ data: { userId: mover.id, moverKind: 'DRIVER', reason: 'docs', evidence: { documents: [] } } });
    // Due long ago, so it is first in the queue the page reads.
    await app.prisma.complianceReviewCase.create({ data: { userId: sampled.id, dueAt: new Date('2000-01-01T00:00:00Z') } });
  });
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.complianceViolation.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.complianceReviewCase.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:compliance-mask');
  await app.close();
});

describe('[ADMIN-AUDIT S4-5] the Compliance page never receives a full phone number', () => {
  it('violations and the re-verification queue carry the phone masked, the name kept', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/compliance', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as {
      openViolations: { user: { firstName: string; lastName: string; phone: string | null } }[];
      reviewQueue: { user: { firstName: string; lastName: string; phone: string | null } }[];
    };
    const v = data.openViolations.find((x) => x.user.lastName === `Mask${RUN}`)!;
    const c = data.reviewQueue.find((x) => x.user.lastName === `Mask${RUN}`)!;
    expect(v.user.firstName).toBe('Ravi');
    expect(v.user.phone).toBe(maskPhone(moverPhone));
    expect(c.user.firstName).toBe('Asha');
    expect(c.user.phone).toBe(maskPhone(reviewPhone));
    expect(res.body).not.toContain(moverPhone);
    expect(res.body).not.toContain(reviewPhone);
    expect(res.body).not.toContain(moverPhone.slice(1));
  });
});
