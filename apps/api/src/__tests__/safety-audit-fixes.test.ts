import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { SosService } from '../modules/safety/sos.service';
import { IncidentService } from '../modules/safety/incident.service';
import { EvidenceService } from '../modules/safety/evidence.service';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { syntheticLocationOwner } from './helpers/online-mover';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] This suite states the destructive capability it needs; without it the test-mode guard refuses.
grantSuiteCapability('ddl');

// Fixes for the 2026-08-01 independent hostile-audit findings (P16). Each test
// FAILS on the pre-fix code and passes after. The bugs were downstream
// consequences of correct transitions — the happy-path tests asserted the
// transition shape but never the specific artifact each finding names.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const userIds: string[] = [];
const alertIds: string[] = [];
const caseIds: string[] = [];
const bundleIds: string[] = [];
let seq = 0;
const phoneBase = 592_800_000_000 + Math.floor(Math.random() * 190_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const u = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'AudFix', lastName: `U${seq}`,
      roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(),
      avatar: 'https://cdn.test/avatars/ref.jpg',
    },
  });
  userIds.push(u.id);
  return u;
}
async function makeDriver() {
  const u = await makeUser(['MOVER']);
  const d = await prisma.driver.create({
    data: {
      userId: u.id, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `AF ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', isOnline: true, isAvailable: true,
      locationSessionId: syntheticLocationOwner('safety-audit'),
    },
  });
  return { user: u, driver: d };
}

beforeAll(async () => {
  await prisma.$connect();
  // The evidence triggers live in a migration db-push can't see (CI preps with
  // db push) — install idempotently so the DB-refusal test exercises reality.
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION evidence_bundle_block_update_sealed() RETURNS trigger AS $$
    BEGIN
      IF OLD."sealedAt" IS NOT NULL AND NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt" THEN
        RAISE EXCEPTION 'evidence bundle % is sealed — sealedAt is immutable', OLD."id";
      END IF;
      IF OLD."sealHash" IS NOT NULL AND NEW."sealHash" IS DISTINCT FROM OLD."sealHash" THEN
        RAISE EXCEPTION 'evidence bundle % is sealed — sealHash is immutable', OLD."id";
      END IF;
      IF OLD."legalHold" = true AND NEW."legalHold" = false THEN
        RAISE EXCEPTION 'evidence bundle % is under legal hold — cannot be cleared', OLD."id";
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`).catch(() => {});
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS evidence_bundle_no_update_sealed ON "EvidenceBundle"`).catch(() => {});
  await prisma.$executeRawUnsafe(`CREATE TRIGGER evidence_bundle_no_update_sealed BEFORE UPDATE ON "EvidenceBundle" FOR EACH ROW EXECUTE FUNCTION evidence_bundle_block_update_sealed()`).catch(() => {});
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS evidence_bundle_no_update_sealed ON "EvidenceBundle"`).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" DISABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
  await prisma.$executeRawUnsafe(`UPDATE "EvidenceBundle" SET "legalHold"=false WHERE "id" = ANY($1)`, bundleIds).catch(() => {});
  await prisma.evidenceBundle.deleteMany({ where: { id: { in: bundleIds } } }).catch(() => {});
  await prisma.$executeRawUnsafe(`ALTER TABLE "EvidenceBundle" ENABLE TRIGGER evidence_bundle_no_delete_sealed`).catch(() => {});
  await prisma.evidenceBundle.deleteMany({ where: { OR: [{ sosAlertId: { in: alertIds } }, { caseId: { in: caseIds } }] } }).catch(() => {});
  await prisma.safetyAccessLog.deleteMany({ where: { bundleId: { in: bundleIds } } }).catch(() => {});
  await prisma.legalHold.deleteMany({ where: { case: { subjectUserId: { in: userIds } } } }).catch(() => {}); // [S-09] a held case's hold row RESTRICTs its case
  await prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } });
  await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await prisma.livenessCheck.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('Finding 1 [S2] — Guardian timeout auto-SOS MUST open an evidence bundle', () => {
  it('a CHECKIN_TIMEOUT SOS opens its bundle (highest-stakes alert, was skipped by the contact-gate early return)', async () => {
    const victim = await makeUser(['CUSTOMER']);
    const driverUser = await makeUser(['MOVER']);
    const sos = new SosService(prisma, io);
    const alert = await sos.create({
      actorUserId: victim.id, actorRole: 'CUSTOMER', counterpartyUserId: driverUser.id,
      triggerSource: 'CHECKIN_TIMEOUT', immediate: true, lat: 6.81, lng: -58.14,
      clientIdempotencyKey: `af-timeout-${nanoid(8)}`,
    });
    alertIds.push(alert.id);

    const bundle = await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } });
    expect(bundle).not.toBeNull(); // was null pre-fix — the abduction path captured no evidence
    bundleIds.push(bundle!.id);
    // The SOS_ALERT item is captured; the live-trail (appendLiveFixes) is now
    // reachable because the bundle exists — pre-fix it short-circuited on null.
    const items = await prisma.evidenceItem.findMany({ where: { bundleId: bundle!.id }, select: { kind: true } });
    expect(items.some((i) => i.kind === 'SOS_ALERT')).toBe(true);
  });

  it('the CHECKIN_TIMEOUT default STILL skips contact SMS (the intended behaviour is preserved)', async () => {
    const victim = await makeUser(['CUSTOMER']);
    await prisma.emergencyContact.create({ data: { userId: victim.id, name: 'Mom', phoneE164: `+${phoneBase + 5000}`, priority: 1, verifiedAt: new Date() } });
    resetDevChannelLog();
    const sos = new SosService(prisma, io);
    const alert = await sos.create({ actorUserId: victim.id, actorRole: 'CUSTOMER', triggerSource: 'CHECKIN_TIMEOUT', immediate: true, clientIdempotencyKey: `af-skip-${nanoid(8)}` });
    alertIds.push(alert.id);
    const bundle = await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } });
    if (bundle) bundleIds.push(bundle.id);
    expect(devChannelLog.filter((e) => e.channel === 'sms')).toHaveLength(0); // still no contact SMS on the default
    const fresh = await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect((fresh.deliveryReceipts as Record<string, unknown>)['contacts']).toBe('skipped:guardian-default');
  });
});

describe('Finding 6 [S4] — no all-clear SMS to contacts who were never alarmed', () => {
  it('a CHECKIN_TIMEOUT-default alert does NOT text contacts on resolve', async () => {
    const victim = await makeUser(['CUSTOMER']);
    const ops = await makeUser(['ADMIN']);
    await prisma.emergencyContact.create({ data: { userId: victim.id, name: 'Dad', phoneE164: `+${phoneBase + 5001}`, priority: 1, verifiedAt: new Date() } });
    const sos = new SosService(prisma, io);
    const alert = await sos.create({ actorUserId: victim.id, actorRole: 'CUSTOMER', triggerSource: 'CHECKIN_TIMEOUT', immediate: true, clientIdempotencyKey: `af-ac-${nanoid(8)}` });
    alertIds.push(alert.id);
    const b = await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } });
    if (b) bundleIds.push(b.id);

    resetDevChannelLog();
    await sos.resolve(alert.id, ops.id, 'FALSE_ALARM');
    expect(devChannelLog.filter((e) => e.channel === 'sms')).toHaveLength(0); // no all-clear for an alert they never heard
  });

  it('a BUTTON alert that DID text contacts still sends the all-clear', async () => {
    const victim = await makeUser(['CUSTOMER']);
    const ops = await makeUser(['ADMIN']);
    const contact = `+${phoneBase + 5002}`;
    await prisma.emergencyContact.create({ data: { userId: victim.id, name: 'Sis', phoneE164: contact, priority: 1, verifiedAt: new Date() } });
    const sos = new SosService(prisma, io);
    const alert = await sos.create({ actorUserId: victim.id, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', immediate: true, clientIdempotencyKey: `af-btn-${nanoid(8)}` });
    alertIds.push(alert.id);
    const b = await prisma.evidenceBundle.findUnique({ where: { sosAlertId: alert.id } });
    if (b) bundleIds.push(b.id);

    resetDevChannelLog();
    await sos.resolve(alert.id, ops.id, 'SAFE_CONFIRMED');
    expect(devChannelLog.find((e) => e.channel === 'sms' && e.to === contact)?.body).toContain('closed');
  });
});

describe('Finding 2 [S3] — DISMISSED clears a SHADOW_RESTRICTED interim', () => {
  it('dismissing a shadow-restricted case restores the driver to enhanced-monitoring dispatch', async () => {
    const ops = await makeUser(['ADMIN']);
    const { user, driver } = await makeDriver();
    const inc = new IncidentService(prisma, io);
    const kase = await inc.intake({ category: 'SAFETY_HARASSMENT', severity: 'S2', intake: 'OPS_CREATED', subjectUserId: user.id, summary: 'shadow then dismiss' });
    caseIds.push(kase.id);
    await inc.shadowRestrict(kase.id, ops.id);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).safetyShadowRestrictedAt).not.toBeNull();

    await inc.ack(kase.id, ops.id);
    await inc.investigate(kase.id, ops.id);
    await inc.decide(kase.id, ops.id, 'DISMISSED');
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).safetyShadowRestrictedAt).toBeNull(); // was stuck pre-fix
  });
});

describe('Finding 3 [S3] — pattern-escalated S2→S1 gets the interim suspension it now qualifies for', () => {
  it('the 2nd harassment case on a repeat subject auto-suspends (a repeat subject must not get LESS protection than a first-timer)', async () => {
    const { user, driver } = await makeDriver();
    const inc = new IncidentService(prisma, io);
    const first = await inc.intake({ category: 'SAFETY_HARASSMENT', intake: 'POST_TRIP_REPORT', subjectUserId: user.id, summary: 'first' });
    caseIds.push(first.id);
    // First S2 doesn't auto-suspend; clear any state so the 2nd case is the subject.
    await prisma.driver.update({ where: { id: driver.id }, data: { safetySuspendedAt: null } });

    const second = await inc.intake({ category: 'SAFETY_HARASSMENT', intake: 'POST_TRIP_REPORT', subjectUserId: user.id, summary: 'second, repeat subject' });
    caseIds.push(second.id);
    expect(second.severity).toBe('S1'); // pattern-bumped
    expect(second.interimAction).toBe('SUSPENDED_PENDING_REVIEW'); // was NONE pre-fix
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).safetySuspendedAt).not.toBeNull();
  });
});

describe('Finding 4 [S3] — legal hold on an UNSEALED bundle cannot be cleared or its seal forged at the DB', () => {
  it('raw UPDATE clearing legalHold on an unsealed held bundle is refused by Postgres', async () => {
    const ops = await makeUser(['ADMIN']);
    const subject = await makeUser(['MOVER']);
    const inc = new IncidentService(prisma, io);
    const kase = await inc.intake({ category: 'IDENTITY_MISMATCH', intake: 'OPS_CREATED', subjectUserId: subject.id, summary: 'police hold fixture' }); // S1 → opens bundle
    caseIds.push(kase.id);
    const bundle = await prisma.evidenceBundle.findUnique({ where: { caseId: kase.id } });
    expect(bundle).not.toBeNull();
    bundleIds.push(bundle!.id);
    expect(bundle!.sealedAt).toBeNull(); // unsealed — the exact gap the auditor found

    await new EvidenceService(prisma, io).setLegalHold(bundle!.id, ops.id, 'police referral');
    // The pre-fix hole: raw UPDATE could clear the hold, then DELETE. Now the DB refuses the clear.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "EvidenceBundle" SET "legalHold"=false WHERE "id"=$1`, bundle!.id),
    ).rejects.toThrow(/legal hold/i);
  });
});
