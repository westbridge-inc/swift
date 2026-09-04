import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  openEscrow,
  responseAuthorityFor,
  releaseSafetyDeletionHold,
  shredExpiredSafetyHolds,
  finalPurge,
  ESCROW_FIELDS,
  ESCROW_OWNER_ROLE,
} from '../modules/safety/deletion-hold';
import { SosService } from '../modules/safety/sos.service';

// ---------------------------------------------------------------------------
// [AG-XF-013] Account deletion can sever an ACTIVE SOS or an open safety case.
//
// The seven proofs below are the spec's own mandatory red list, named as it
// names them. Each one failed before this change:
//
//   • the deletion preflight gated on Orders and ServiceJobs and nothing else
//     — the whole file mentioned safety twice, both times inside one comment;
//   • `emergencyContact` rows were deleted outright, so the queued emergency
//     SMS was skipped as `contact-unverified-or-gone` and the all-clear was
//     never sent to the people already told an emergency was happening;
//   • the User row became "Deleted User" / `deleted:<id>`, and `SosAlert`
//     carries no name or number of its own, so the ops desk holding a LIVE
//     alert could no longer identify or call the person it was about.
//
// The fix is NOT a refusal. Refusing would give an abuser a reason to keep an
// account alive and a malicious reporter a way to block an erasure forever.
// Erasure completes in full; only the minimum response authority is escrowed,
// encrypted, and it shreds itself the moment the last obligation closes.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
// Unique per FILE — two suites sharing a prefix collide on User.phone.
const phoneBase = 592_814_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeCustomer(firstName = 'Ama') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName,
      lastName: `Hold${seq}`,
      email: `hold${seq}-${nanoid(6)}@example.com`,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'hold', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { userId: user.id, token };
}

/** A verified contact — the fan-out skips unverified numbers by design. */
async function makeContact(userId: string, phone: string, name = 'Sister') {
  return app.prisma.emergencyContact.create({
    data: { userId, name, phoneE164: phone, priority: 1, verifiedAt: new Date() },
  });
}

async function makeActiveSos(actorUserId: string) {
  return app.prisma.sosAlert.create({
    data: { actorUserId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date() },
  });
}

const deleteAccount = (token: string) =>
  app.inject({ method: 'DELETE', url: '/api/v1/customer/account', headers: { authorization: `Bearer ${token}` } });

const holdFor = (userId: string) => app.prisma.safetyDeletionHold.findUnique({ where: { userId } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.safetyDeletionHold.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.sosEscalation.deleteMany({ where: { sosAlert: { actorUserId: { in: userIds } } } }).catch(() => undefined);
  await app.prisma.evidenceItem.deleteMany({ where: { bundle: { subjectUserId: { in: userIds } } } }).catch(() => undefined);
  await app.prisma.evidenceBundle.deleteMany({ where: { subjectUserId: { in: userIds } } }).catch(() => undefined);
  await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: userIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[AG-XF-013] deletion under a live safety hold', () => {
  it('delete_with_ACTIVE_SOS_returns_pending_hold_and_preserves_minimum_response', async () => {
    const u = await makeCustomer('Ama');
    const contact = await makeContact(u.userId, `+${phoneBase + 900000 + seq}`);
    await makeActiveSos(u.userId);

    const res = await deleteAccount(u.token);
    expect(res.statusCode).toBe(200);
    // The erasure is ACCEPTED — refusing is the wrong extreme.
    expect(res.json().data).toMatchObject({ deleted: true, status: 'PENDING_SAFETY_HOLD' });
    expect(res.json().data.holdReasons).toContain('ACTIVE_SOS');

    const hold = await holdFor(u.userId);
    expect(hold, 'no escrow was staged — the emergency has been severed').toBeTruthy();
    expect(hold!.status).toBe('PENDING');

    // The escrow declares itself: purpose, fields, owner, review and purge
    // deadline are all legible WITHOUT decrypting anything.
    expect(hold!.purpose).toMatch(/emergency|hold/i);
    expect(hold!.fields).toEqual([...ESCROW_FIELDS]);
    expect(hold!.ownerRole).toBe(ESCROW_OWNER_ROLE);
    expect(hold!.purgeBy.getTime()).toBeGreaterThan(hold!.reviewBy.getTime());

    // And it actually holds the minimum response authority.
    const payload = await openEscrow(hold!);
    expect(payload, 'the escrow did not decrypt').toBeTruthy();
    expect(payload!.firstName).toBe('Ama');
    expect(payload!.emergencyContacts.map((c) => c.id)).toContain(contact.id);
    expect(payload!.emergencyContacts[0]!.phoneE164).toBe(contact.phoneE164);
  });

  it('commerce_sessions_and_public_profile_end_immediately_despite_hold', async () => {
    const u = await makeCustomer('Bibi');
    await makeContact(u.userId, `+${phoneBase + 910000 + seq}`);
    await app.prisma.address.create({
      data: { userId: u.userId, label: 'Home', addressLine1: '1 Main St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1 },
    });
    await makeActiveSos(u.userId);

    expect((await deleteAccount(u.token)).statusCode).toBe(200);

    // A hold delays NOTHING the person asked for. Everything erasure does, it
    // still did — the escrow is not a reason to keep an account alive.
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(user.status).toBe('DEACTIVATED');
    expect(user.firstName).toBe('Deleted');
    expect(user.phone.startsWith('deleted:')).toBe(true);
    expect(user.email).toBeNull();
    expect(await app.prisma.session.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.address.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.emergencyContact.count({ where: { userId: u.userId } })).toBe(0);
  });

  it('SOS_resolution_uses_case_recipients_after_contact_purge', async () => {
    const u = await makeCustomer('Chandra');
    const phone = `+${phoneBase + 920000 + seq}`;
    await makeContact(u.userId, phone);
    const alert = await makeActiveSos(u.userId);
    await deleteAccount(u.token);

    // The live rows are gone — this is precisely the state in which every
    // safety path used to go quiet.
    expect(await app.prisma.emergencyContact.count({ where: { userId: u.userId } })).toBe(0);

    const authority = await responseAuthorityFor(app.prisma, u.userId);
    expect(authority.fromEscrow).toBe(true);
    expect(authority.who, 'the all-clear would have named "Deleted"').toBe('Chandra');
    expect(authority.contacts.map((c) => c.phoneE164)).toContain(phone);

    // And the resolve path reaches them: a `resolvedNotice` receipt only
    // exists if fanOutResolved got past the zero-contacts early return.
    await new SosService(app.prisma, app.io).resolve(alert.id, 'ops-test', 'FALSE_ALARM');
    const after = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } });
    const receipts = (after.deliveryReceipts as Record<string, unknown> | null) ?? {};
    expect(receipts, 'the people who were alarmed were never told it ended').toHaveProperty('resolvedNotice');
  });

  it('hold_release_runs_final_idempotent_erasure', async () => {
    const u = await makeCustomer('Devi');
    await makeContact(u.userId, `+${phoneBase + 930000 + seq}`);
    const alert = await makeActiveSos(u.userId);
    await deleteAccount(u.token);
    expect((await holdFor(u.userId))!.status).toBe('PENDING');

    // Resolving the alert removes the last obligation, so erasure finishes on
    // its own — nobody has to remember to come back for it.
    await new SosService(app.prisma, app.io).resolve(alert.id, 'ops-test', 'FALSE_ALARM');
    const purged = await holdFor(u.userId);
    expect(purged!.status).toBe('PURGED');
    expect(purged!.dek, 'the key survived — this is not a crypto-shred').toBeNull();
    expect(purged!.ciphertext).toBeNull();
    expect(purged!.shreddedAt).toBeTruthy();
    expect(await openEscrow(purged!)).toBeNull();

    // Idempotent: a second release is a no-op, not a second purge.
    const again = await releaseSafetyDeletionHold(app.prisma, u.userId);
    expect(again.purged).toBe(false);
    expect((await holdFor(u.userId))!.purgeGeneration).toBe(1);
  });

  it('hold stays while ANY obligation remains — one closure is not permission to shred', async () => {
    const u = await makeCustomer('Esther');
    await makeContact(u.userId, `+${phoneBase + 940000 + seq}`);
    const alert = await makeActiveSos(u.userId);
    const kase = await app.prisma.incidentCase.create({
      data: {
        caseNumber: `INC-${nanoid(8).toUpperCase()}`, status: 'OPEN', severity: 'S1', category: 'SAFETY_ASSAULT',
        intake: 'OPS_CREATED', subjectUserId: u.userId, summary: 'test', slaAckBy: new Date(), slaDecideBy: new Date(),
      },
    });
    await deleteAccount(u.token);
    expect((await holdFor(u.userId))!.reasons.sort()).toEqual(['ACTIVE_SOS', 'OPEN_INCIDENT']);

    // Resolve the alert only. The case still binds, so the escrow stands.
    await new SosService(app.prisma, app.io).resolve(alert.id, 'ops-test', 'FALSE_ALARM');
    const still = await holdFor(u.userId);
    expect(still!.status, 'the open case still needs this authority').toBe('PENDING');
    expect(still!.reasons).toEqual(['OPEN_INCIDENT']);
    expect(still!.dek).not.toBeNull();

    await app.prisma.incidentCase.delete({ where: { id: kase.id } });
  });

  it('no_open_case_means_no_safety_escrow', async () => {
    const u = await makeCustomer('Farah');
    await makeContact(u.userId, `+${phoneBase + 950000 + seq}`);

    expect((await deleteAccount(u.token)).json().data).toEqual({ deleted: true });
    // No obligation, no PII kept. An escrow that opens for everyone is a
    // retention policy pretending to be a safety feature.
    expect(await holdFor(u.userId)).toBeNull();
  });

  it('retention_expiry_crypto_shreds_case_identity', async () => {
    const u = await makeCustomer('Gita');
    await makeContact(u.userId, `+${phoneBase + 960000 + seq}`);
    await makeActiveSos(u.userId);
    await deleteAccount(u.token);

    // The alert is never resolved — nobody ever closes it. Indefinite
    // retention is the other way this defect fails.
    await app.prisma.safetyDeletionHold.update({
      where: { userId: u.userId },
      data: { purgeBy: new Date(Date.now() - 1000) },
    });
    const swept = await shredExpiredSafetyHolds(app.prisma);
    expect(swept.shredded).toBeGreaterThanOrEqual(1);

    const row = await holdFor(u.userId);
    expect(row!.status).toBe('PURGED');
    expect(row!.dek).toBeNull();
    expect(await openEscrow(row!)).toBeNull();
    // The row itself remains as the audit trail that the escrow existed and
    // was destroyed — the proof, without the payload.
    expect(row!.purgedAt).toBeTruthy();
    expect(row!.reasons).toContain('ACTIVE_SOS');
  });

  it('deletion_and_case_resolution_race_has_one_final_purge_generation', async () => {
    const u = await makeCustomer('Hema');
    await makeContact(u.userId, `+${phoneBase + 970000 + seq}`);
    await makeActiveSos(u.userId);
    await deleteAccount(u.token);
    const hold = await holdFor(u.userId);

    // Release and the retention sweep firing on the same escrow at the same
    // instant. Exactly one may perform the shred; a second increment would
    // mean two purge generations for one erasure.
    const [a, b, c] = await Promise.all([
      finalPurge(app.prisma, hold!.id, 'hold-released'),
      finalPurge(app.prisma, hold!.id, 'retention-expiry'),
      finalPurge(app.prisma, hold!.id, 'hold-released'),
    ]);
    expect([a, b, c].filter(Boolean)).toHaveLength(1);
    expect((await holdFor(u.userId))!.purgeGeneration).toBe(1);
  });
});
