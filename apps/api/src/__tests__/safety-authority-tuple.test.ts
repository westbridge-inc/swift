import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { EvidenceService } from '../modules/safety/evidence.service';
import { IncidentService } from '../modules/safety/incident.service';

// ---------------------------------------------------------------------------
// [M069] An ops-logged case names a subject, and optionally an order and an
// SOS. That tuple is validated BEFORE any effect or replay: every id exists,
// the subject is in the caller's tenant (a SUPER_ADMIN's case lands in the
// subject's tenant), the order and the SOS belong to that tenant and name
// the subject, and a replayed key carries the tuple it was first used with.
// A refused tuple leaves no case behind.
//
// [M070, remaining after #1435] Evidence is read only through a parent that
// still holds: a bundle whose case or SOS is gone, or whose case and SOS
// disagree, is refused before any custody log or item read. A closed case is
// closed to new evidence: nothing is captured or attached to it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_B = `l10-auth-b-${RUN}`;
const userIds: string[] = []; const orderIds: string[] = []; const alertIds: string[] = []; const bundleIds: string[] = []; const driverIds: string[] = [];
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 100_000_000);
let seq = 0;

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:l10-authority');

async function makeUser(roles: UserRole[], tenantId?: string) {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Auth', lastName: `L10${RUN}${seq}`, roles, activeRole: roles[0]!, status: 'ACTIVE', isPhoneVerified: true,
      ...(tenantId ? { tenantId } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'l10a', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 86_400_000) } }));
  return { userId: user.id, token, tenantId: user.tenantId };
}

async function makeOrder(customerId: string, tenantId?: string) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `L10A-${nanoid(8)}`, orderType: 'TAXI', customerId, status: 'COMPLETED' as never, fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      ...(tenantId ? { tenantId } : {}),
    },
  }));
  orderIds.push(order.id);
  return order;
}

async function makeAlert(actorUserId: string, opts: { tenantId?: string; orderId?: string; counterpartyUserId?: string } = {}) {
  const alert = await sys(() => app.prisma.sosAlert.create({ data: { actorUserId, actorRole: 'CUSTOMER', status: 'RESOLVED', triggerSource: 'BUTTON', triggeredAt: new Date(), ...opts } }));
  alertIds.push(alert.id);
  return alert;
}

const casesFor = (subjectUserId: string) => sys(() => app.prisma.incidentCase.findMany({ where: { subjectUserId } }));
const logCase = (token: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/safety/incidents/ops', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: { category: 'HARASSMENT', severity: 'S3', summary: 'Logged by phone after the trip.', ...body } });

let adminA: Awaited<ReturnType<typeof makeUser>>;
let superAdmin: Awaited<ReturnType<typeof makeUser>>;
let subjectA: Awaited<ReturnType<typeof makeUser>>;
let otherA: Awaited<ReturnType<typeof makeUser>>;
let subjectB: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'L10 authority tenant B', slug: TENANT_B, isActive: true } }));
  adminA = await makeUser(['ADMIN']);
  superAdmin = await makeUser(['SUPER_ADMIN']);
  subjectA = await makeUser(['CUSTOMER']);
  otherA = await makeUser(['CUSTOMER']);
  subjectB = await makeUser(['CUSTOMER'], TENANT_B);
});

afterAll(async () => {
  await sys(async () => {
    const cases = await app.prisma.incidentCase.findMany({ where: { subjectUserId: { in: userIds } }, select: { id: true } });
    const caseIds = cases.map((c) => c.id);
    const bundles = await app.prisma.evidenceBundle.findMany({ where: { OR: [{ id: { in: bundleIds } }, { caseId: { in: caseIds } }, { sosAlertId: { in: alertIds } }] }, select: { id: true } });
    await app.prisma.safetyAccessLog.deleteMany({ where: { bundleId: { in: bundles.map((b) => b.id) } } }).catch(() => {});
    await app.prisma.evidenceItem.deleteMany({ where: { bundleId: { in: bundles.map((b) => b.id) } } }).catch(() => {});
    await app.prisma.evidenceBundle.deleteMany({ where: { id: { in: bundles.map((b) => b.id) } } }).catch(() => {});
    await app.prisma.incidentCase.deleteMany({ where: { id: { in: caseIds } } }).catch(() => {});
    await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });
  await app.close();
});

describe('[M069] the ops intake tuple is validated before any effect', () => {
  it('a subject in another tenant is not found for a tenant ADMIN; no case is created', async () => {
    const res = await logCase(adminA.token, { subjectUserId: subjectB.userId });
    expect(res.statusCode).toBe(404);
    expect(await casesFor(subjectB.userId)).toHaveLength(0);
  });

  it('a subject that does not exist is not found', async () => {
    const res = await logCase(adminA.token, { subjectUserId: `missing-${RUN}` });
    expect(res.statusCode).toBe(404);
  });

  it('the wrong order: an order the subject is not a party to is refused', async () => {
    const order = await makeOrder(otherA.userId);
    const res = await logCase(adminA.token, { subjectUserId: subjectA.userId, orderId: order.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUBJECT_NOT_ON_ORDER');
    expect(await casesFor(subjectA.userId)).toHaveLength(0);
  });

  it('an order in another tenant is not found, even for its own customer', async () => {
    const order = await makeOrder(subjectB.userId, TENANT_B);
    const res = await logCase(superAdmin.token, { subjectUserId: subjectA.userId, orderId: order.id });
    expect(res.statusCode).toBe(404);
    expect(await casesFor(subjectA.userId)).toHaveLength(0);
  });

  it('an unrelated SOS, another tenant\'s SOS, and an SOS on a different order are all refused', async () => {
    const unrelated = await makeAlert(otherA.userId);
    expect((await logCase(adminA.token, { subjectUserId: subjectA.userId, sosAlertId: unrelated.id })).statusCode).toBe(409);
    const foreign = await makeAlert(subjectB.userId, { tenantId: TENANT_B });
    expect((await logCase(superAdmin.token, { subjectUserId: subjectA.userId, sosAlertId: foreign.id })).statusCode).toBe(404);
    const orderOne = await makeOrder(subjectA.userId);
    const orderTwo = await makeOrder(subjectA.userId);
    const onOne = await makeAlert(subjectA.userId, { orderId: orderOne.id });
    const mismatched = await logCase(adminA.token, { subjectUserId: subjectA.userId, orderId: orderTwo.id, sosAlertId: onOne.id });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json().error.code).toBe('ORDER_NOT_ON_ALERT');
    expect(await casesFor(subjectA.userId)).toHaveLength(0);
  });

  it('an empty order or SOS id is refused up front: it can never skip the checks and be stored (DS757)', async () => {
    for (const ids of [{ orderId: '' }, { sosAlertId: '' }, { orderId: '', sosAlertId: '' }]) {
      const res = await logCase(adminA.token, { subjectUserId: subjectA.userId, ...ids });
      expect(res.statusCode, JSON.stringify(ids)).toBe(400);
    }
    expect(await casesFor(subjectA.userId)).toHaveLength(0);
  });

  it('a replayed key with a changed tuple is refused and the first case is untouched', async () => {
    const order = await makeOrder(subjectA.userId);
    const key = `l10-${RUN}`;
    const first = await logCase(adminA.token, { subjectUserId: subjectA.userId, orderId: order.id, idempotencyKey: key });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().data.id as string;
    const changed = await logCase(adminA.token, { subjectUserId: otherA.userId, idempotencyKey: key });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const row = await sys(() => app.prisma.incidentCase.findUniqueOrThrow({ where: { id: firstId } }));
    expect(row.replayCount).toBe(0);
    expect(await casesFor(otherA.userId)).toHaveLength(0);
    const same = await logCase(adminA.token, { subjectUserId: subjectA.userId, orderId: order.id, idempotencyKey: key });
    expect(same.statusCode).toBe(200);
    expect(same.json().data.id).toBe(firstId);
  });

  it('racing requests with one key and different ids never hand one request the other\'s case', async () => {
    const order = await makeOrder(subjectA.userId);
    const key = `l10-race-${RUN}`;
    const bodies = [{ subjectUserId: subjectA.userId, orderId: order.id }, { subjectUserId: otherA.userId }];
    const results = await Promise.all(bodies.map((b) => logCase(adminA.token, { ...b, idempotencyKey: key })));
    results.forEach((res, i) => {
      if (res.statusCode === 200) expect(res.json().data.subjectUserId, 'a 200 is always the case the request named').toBe(bodies[i]!.subjectUserId);
      else expect(res.statusCode).toBe(409);
    });
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('under the subject lock, a source already used for another tuple is refused (the check the race relies on)', async () => {
    const io = { to: () => ({ emit: () => {} }) } as never;
    const incidents = new IncidentService(app.prisma, io);
    const source = { type: 'OPS', id: `l10-lock-${RUN}` };
    const first = await sys(() => incidents.intake({ category: 'HARASSMENT', severity: 'S3', intake: 'OPS_CREATED', subjectUserId: subjectA.userId, summary: 'Logged by phone.', source }));
    await expect(sys(() => incidents.intake({ category: 'HARASSMENT', severity: 'S3', intake: 'OPS_CREATED', subjectUserId: otherA.userId, summary: 'Logged by phone.', source })))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await sys(() => app.prisma.incidentCase.findUniqueOrThrow({ where: { id: first.id } }))).replayCount).toBe(0);
    const same = await sys(() => incidents.intake({ category: 'HARASSMENT', severity: 'S3', intake: 'OPS_CREATED', subjectUserId: subjectA.userId, summary: 'Logged by phone.', source }));
    expect(same.id).toBe(first.id);
  });

  it('a valid tuple logs the case in the SUBJECT\'s tenant, also when a SUPER_ADMIN logs it', async () => {
    const order = await makeOrder(subjectB.userId, TENANT_B);
    const alert = await makeAlert(subjectB.userId, { tenantId: TENANT_B, orderId: order.id });
    const res = await logCase(superAdmin.token, { subjectUserId: subjectB.userId, orderId: order.id, sosAlertId: alert.id });
    expect(res.statusCode).toBe(200);
    const kase = await sys(() => app.prisma.incidentCase.findUniqueOrThrow({ where: { id: res.json().data.id as string } }));
    expect(kase.tenantId).toBe(TENANT_B);
  });
});

describe('[M070] evidence is read only through a parent that still holds', () => {
  const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
  const evidence = () => new EvidenceService(app.prisma, io);

  async function bundleWith(link: { caseId?: string; sosAlertId?: string }) {
    const b = await sys(() => app.prisma.evidenceBundle.create({ data: { bundleNumber: `EV-${nanoid(8).toUpperCase()}`, ...link, items: { create: [{ kind: 'NOTE', label: 'synthetic', content: { note: 'synthetic' } as never, contentHash: nanoid(16) }] } } }));
    bundleIds.push(b.id);
    return b;
  }
  const custodyRows = (bundleId: string) => sys(() => app.prisma.safetyAccessLog.count({ where: { bundleId } }));

  it('a bundle whose SOS is gone is refused: no content, no custody row', async () => {
    const alert = await makeAlert(subjectA.userId);
    const bundle = await bundleWith({ sosAlertId: alert.id });
    await sys(() => app.prisma.sosAlert.delete({ where: { id: alert.id } }));
    await expect(sys(() => evidence().view(bundle.id, adminA.userId, 'Reviewing the trail for triage'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sys(() => evidence().export(bundle.id, adminA.userId, 'Police referral request'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await custodyRows(bundle.id)).toBe(0);
  });

  it('a bundle whose case and SOS disagree is refused', async () => {
    const alertOne = await makeAlert(subjectA.userId);
    const alertTwo = await makeAlert(subjectA.userId);
    const kase = await sys(() => app.prisma.incidentCase.create({ data: { caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S3', category: 'HARASSMENT', intake: 'OPS_CREATED', subjectUserId: subjectA.userId, sosAlertId: alertOne.id, summary: 'synthetic', slaAckBy: new Date(), slaDecideBy: new Date() } }));
    const bundle = await bundleWith({ caseId: kase.id, sosAlertId: alertTwo.id });
    await expect(sys(() => evidence().view(bundle.id, adminA.userId, 'Reviewing the trail for triage'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await custodyRows(bundle.id)).toBe(0);
  });

  it('a bundle whose case lives outside the reader\'s scope is refused', async () => {
    const kase = await sys(() => app.prisma.incidentCase.create({ data: { tenantId: TENANT_B, caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S3', category: 'HARASSMENT', intake: 'OPS_CREATED', subjectUserId: subjectB.userId, summary: 'synthetic', slaAckBy: new Date(), slaDecideBy: new Date() } }));
    const bundle = await bundleWith({ caseId: kase.id });
    const { runWithTenant } = await import('../plugins/tenant-context');
    await expect(runWithTenant('swift-default', () => evidence().view(bundle.id, adminA.userId, 'Reviewing the trail for triage'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await custodyRows(bundle.id)).toBe(0);
  });

  it('a bundle whose parent holds is viewable, with its custody row', async () => {
    const alert = await makeAlert(subjectA.userId);
    const bundle = await bundleWith({ sosAlertId: alert.id });
    const viewed = await sys(() => evidence().view(bundle.id, adminA.userId, 'Reviewing the trail for triage'));
    expect(viewed.items).toHaveLength(1);
    expect(await custodyRows(bundle.id)).toBe(1);
  });

  it('a closed case\'s bundle takes no new live fixes while its SOS is still live', async () => {
    const mover = await makeUser(['MOVER']);
    const driver = await sys(() => app.prisma.driver.create({ data: {
      userId: mover.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver', licensePlate: `L10A ${seq}`,
      driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', currentLat: 6.81, currentLng: -58.15, lastLocationUpdate: new Date(),
    } }));
    driverIds.push(driver.id);
    const order = await makeOrder(subjectA.userId);
    await sys(() => app.prisma.order.update({ where: { id: order.id }, data: { driverId: driver.id, status: 'RIDE_IN_PROGRESS' as never } }));
    const alert = await makeAlert(subjectA.userId, { orderId: order.id });
    await sys(() => app.prisma.sosAlert.update({ where: { id: alert.id }, data: { status: 'ACTIVE' } }));
    const kase = await sys(() => app.prisma.incidentCase.create({ data: { caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S1', category: 'HARASSMENT', intake: 'OPS_CREATED', status: 'CLOSED', closedAt: new Date(), subjectUserId: subjectA.userId, sosAlertId: alert.id, summary: 'synthetic', slaAckBy: new Date(), slaDecideBy: new Date() } }));
    const bundle = await bundleWith({ sosAlertId: alert.id, caseId: kase.id });
    await sys(() => evidence().withSweep({ cursorKey: `l10-${RUN}` }).appendLiveFixes());
    expect(await sys(() => app.prisma.evidenceItem.count({ where: { bundleId: bundle.id, kind: 'LOCATION_FIX' } }))).toBe(0);
  });

  it('a closed case is closed to new evidence: nothing is captured and no SOS bundle is attached to it', async () => {
    const alert = await makeAlert(subjectA.userId);
    const sosBundle = await bundleWith({ sosAlertId: alert.id });
    const kase = await sys(() => app.prisma.incidentCase.create({ data: { caseNumber: `INC-${nanoid(8).toUpperCase()}`, severity: 'S1', category: 'HARASSMENT', intake: 'OPS_CREATED', status: 'CLOSED', closedAt: new Date(), subjectUserId: subjectA.userId, sosAlertId: alert.id, summary: 'synthetic', slaAckBy: new Date(), slaDecideBy: new Date() } }));
    const opened = await sys(() => evidence().openForCase(kase.id));
    expect(opened).toBeNull();
    const after = await sys(() => app.prisma.evidenceBundle.findUniqueOrThrow({ where: { id: sosBundle.id } }));
    expect(after.caseId).toBeNull();
    expect(await sys(() => app.prisma.evidenceBundle.count({ where: { caseId: kase.id } }))).toBe(0);
  });
});
