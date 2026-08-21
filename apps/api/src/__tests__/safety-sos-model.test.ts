import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';

// Safety spec M1 — the SOS data model foundation. Proves the schema persists and,
// crucially, that the invariants the M2 SOS engine will lean on hold at the DB:
//   - a fresh alert defaults to TRIGGER_PENDING via BUTTON (the grace-window state)
//   - clientIdempotencyKey is UNIQUE → a retried offline trigger can't create a
//     second alert (the spec's offline-reconciliation / "exactly one alert" rule)
//   - an emergency contact is unique per (user, phone)

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const created: string[] = [];

afterAll(async () => {
  await prisma.sosAlert.deleteMany({ where: { id: { in: created } } });
  await prisma.emergencyContact.deleteMany({ where: { name: 'SOS Test Contact' } });
  await prisma.$disconnect();
});

beforeAll(async () => { await prisma.$connect(); });

describe('SosAlert model [safety M1]', () => {
  it('a new alert is born TRIGGER_PENDING via BUTTON with server timestamps', async () => {
    const a = await prisma.sosAlert.create({
      data: { actorUserId: 'u-' + nanoid(6), actorRole: 'CUSTOMER', orderType: 'TAXI', triggerLat: 6.8, triggerLng: -58.15 },
    });
    created.push(a.id);
    expect(a.status).toBe('TRIGGER_PENDING');
    expect(a.triggerSource).toBe('BUTTON');
    expect(a.tenantId).toBe('swift-default');
    expect(a.triggeredAt).toBeInstanceOf(Date);
    expect(a.resolvedAt).toBeNull();
  });

  it('clientIdempotencyKey is unique PER ACTOR — a retried trigger cannot double-create the alert', async () => {
    const key = 'idem-' + nanoid(10);
    const first = await prisma.sosAlert.create({ data: { actorUserId: 'u1', actorRole: 'MOVER', clientIdempotencyKey: key } });
    created.push(first.id);
    await expect(
      prisma.sosAlert.create({ data: { actorUserId: 'u1', actorRole: 'MOVER', clientIdempotencyKey: key } }),
    ).rejects.toThrow(); // unique violation — the M2 engine dedups on this
  });

  it('[F-026-17] the SAME key from a DIFFERENT actor is a different emergency and must still be storable', async () => {
    // The defect this replaces: the key was globally unique, so the second
    // person to use a string got the first person's alert handed back and
    // their own was never raised. Two people can be in danger at once.
    const key = 'idem-shared-' + nanoid(10);
    const mine = await prisma.sosAlert.create({ data: { actorUserId: 'u-a1', actorRole: 'CUSTOMER', clientIdempotencyKey: key } });
    const theirs = await prisma.sosAlert.create({ data: { actorUserId: 'u-b1', actorRole: 'CUSTOMER', clientIdempotencyKey: key } });
    created.push(mine.id, theirs.id);
    expect(theirs.id).not.toBe(mine.id);
    expect(await prisma.sosAlert.count({ where: { clientIdempotencyKey: key } })).toBe(2);
  });

  it('[F-026-17] a NULL key never collapses two alerts — an actor may raise many keyless triggers', async () => {
    // Postgres treats NULLs as distinct in a unique index; assert it rather
    // than assume it, because the composite would otherwise pin one keyless
    // alert per person forever.
    const a = await prisma.sosAlert.create({ data: { actorUserId: 'u-null-1', actorRole: 'CUSTOMER' } });
    const b = await prisma.sosAlert.create({ data: { actorUserId: 'u-null-1', actorRole: 'CUSTOMER' } });
    created.push(a.id, b.id);
    expect(b.id).not.toBe(a.id);
  });
});

describe('EmergencyContact model [safety M1]', () => {
  it('is unique per (user, phone) so the same contact is not listed twice', async () => {
    const userId = 'u-' + nanoid(6);
    const phone = '+5926001' + Math.floor(Math.random() * 900 + 100);
    await prisma.emergencyContact.create({ data: { userId, name: 'SOS Test Contact', phoneE164: phone, priority: 1 } });
    await expect(
      prisma.emergencyContact.create({ data: { userId, name: 'SOS Test Contact', phoneE164: phone, priority: 2 } }),
    ).rejects.toThrow();
    await prisma.emergencyContact.deleteMany({ where: { userId } });
  });
});
