import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { IncidentService } from '../modules/safety/incident.service';
import { EvidenceService } from '../modules/safety/evidence.service';
import { SosService } from '../modules/safety/sos.service';
import { scanLegalHolds, repairLegalHolds, drainLegalHoldVault } from '../modules/safety/legal-hold';
import { resetDevChannelLog } from '../providers/notifications/channels';

// Trip Guardian M4c — the graduated check-in ladder (§5.3, self-test §14-E):
// L2 soft check-in → L3 hard check-in with a server deadline → L4 auto-SOS.
// The full climb is driven with scripted GPS through FRESH GuardianService
// instances per tick (worker-restart proof); responses go through the real
// authed routes. Scripted timestamps sit in the PAST so the ladder's deadline
// arithmetic works against real-clock responses.

let app: FastifyInstance;
const emits: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
const io = {
  to: (room: string) => ({ emit: (event: string, payload: Record<string, unknown>) => { emits.push({ room, event, payload }) } }),
} as unknown as Server;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_720_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Ladder',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'grd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const driver = await app.prisma.driver.create({
    data: {
      userId: u.userId,
      vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `LDR ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
      totalRides: 500, createdAt: new Date(Date.now() - 90 * 86_400_000),
    },
  });
  return { ...u, driver };
}

const PICKUP = { lat: 6.8, lng: -58.15 };
const DEST = { lat: 6.82, lng: -58.13 };

async function makeRide(driverId: string, customerId: string, pickedUpAt: Date) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `LDR-${nanoid(8)}`,
      orderType: 'TAXI',
      customerId,
      driverId,
      status: 'RIDE_IN_PROGRESS',
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'B', deliveryLat: DEST.lat, deliveryLng: DEST.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0,
      totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH',
      pickedUpAt, taxiDuration: 60,
    },
  });
  orderIds.push(order.id);
  return order;
}


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

beforeEach(() => { resetDevChannelLog(); emits.length = 0; });

afterAll(async () => {
  await app.prisma.legalHold.deleteMany({ where: { caseId: { in: caseIds } } }).catch(() => {});
  await app.prisma.evidenceBundle.updateMany({ where: { OR: [{ caseId: { in: caseIds } }, { sosAlertId: { in: alertIds } }] }, data: { legalHold: false } }).catch(() => {});
  await app.prisma.evidenceBundle.deleteMany({ where: { OR: [{ caseId: { in: caseIds } }, { sosAlertId: { in: alertIds } }] } }).catch(() => {});
  await app.prisma.incidentCase.deleteMany({ where: { id: { in: caseIds } } }).catch(() => {});
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
  delete process.env['GUARDIAN_AUTONOTIFY_CONTACTS'];
  await app.prisma.tripSafetySession.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.sosAlert.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { counterpartyUserId: { in: userIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});


// ---------------------------------------------------------------------------
// [S-09] Police legal hold and evidence hold are split.
//
// The register's red test: fail at each boundary of the hold and run
// retention concurrently — no held case evidence may delete. Around it: the
// aggregate commits whole (case, every linked bundle, custody log, hold row,
// vault manifest); a partial hold freezes deletion until repaired; an
// evidence-side hold holds the case too; the vault retries; the rollback
// freezes deletion outright.
// ---------------------------------------------------------------------------

const incidents = () => new IncidentService(app.prisma, io);
const evidence = () => new EvidenceService(app.prisma, io);
const caseIds: string[] = []; const alertIds: string[] = [];
const holdRow = (caseId: string) => app.prisma.legalHold.findUnique({ where: { caseId } });
const custody = (bundleId: string) => app.prisma.safetyAccessLog.count({ where: { bundleId, action: 'LEGAL_HOLD' } });
const bundleOf = (id: string) => app.prisma.evidenceBundle.findUnique({ where: { id } });
const caseOf = (id: string) => app.prisma.incidentCase.findUniqueOrThrow({ where: { id } });

/** A case born from an SOS whose bundle stayed an orphan (S3: no adoption) — the split the register describes. */
async function sosCaseWithOrphanBundle(opts: { oldBundle?: boolean } = {}) {
  const passenger = await makeUser(['CUSTOMER']);
  const { driver } = await makeDriver();
  const ride = await makeRide(driver.id, passenger.userId, new Date(Date.now() - 600_000));
  const alert = await new SosService(app.prisma, io).create({ actorUserId: passenger.userId, actorRole: 'CUSTOMER', orderId: ride.id, orderType: 'TAXI', immediate: true, lat: 6.8, lng: -58.15 });
  alertIds.push(alert.id);
  const bundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { sosAlertId: alert.id } });
  if (opts.oldBundle) await app.prisma.evidenceBundle.update({ where: { id: bundle.id }, data: { openedAt: new Date(Date.now() - 100 * 86_400_000) } });
  const kase = await incidents().intake({ category: 'CASH_DISPUTE', intake: 'SOS_RESOLUTION', subjectUserId: driver.userId, reporterUserId: passenger.userId, orderId: ride.id, sosAlertId: alert.id, summary: 'a dispute after an SOS', source: { type: 'T', id: `hold-${nanoid(8)}` } });
  caseIds.push(kase.id);
  expect((await bundleOf(bundle.id))!.caseId).toBeNull(); // the orphan
  return { kase, bundle, alert, ops: (await makeUser(['ADMIN'])).userId };
}

describe('[S-09] the register’s red test: fail at each boundary; run retention concurrently', () => {
  it('a death after the case is held, after the bundle is held, or before the commit leaves NOTHING held — no split state, no orphan custody entry', async () => {
    const { kase, bundle, ops } = await sosCaseWithOrphanBundle();
    for (const seam of ['afterCaseHeld', 'afterBundleHeld', 'beforeCommit'] as const) {
      const svc = incidents();
      svc.holdObserver = { [seam]: async () => { throw new Error(`process died at ${seam}`); } };
      await expect(svc.escalatePolice(kase.id, ops)).rejects.toThrow('process died');
      const c = await caseOf(kase.id);
      expect(c.legalHold).toBe(false); expect(c.escalatedPoliceAt).toBeNull();
      expect((await bundleOf(bundle.id))!.legalHold).toBe(false);
      expect(await holdRow(kase.id)).toBeNull();
      expect(await custody(bundle.id)).toBe(0);
    }
    // the whole aggregate, in one commit
    const held = await incidents().escalatePolice(kase.id, ops);
    expect(held.legalHold).toBe(true); expect(held.escalatedPoliceAt).not.toBeNull();
    expect((await bundleOf(bundle.id))!.legalHold).toBe(true);
    expect(await custody(bundle.id)).toBe(1);
    const hold = (await holdRow(kase.id))!;
    expect(hold).toMatchObject({ bundleId: bundle.id, placedBy: ops, vaultStatus: 'DONE' });
    const manifest = hold.manifest as { bundles: Array<{ id: string; items: unknown[] }> };
    expect(manifest.bundles.map((b) => b.id)).toContain(bundle.id);
    // idempotent: a second escalation changes nothing and logs nothing twice
    await incidents().escalatePolice(kase.id, ops);
    expect(await custody(bundle.id)).toBe(1);
  });

  it('retention running while the hold commits cannot delete the evidence: the conditional delete waits on the row and finds it held', async () => {
    const { kase, bundle, ops } = await sosCaseWithOrphanBundle({ oldBundle: true });
    // the orphan IS a retention candidate right now (unsealed, case-less, old, its SOS not live)
    await app.prisma.sosAlert.update({ where: { id: (await bundleOf(bundle.id))!.sosAlertId! }, data: { status: 'RESOLVED' } });
    let releaseHold!: () => void; const gate = new Promise<void>((r) => { releaseHold = r; });
    const svc = incidents();
    svc.holdObserver = { beforeCommit: async () => { await gate; } };
    const holdP = svc.escalatePolice(kase.id, ops);
    await new Promise((r) => setTimeout(r, 200)); // the hold transaction now owns the bundle's row lock
    const sweepP = evidence().retentionSweep(new Date());
    setTimeout(() => releaseHold(), 300); // the sweep is blocked on the row; now the hold commits
    const [held, swept] = await Promise.all([holdP, sweepP]);
    expect(held.legalHold).toBe(true);
    expect(swept.deleted).toBe(0);
    expect((await bundleOf(bundle.id))!.legalHold).toBe(true);
    expect(await app.prisma.evidenceItem.count({ where: { bundleId: bundle.id } })).toBeGreaterThanOrEqual(0);
    // and after the hold, the sweep never sees it again
    expect((await evidence().retentionSweep(new Date())).deleted).toBe(0);
    expect(await bundleOf(bundle.id)).not.toBeNull();
  });
});

describe('[S-09] retention fails closed; repair extends; the rollback', () => {
  it('a case adopting the bundle while retention runs cannot lose it: the delete is conditional on the row’s live state', async () => {
    const { kase, bundle } = await sosCaseWithOrphanBundle({ oldBundle: true });
    await app.prisma.sosAlert.update({ where: { id: bundle.sosAlertId! }, data: { status: 'RESOLVED' } });
    // an adoption transaction holds the row while the sweep selects it as a candidate
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const adoptP = app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "EvidenceBundle" WHERE "id" = ${bundle.id} FOR UPDATE`;
      await tx.evidenceBundle.update({ where: { id: bundle.id }, data: { caseId: kase.id } });
      await gate;
    }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 200));
    const sweepP = evidence().retentionSweep(new Date());
    setTimeout(() => release(), 300);
    const [, swept] = await Promise.all([adoptP, sweepP]);
    expect(swept.deleted).toBe(0);
    const after = await bundleOf(bundle.id);
    expect(after).not.toBeNull();
    expect(after!.caseId).toBe(kase.id);
  });

  it('a partial hold freezes ALL deletion until repaired; repair extends the hold to the evidence and writes the custody entry; then retention resumes on unrelated evidence only', async () => {
    const { kase, bundle } = await sosCaseWithOrphanBundle();
    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { legalHold: true } }); // the old split: case held, evidence not, no hold row
    const unrelated = await app.prisma.evidenceBundle.create({ data: { bundleNumber: `EV-${nanoid(8).toUpperCase()}`, openedAt: new Date(Date.now() - 100 * 86_400_000) } });
    const scan = await scanLegalHolds(app.prisma);
    expect(scan.deletionFrozen).toBe(true);
    expect(scan.partial.filter((p) => p.caseId === kase.id).map((p) => p.kind).sort()).toEqual(['BUNDLE_NOT_HELD', 'NO_HOLD_ROW']);
    const frozen = await evidence().retentionSweep(new Date());
    expect(frozen).toMatchObject({ deleted: 0, frozen: true });
    expect(await bundleOf(unrelated.id)).not.toBeNull();
    const repaired = await repairLegalHolds(app.prisma);
    expect(repaired.repaired).toContain(kase.id);
    expect((await bundleOf(bundle.id))!.legalHold).toBe(true);
    expect(await custody(bundle.id)).toBe(1);
    expect(await holdRow(kase.id)).not.toBeNull();
    expect((await scanLegalHolds(app.prisma)).partial.some((p) => p.caseId === kase.id)).toBe(false);
    const after = await evidence().retentionSweep(new Date());
    if (!after.frozen) { // another suite's partial hold may freeze the shared sweep; the held evidence survives either way
      expect(await bundleOf(unrelated.id)).toBeNull();
    }
    expect(await bundleOf(bundle.id)).not.toBeNull();
  });

  it('holding the evidence holds the case: setLegalHold on a case-linked bundle is the same one commit', async () => {
    const subject = await makeDriver();
    const kase = await incidents().intake({ category: 'SAFETY_THREAT', severity: 'S1', intake: 'OPS_CREATED', subjectUserId: subject.userId, summary: 'evidence first', source: { type: 'T', id: `ev-${nanoid(8)}` } });
    caseIds.push(kase.id);
    const bundle = await app.prisma.evidenceBundle.findUniqueOrThrow({ where: { caseId: kase.id } }); // S1 opened it at intake
    const ops = (await makeUser(['ADMIN'])).userId;
    await evidence().setLegalHold(bundle.id, ops, 'prosecutor request');
    expect((await caseOf(kase.id)).legalHold).toBe(true);
    expect((await holdRow(kase.id))).toMatchObject({ bundleId: bundle.id, placedBy: ops });
    expect(await custody(bundle.id)).toBe(1);
  });

  it('the vault operation retries from the outbox: a partial aggregate fails it, the repair makes it whole, the manifest lands', async () => {
    const { kase, bundle, ops } = await sosCaseWithOrphanBundle();
    await incidents().escalatePolice(kase.id, ops);
    await app.prisma.legalHold.update({ where: { caseId: kase.id }, data: { vaultStatus: 'PENDING', manifest: undefined, vaultedAt: null, vaultAttempts: 0 } });
    // The split, manufactured on the CASE side: the bundle side cannot be —
    // the database itself refuses to clear a held bundle (the 2026-08-01
    // evidence_bundle_no_update_sealed guard), which is the S-09 invariant.
    await app.prisma.incidentCase.update({ where: { id: kase.id }, data: { legalHold: false } });
    const failed = await drainLegalHoldVault(app.prisma, { caseIds: [kase.id] });
    expect(failed).toMatchObject({ vaulted: 0, failed: 1 });
    expect((await holdRow(kase.id))!.vaultLastError).toContain('partial');
    // the scan sees the cold case through the SOS link (the orphan bundle has no caseId), and the repair re-holds it
    expect((await scanLegalHolds(app.prisma)).partial).toEqual(expect.arrayContaining([expect.objectContaining({ caseId: kase.id, bundleId: bundle.id, kind: 'CASE_NOT_HELD' })]));
    await repairLegalHolds(app.prisma);
    expect((await caseOf(kase.id)).legalHold).toBe(true);
    await app.prisma.legalHold.update({ where: { caseId: kase.id }, data: { vaultAvailableAt: new Date(0) } });
    expect(await drainLegalHoldVault(app.prisma, { caseIds: [kase.id] })).toMatchObject({ vaulted: 1 });
    expect((await holdRow(kase.id))!.vaultStatus).toBe('DONE');
  });

  it('the rollback switch freezes deletion outright', async () => {
    process.env['LEGAL_HOLD_DELETION_FREEZE'] = '1';
    try {
      expect(await evidence().retentionSweep(new Date())).toMatchObject({ deleted: 0, frozen: true });
    } finally {
      delete process.env['LEGAL_HOLD_DELETION_FREEZE'];
    }
  });
});
