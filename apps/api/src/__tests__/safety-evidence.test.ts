import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { SosService } from '../modules/safety/sos.service';
import { IncidentService } from '../modules/safety/incident.service';
import { EvidenceService, canonicalJson, sha256 } from '../modules/safety/evidence.service';

// Evidence Vault M7a (safety spec §9) — tamper-evident capture. Bundles open
// automatically on SOS ACTIVE and S0/S1 intake, items are canonical
// snapshots with SHA-256 at capture, sealing makes content immutable at the
// DATABASE (Postgres triggers — attacked here with raw Prisma writes), every
// content view requires a logged reason, and retention only ever deletes
// unsealed case-less bundles.

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const bundleIds: string[] = [];
let seq = 0;
const phoneBase = 592_790_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Vault', lastName: `U${seq}`,
      roles, activeRole: roles[0]!,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ev', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeOrder(customerId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `EV-${nanoid(8)}`,
      orderType: 'TAXI', customerId,
      status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      statusHistory: { create: { status: 'PENDING', changedBy: customerId, note: 'evidence fixture' } },
    },
  });
  orderIds.push(order.id);
  return order;
}

const evidence = () => new EvidenceService(app.prisma, app.io);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  // The triggers are ABSOLUTE — sealed evidence cannot be unsealed even by
  // the service. Test cleanup is the one sanctioned bypass: disable the
  // triggers on the TEST database, delete the fixtures, re-enable.
  await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceItem" DISABLE TRIGGER evidence_item_no_mutation`).catch(() => {});
  await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" DISABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
  await app.prisma.evidenceBundle.deleteMany({ where: { id: { in: bundleIds } } }).catch(() => {});
  await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceItem" ENABLE TRIGGER evidence_item_no_mutation`).catch(() => {});
  await app.prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" ENABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
  await app.prisma.safetyAccessLog.deleteMany({ where: { bundleId: { in: bundleIds } } });
  await app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§9.1 capture — bundles open themselves', () => {
  it('an ACTIVE SOS opens a bundle with canonical, hashed snapshots of everything held', async () => {
    const victim = await makeUser(['CUSTOMER']);
    const counterparty = await makeUser(['MOVER']);
    const order = await makeOrder(victim.userId);
    const sos = new SosService(app.prisma, app.io);
    const alert = await sos.create({
      actorUserId: victim.userId, actorRole: 'CUSTOMER', orderId: order.id, orderType: 'TAXI',
      counterpartyUserId: counterparty.userId, triggerSource: 'BUTTON', immediate: true, lat: 6.81, lng: -58.14,
    });

    const bundle = await app.prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id }, include: { items: true } });
    expect(bundle).not.toBeNull();
    bundleIds.push(bundle!.id);
    expect(bundle!.subjectUserId).toBe(counterparty.userId);
    const kinds = bundle!.items.map((i) => i.kind);
    expect(kinds).toContain('SOS_ALERT');
    expect(kinds).toContain('ORDER_SNAPSHOT');
    expect(kinds).toContain('STATUS_TIMELINE');
    // Every item's hash verifies against its own canonical content.
    for (const item of bundle!.items) {
      expect(item.contentHash).toBe(sha256(canonicalJson(item.content)));
    }
    // Idempotent: re-opening returns the SAME bundle.
    const again = await evidence().openForSos(alert.id);
    expect(again!.id).toBe(bundle!.id);
  });

  it('an SOS-born S1 case ADOPTS the alert bundle instead of forking a second one', async () => {
    const victim = await makeUser(['CUSTOMER']);
    const subject = await makeUser(['MOVER']);
    const sos = new SosService(app.prisma, app.io);
    const ops = await makeUser(['ADMIN']);
    const alert = await sos.create({ actorUserId: victim.userId, actorRole: 'CUSTOMER', counterpartyUserId: subject.userId, triggerSource: 'BUTTON', immediate: true });
    await sos.ack(alert.id, ops.userId);
    await sos.resolve(alert.id, ops.userId, 'ABUSE', 'confirmed'); // → auto S1 case with sosAlertId

    const kase = await app.prisma.incidentCase.findFirst({ where: { sosAlertId: alert.id } });
    expect(kase).not.toBeNull();
    const bundles = await app.prisma.evidenceBundle.findMany({ where: { sosAlertId: alert.id } });
    expect(bundles).toHaveLength(1); // adopted, not forked
    bundleIds.push(bundles[0]!.id);
    expect(bundles[0]!.caseId).toBe(kase!.id);
  });
});

describe('§9.2 sealing — the database itself refuses', () => {
  it('sealing stamps hashes; raw UPDATE/DELETE/INSERT on sealed evidence throw at Postgres', async () => {
    const ops = await makeUser(['ADMIN']);
    const subject = await makeUser(['MOVER']);
    const inc = new IncidentService(app.prisma, app.io);
    const kase = await inc.intake({ category: 'SAFETY_THREAT', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'seal fixture' });
    const bundle = (await app.prisma.evidenceBundle.findUnique({ where: { caseId: kase.id }, include: { items: true } }))!;
    bundleIds.push(bundle.id);

    const sealed = await evidence().seal(bundle.id, ops.userId, 'Case decided — sealing per procedure');
    expect(sealed.sealedAt).not.toBeNull();
    expect(sealed.sealHash).toBe(sha256(bundle.items.map((i) => i.contentHash).sort().join('\n')));
    // Idempotent re-seal keeps the original stamp.
    expect((await evidence().seal(bundle.id, ops.userId, 'again')).sealedAt?.getTime()).toBe(sealed.sealedAt!.getTime());

    const item = bundle.items[0]!;
    await expect(app.prisma.evidenceItem.update({ where: { id: item.id }, data: { label: 'tampered' } })).rejects.toThrow(/sealed/i);
    await expect(app.prisma.evidenceItem.delete({ where: { id: item.id } })).rejects.toThrow(/sealed/i);
    await expect(
      app.prisma.evidenceItem.create({ data: { bundleId: bundle.id, kind: 'NOTE', label: 'late insert', content: {}, contentHash: 'x' } }),
    ).rejects.toThrow(/sealed/i);
    await expect(app.prisma.evidenceBundle.delete({ where: { id: bundle.id } })).rejects.toThrow(/sealed/i);
  });

  it('content never moves without a logged reason; police escalation sets legal hold on the bundle', async () => {
    const ops = await makeUser(['ADMIN']);
    const nonOps = await makeUser(['CUSTOMER']);
    const subject = await makeUser(['MOVER']);
    const inc = new IncidentService(app.prisma, app.io);
    const kase = await inc.intake({ category: 'IDENTITY_MISMATCH', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'custody fixture' });
    const bundle = (await app.prisma.evidenceBundle.findUnique({ where: { caseId: kase.id } }))!;
    bundleIds.push(bundle.id);

    await expect(evidence().view(bundle.id, ops.userId, 'why')).rejects.toThrow(/reason/i); // too short
    const viewed = await evidence().view(bundle.id, ops.userId, 'Reviewing before triage decision');
    expect(viewed.items.length).toBeGreaterThan(0);
    expect(await app.prisma.safetyAccessLog.findFirst({ where: { bundleId: bundle.id, action: 'VIEW', accessorUserId: ops.userId } })).not.toBeNull();

    const forbidden = await app.inject({
      method: 'POST', url: `/api/v1/safety/evidence/${bundle.id}/view`,
      payload: { reason: 'I am just curious' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nonOps.token}` },
    });
    expect(forbidden.statusCode).toBe(403);

    await inc.escalatePolice(kase.id, ops.userId);
    const held = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { id: bundle.id } });
    expect(held.legalHold).toBe(true);
    expect(await app.prisma.safetyAccessLog.findFirst({ where: { bundleId: bundle.id, action: 'LEGAL_HOLD' } })).not.toBeNull();
  });
});

describe('§9.4 retention', () => {
  it('deletes only unsealed case-less bundles past the window; holds and cases survive', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    const mk = (extra: Record<string, unknown> = {}) =>
      app.prisma.evidenceBundle.create({ data: { bundleNumber: `EV-${nanoid(8).toUpperCase()}`, openedAt: eightDaysAgo, ...extra } });

    const stale = await mk();
    const onHold = await mk({ legalHold: true });

    // A real S1 case auto-opens its bundle; age it past the window — it must
    // still survive because it is case-attached.
    const subject = await makeUser(['MOVER']);
    const inc = new IncidentService(app.prisma, app.io);
    const kase = await inc.intake({ category: 'SAFETY_THREAT', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'retention case fixture' });
    const caseBundle = (await app.prisma.evidenceBundle.findUnique({ where: { caseId: kase.id } }))!;
    await app.prisma.evidenceBundle.update({ where: { id: caseBundle.id }, data: { openedAt: eightDaysAgo } });
    bundleIds.push(onHold.id, caseBundle.id);

    const { deleted } = await evidence().retentionSweep();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await app.prisma.evidenceBundle.findUnique({ where: { id: stale.id } })).toBeNull(); // aged out
    expect(await app.prisma.evidenceBundle.findUnique({ where: { id: onHold.id } })).not.toBeNull(); // legal hold survives
    expect(await app.prisma.evidenceBundle.findUnique({ where: { id: caseBundle.id } })).not.toBeNull(); // case-attached survives
  });
});
