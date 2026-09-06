/**
 * [TA-S1-008] Partner agreement acceptance is REQUIRED at the API authority.
 *
 * The checkbox rode the request as an optional boolean; a client that never showed the
 * agreement could provision a Rider/Driver/Vendor with no consent row. Now the route refuses
 * without acceptance — before any provisioning, any role change, any row — and the consent
 * ledger still records exactly what was ticked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { partnerRoutes, AGREEMENT_REQUIRED } from '../modules/partner/partner.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

const NUM = String(Date.now()).slice(-5);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'partner-agreement-required-test');
let app: FastifyInstance;
const users: string[] = [];

async function customer(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59275${NUM}${n}`, firstName: 'Agree', lastName: `Ment${n}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, customer: { create: {} } } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(24), deviceId: `agr-${NUM}-${n}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } as never });
  return { id: u.id, token };
}
const become = (token: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/partner/become', payload, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false }); registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
});
afterAll(async () => {
  await system(async () => {
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[TA-S1-008] the agreement is a precondition of the authority', () => {
  it('test_partner_agreement_required_at_api: without acceptance nothing is provisioned, no role moves, no consent row is written', async () => {
    const c = await customer(1);
    for (const payload of [{ role: 'MOVER', vehicleType: 'MOTORCYCLE' }, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: false }]) {
      const res = await become(c.token, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe(AGREEMENT_REQUIRED);
    }
    const after = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: c.id }, select: { roles: true, rider: { select: { id: true } } } }));
    expect(after.rider).toBeNull();
    expect(after.roles).toEqual(['CUSTOMER']);
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: c.id, documentType: 'driver_agreement' } }))).toBe(0);
  });

  it('with acceptance the partner is provisioned and the agreement consent is on the ledger, in the same request', async () => {
    const c = await customer(2);
    const res = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true });
    expect([200, 201]).toContain(res.statusCode);
    expect(await system(() => app.prisma.rider.count({ where: { userId: c.id } }))).toBe(1);
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: c.id, documentType: 'driver_agreement', action: 'granted' } }))).toBe(1);
  });
});
