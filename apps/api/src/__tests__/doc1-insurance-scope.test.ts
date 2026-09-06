/**
 * [DOC-1 §3.4 · FD-DOC-6 · P2-2] V_INSURANCE_SCOPE — covers_hire_and_reward is blocking.
 *
 * At extraction: the validator PASSes on a read "true", FAILs on "false", and SKIPs
 * (undeterminable) when the field was not read — a SKIP is never a PASS, so the document
 * goes to a human. At approval: a passenger-vehicle mover's insurance is approved only
 * with the reviewer's confirmed HIRE class; PRIVATE, unconfirmed, or no check at all is
 * refused with INSURANCE_SCOPE_INSUFFICIENT. Cargo movers (motorcycle) are not gated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VALIDATOR_IMPLEMENTATIONS } from '../modules/verification/validators';
import { VALIDATOR_CATALOGUE } from '../modules/verification/doc-registry';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Decision ${RUN}: insurance reviewed`;

let app: FastifyInstance;
let adminApp: FastifyInstance;
let adminToken = '';
let adminId = '';
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-insurance-scope-test');

async function mover(n: number, vehicleType: 'CAR' | 'MOTORCYCLE') {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59271${NUM}${n}`, firstName: 'Ins', lastName: `Scope${n}`, activeRole: 'MOVER', roles: ['MOVER'], countryCode: 'GY', avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  if (vehicleType === 'CAR') {
    await system(() => app.prisma.driver.create({ data: { userId: u.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Yellow', vehicleType, licensePlate: `HC${NUM}${n}`, driverLicenseUrl: `/uploads/test/${RUN}-dl.jpg`, vehicleInsuranceUrl: `/uploads/test/${RUN}-ins.jpg` } }));
  } else {
    await system(() => app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType } }));
  }
  return u.id;
}
const pending = (userId: string) => system(() => app.prisma.verificationDocument.create({ data: { userId, role: 'MOVER', docType: 'vehicle_insurance', fileUrl: `/uploads/verification/${RUN}/${nanoid(5)}.enc`, status: 'PENDING' } }));
const approve = (docId: string, insurance?: Record<string, unknown>) => adminApp.inject({
  method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, payload: { expiresAt: new Date(Date.now() + 100 * DAY).toISOString(), ...(insurance ? { insurance } : {}) },
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const HIRE = { insurerName: 'GTM', policyNumber: `P-${RUN}`, coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.ready();
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  const a = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59271${NUM}0`, firstName: 'Ins', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = a.id; users.push(adminId);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `ins-admin-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close(); await app.close();
});

describe('[DOC-1 P2-2] V_INSURANCE_SCOPE at extraction', () => {
  const run = (present: Record<string, string>) => VALIDATOR_IMPLEMENTATIONS['validators#V_INSURANCE_SCOPE']!({ declared: [], present: new Map(Object.entries(present)), collided: false });
  it('PASSes a read "true", FAILs a read "false", and SKIPs (undeterminable) when the field was not read — never a vacuous PASS', () => {
    expect(run({ covers_hire_and_reward: 'true' })).toEqual({ status: 'PASS' });
    expect(run({ covers_hire_and_reward: 'HIRE' })).toEqual({ status: 'PASS' });
    expect(run({ covers_hire_and_reward: 'false' })).toEqual({ status: 'FAIL' });
    expect(run({ covers_hire_and_reward: 'private' })).toEqual({ status: 'FAIL' });
    expect(run({})).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
    expect(run({ covers_hire_and_reward: 'maybe' })).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('the registry row is blocking, carries the spec reason, and resolves to this implementation', () => {
    const row = VALIDATOR_CATALOGUE.find((v) => v.code === 'V_INSURANCE_SCOPE')!;
    expect(row).toMatchObject({ isBlocking: true, detailCode: 'INSURANCE_SCOPE_INSUFFICIENT', docTypeLegacy: 'vehicle_insurance', implRef: 'validators#V_INSURANCE_SCOPE' });
  });
});

describe('[DOC-1 P2-2] covers_hire_and_reward is blocking at approval', () => {
  it('a passenger-vehicle mover: no check, PRIVATE, or unconfirmed HIRE is refused with INSURANCE_SCOPE_INSUFFICIENT; confirmed HIRE approves', async () => {
    const car = await mover(1, 'CAR');
    const d1 = await pending(car);
    const none = await approve(d1.id);
    expect(none.statusCode).toBe(400); expect(none.json().error.code).toBe('INSURANCE_SCOPE_INSUFFICIENT');
    const priv = await approve(d1.id, { ...HIRE, coverageClass: 'PRIVATE', hireClassConfirmed: false });
    expect(priv.statusCode).toBe(400); expect(priv.json().error.code).toBe('INSURANCE_SCOPE_INSUFFICIENT');
    const unconfirmed = await approve(d1.id, { ...HIRE, hireClassConfirmed: false });
    expect(unconfirmed.statusCode).toBe(400);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: d1.id } }))).status).toBe('PENDING'); // still awaiting a human
    const ok = await approve(d1.id, HIRE);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ status: 'APPROVED', coverageClass: 'HIRE', hireClassConfirmed: true });
  });
  it('a cargo mover (motorcycle) is not gated on hire cover', async () => {
    const bike = await mover(2, 'MOTORCYCLE');
    const d = await pending(bike);
    expect((await approve(d.id)).statusCode).toBe(200);
  });
});
