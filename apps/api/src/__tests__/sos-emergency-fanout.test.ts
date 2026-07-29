import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { SosService } from '../modules/safety/sos.service';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// SOS fan-out to emergency contacts (safety §5) — the payoff of the contact
// engine: when an alert goes ACTIVE, every VERIFIED contact is SMS'd (with a
// last-known-location link), in priority order, and an unproven number is never
// reached. io is stubbed; the SMS channel is the dev logger.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
let sos: SosService;
const userIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;
const phone = () => `+${592_707_000_000 + Math.floor(Math.random() * 60_000_000) + (seq += 1)}`;

async function seedActorWithContacts() {
  const user = await prisma.user.create({ data: { phone: phone(), firstName: 'Rae', lastName: 'A', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(user.id);
  const verifiedPhone = phone();
  const unverifiedPhone = phone();
  await prisma.emergencyContact.create({ data: { userId: user.id, name: 'Mom', phoneE164: verifiedPhone, priority: 1, verifiedAt: new Date() } });
  await prisma.emergencyContact.create({ data: { userId: user.id, name: 'Unproven', phoneE164: unverifiedPhone, priority: 2 } }); // verifiedAt null
  return { user, verifiedPhone, unverifiedPhone };
}

beforeAll(async () => {
  await prisma.$connect();
  sos = new SosService(prisma, io);
});
beforeEach(() => resetDevChannelLog());
afterAll(async () => {
  await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('SOS fan-out → emergency contacts', () => {
  it('an ACTIVE alert SMSs VERIFIED contacts (with location) but never unverified ones', async () => {
    const { user, verifiedPhone, unverifiedPhone } = await seedActorWithContacts();
    const alert = await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', immediate: true, lat: 6.8, lng: -58.15 });
    alertIds.push(alert.id);

    const toVerified = devChannelLog.find((e) => e.channel === 'sms' && e.to === verifiedPhone);
    const toUnverified = devChannelLog.find((e) => e.channel === 'sms' && e.to === unverifiedPhone);
    expect(toVerified).toBeTruthy();
    expect(toVerified!.body).toContain('emergency SOS');
    expect(toVerified!.body).toContain('Rae'); // the person in danger, so the contact knows who
    expect(toVerified!.body).toContain('maps.google.com'); // last-known-location link
    expect(toUnverified).toBeFalsy(); // an unproven number is never reached

    const fresh = await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } });
    const receipts = fresh.deliveryReceipts as { contacts?: Array<{ id: string; ok: boolean }> };
    expect(receipts.contacts).toHaveLength(1);
    expect(receipts.contacts![0]!.ok).toBe(true);
  });

  it('an alert with no verified contacts fans out cleanly (no contacts receipt, no throw)', async () => {
    const user = await prisma.user.create({ data: { phone: phone(), firstName: 'Solo', lastName: 'B', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(user.id);
    const alert = await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', immediate: true });
    alertIds.push(alert.id);
    const fresh = await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect((fresh.deliveryReceipts as { contacts?: unknown }).contacts).toBeUndefined();
  });

  it('omits the location line when the trigger had no coordinates', async () => {
    const { user, verifiedPhone } = await seedActorWithContacts();
    const alert = await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', immediate: true });
    alertIds.push(alert.id);
    const toVerified = devChannelLog.find((e) => e.channel === 'sms' && e.to === verifiedPhone);
    expect(toVerified).toBeTruthy();
    expect(toVerified!.body).not.toContain('maps.google.com');
  });

  it('ops resolving the alert sends the contacts an all-clear (loop closed), preserving the original receipts', async () => {
    const { user, verifiedPhone } = await seedActorWithContacts();
    const alert = await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', triggerSource: 'OPS_MANUAL' }); // ACTIVE now
    alertIds.push(alert.id);
    resetDevChannelLog(); // drop the initial SOS SMS — we assert the resolution notice

    await sos.resolve(alert.id, 'ops-1', 'SAFE_CONFIRMED', 'called back, safe');
    const allClear = devChannelLog.find((e) => e.channel === 'sms' && e.to === verifiedPhone);
    expect(allClear).toBeTruthy();
    expect(allClear!.body).toContain('closed by our safety team');

    const fresh = await prisma.sosAlert.findUniqueOrThrow({ where: { id: alert.id } });
    const receipts = fresh.deliveryReceipts as { contacts?: unknown[]; resolvedNotice?: Array<{ ok: boolean }> };
    expect(receipts.resolvedNotice).toHaveLength(1);
    expect(receipts.resolvedNotice![0]!.ok).toBe(true);
    expect(receipts.contacts).toHaveLength(1); // original fan-out receipts NOT clobbered
  });

  it('"I\'m safe" does NOT send an all-clear — only ops closing does (coercion doctrine)', async () => {
    const { user, verifiedPhone } = await seedActorWithContacts();
    const alert = await sos.create({ actorUserId: user.id, actorRole: 'CUSTOMER', triggerSource: 'OPS_MANUAL' }); // ACTIVE
    alertIds.push(alert.id);
    resetDevChannelLog();
    await sos.markSafe(alert.id);
    const sms = devChannelLog.find((e) => e.channel === 'sms' && e.to === verifiedPhone);
    expect(sms).toBeFalsy(); // a coerced tap must not tell contacts the coast is clear
  });
});
