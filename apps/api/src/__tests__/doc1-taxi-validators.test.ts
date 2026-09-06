/**
 * [DOC-1 §3.7 · LEGAL-CONFLICT-1 · DOC-INV-44 · E2E-DOC-2 · P3-3] test_taxi_validators
 *
 * Only the corroborated plate rule is enforced: a taxi (a Driver profile) carries an H
 * mark. Every other prefix letter is a disputed fact and is never judged; delivery
 * movers (Rider profiles) are exempt from the H-plate and Corporate Yellow rules. The
 * validators judge what was read and SKIP what was not (a SKIP is never a PASS); the
 * cross-match anchors on the plate the mover registered. At approval, a taxi's vehicle
 * document on a non-H plate is refused with WRONG_PLATE_CLASS; fixing the plate and
 * resubmitting approves (E2E-DOC-2).
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
import { VALIDATOR_IMPLEMENTATIONS, NO_CONTEXT, type ValidatorContext } from '../modules/verification/validators';
import { VALIDATOR_CATALOGUE } from '../modules/verification/doc-registry';
import { ACTOR_FACING_CATEGORY, REJECTION_REASON_CODES } from '../modules/verification/verification.service';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Decision ${RUN}: taxi documents reviewed`;
const TAXI: ValidatorContext = { taxi: true, registrationMark: `HB${NUM}`, docType: 'vehicle_registration', bucket: 'VEHICLE' };
const TAXI_LICENCE: ValidatorContext = { ...{ taxi: true, registrationMark: `HB${NUM}`, docType: 'drivers_licence', bucket: 'PERSONAL' } };
const DELIVERY: ValidatorContext = { taxi: false, registrationMark: `PAB${NUM}`, docType: 'vehicle_registration', bucket: 'VEHICLE' };

let app: FastifyInstance;
let adminApp: FastifyInstance;
let adminToken = '';
let adminId = '';
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-taxi-validators-test');

async function mover(n: number, kind: 'taxi' | 'delivery', plate: string) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59270${NUM}${n}`, firstName: 'Taxi', lastName: `Val${n}`, activeRole: 'MOVER', roles: ['MOVER'], countryCode: 'GY', avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  if (kind === 'taxi') await system(() => app.prisma.driver.create({ data: { userId: u.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Yellow', vehicleType: 'CAR', licensePlate: plate, driverLicenseUrl: `/uploads/test/${RUN}-dl.jpg`, vehicleInsuranceUrl: `/uploads/test/${RUN}-ins.jpg` } }));
  else await system(() => app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'CAR', licensePlate: plate } }));
  return u.id;
}
const pending = (userId: string, docType = 'vehicle_registration') => system(() => app.prisma.verificationDocument.create({ data: { userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/${RUN}/${nanoid(5)}.enc`, status: 'PENDING' } }));
const admin = (method: 'PUT', url: string, payload: Record<string, unknown>) => adminApp.inject({
  method, url: `/api/v1/admin${url}`, payload, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const approve = (docId: string) => admin('PUT', `/verification/${docId}/approve`, { expiresAt: new Date(Date.now() + 100 * DAY).toISOString() });
const run = (impl: string, present: Record<string, string>, context: ValidatorContext = NO_CONTEXT) =>
  VALIDATOR_IMPLEMENTATIONS[`validators#${impl}`]!({ declared: [], present: new Map(Object.entries(present)), collided: false, context });

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
    phone: `+59270${NUM}0`, firstName: 'Taxi', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = a.id; users.push(adminId);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `taxi-admin-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close(); await app.close();
});

describe('[DOC-1 P3-3] the taxi validators judge what was read, SKIP what was not, and only for taxis', () => {
  it('V_PLATE_CLASS: H passes for a taxi, any other letter fails (never judged for delivery, never judged unread)', () => {
    expect(run('V_PLATE_CLASS', { registration_mark: 'HB 1234' }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'hc-4321' }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'PAB 1234' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'GAA 1' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_PLATE_CLASS', { registration_mark: 'PAB 1234' }, DELIVERY)).toEqual({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('V_PLATE_CLASS', {}, TAXI)).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('V_VEHICLE_COLOUR: Corporate Yellow passes for a taxi; anything else fails; delivery and unread are SKIPs', () => {
    expect(run('V_VEHICLE_COLOUR', { colour: 'Corporate Yellow' }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_VEHICLE_COLOUR', { colour: 'White' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_VEHICLE_COLOUR', { colour: 'White' }, DELIVERY)).toEqual({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('V_VEHICLE_COLOUR', {}, TAXI)).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('V_PLATE_CROSS_MATCH: the read mark must be the registered mark, compared normalised; no anchor or nothing read is a SKIP', () => {
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: `hb ${NUM}` }, TAXI)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: 'HB 0000' }, TAXI)).toEqual({ status: 'FAIL' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: `PAB-${NUM}` }, DELIVERY)).toEqual({ status: 'PASS' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: 'HB 1' }, { ...TAXI, registrationMark: null })).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
    expect(run('V_PLATE_CROSS_MATCH', { registration_mark: 'HB 1' }, { ...TAXI, bucket: 'PERSONAL', docType: 'national_id' })).toEqual({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('V_PLATE_CROSS_MATCH', {}, TAXI)).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('V_LICENCE_CLASS: the hire-car class must be among the classes for a taxi; delivery and unread are SKIPs', () => {
    expect(run('V_LICENCE_CLASS', { classes: 'B, H' }, TAXI_LICENCE)).toEqual({ status: 'PASS' });
    expect(run('V_LICENCE_CLASS', { classes: 'B' }, TAXI_LICENCE)).toEqual({ status: 'FAIL' });
    expect(run('V_LICENCE_CLASS', { classes: 'B' }, { ...TAXI_LICENCE, taxi: false })).toEqual({ status: 'SKIP', detailCode: 'NOT_APPLICABLE' });
    expect(run('V_LICENCE_CLASS', {}, TAXI_LICENCE)).toEqual({ status: 'SKIP', detailCode: 'UNDETERMINABLE' });
  });
  it('the catalogue rows are blocking, carry the spec reasons, resolve to these implementations, and the licence rule is scoped to the licence by the registry', () => {
    expect(VALIDATOR_CATALOGUE.find((v) => v.code === 'V_LICENCE_CLASS')!.docTypeLegacy).toBe('drivers_licence');
    for (const [code, detail] of [['V_PLATE_CLASS', 'WRONG_PLATE_CLASS'], ['V_VEHICLE_COLOUR', 'VEHICLE_COLOUR_NON_COMPLIANT'], ['V_LICENCE_CLASS', 'LICENCE_CLASS_MISMATCH'], ['V_PLATE_CROSS_MATCH', 'PLATE_CROSS_MISMATCH']] as const) {
      expect(VALIDATOR_CATALOGUE.find((v) => v.code === code), code).toMatchObject({ isBlocking: true, detailCode: detail, implRef: `validators#${code}` });
    }
    expect(REJECTION_REASON_CODES).toContain('WRONG_PLATE_CLASS');
    expect(ACTOR_FACING_CATEGORY['WRONG_PLATE_CLASS']).toBe('REQUIREMENT');
  });
});

describe('[DOC-1 P3-3 · E2E-DOC-2] a taxi on a P plate is blocked with WRONG_PLATE_CLASS; the corrected plate goes through', () => {
  it('approval of a taxi\'s vehicle document is refused on a non-H plate, allowed on H; a delivery car on a P plate is not gated', async () => {
    const taxi = await mover(1, 'taxi', `PAB ${NUM.slice(-4)}`);
    const d = await pending(taxi);
    const blocked = await approve(d.id);
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe('WRONG_PLATE_CLASS');
    const rejected = await admin('PUT', `/verification/${d.id}/reject`, { reason: 'Plate is not a hire mark', reasonCode: 'WRONG_PLATE_CLASS' });
    expect(rejected.statusCode).toBe(200);
    // the driver corrects the vehicle's registration mark and resubmits
    await system(() => app.prisma.driver.update({ where: { userId: taxi }, data: { licensePlate: `HB ${NUM.slice(-4)}` } }));
    const again = await pending(taxi);
    expect((await approve(again.id)).statusCode).toBe(200);
    const delivery = await mover(2, 'delivery', `PAB ${NUM.slice(-3)}9`);
    const dd = await pending(delivery);
    expect((await approve(dd.id)).statusCode).toBe(200);
  });
});
