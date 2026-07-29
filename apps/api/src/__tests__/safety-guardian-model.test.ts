import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';

// Safety spec M4 — the Trip Guardian data model. Proves the schema persists and
// the invariants the Guardian sweep (M4b/M4c) will lean on hold at the DB:
//   - a fresh session is born MONITORING with the tenant default (one session
//     per monitored trip, opened by the sweep when a taxi goes RIDE_IN_PROGRESS)
//   - orderId is UNIQUE → the sweep can never double-open a session for a trip,
//     no matter how many ticks race (the same "exactly one" rule as SOS idempotency)
//   - the escalation close round-trips: CLOSED/ESCALATED + escalatedToSosId is
//     how a session hands off to the SOS engine and stays auditable
//   - User.enhancedSafetyMonitoring defaults FALSE — enhanced monitoring is
//     opt-in ONLY (spec §5.1: never inferred, protected-data doctrine)

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const sessions: string[] = [];
const users: string[] = [];

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.tripSafetySession.deleteMany({ where: { id: { in: sessions } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

describe('TripSafetySession model [safety M4a]', () => {
  it('a new session is born MONITORING with defaults and server timestamps', async () => {
    const s = await prisma.tripSafetySession.create({
      data: {
        orderId: 'ord-' + nanoid(8),
        orderType: 'TAXI',
        passengerUserId: 'u-' + nanoid(6),
        driverUserId: 'u-' + nanoid(6),
        riskScore: 35,
        riskFactors: ['NIGHT', 'NEW_DRIVER'],
        plannedEtaAt: new Date(Date.now() + 20 * 60_000),
      },
    });
    sessions.push(s.id);
    expect(s.status).toBe('MONITORING');
    expect(s.tenantId).toBe('swift-default');
    expect(s.riskScore).toBe(35);
    expect(s.checkinDeadlineAt).toBeNull();
    expect(s.closedAt).toBeNull();
    expect(s.createdAt).toBeInstanceOf(Date);
  });

  it('orderId is unique — the sweep can never double-open a session for one trip', async () => {
    const orderId = 'ord-' + nanoid(8);
    const first = await prisma.tripSafetySession.create({
      data: { orderId, orderType: 'TAXI', driverUserId: 'u1' },
    });
    sessions.push(first.id);
    await expect(
      prisma.tripSafetySession.create({ data: { orderId, orderType: 'TAXI', driverUserId: 'u1' } }),
    ).rejects.toThrow(); // unique violation — one session per trip, ever
  });

  it('escalation hand-off round-trips: CLOSED/ESCALATED with the SOS id preserved', async () => {
    const s = await prisma.tripSafetySession.create({
      data: { orderId: 'ord-' + nanoid(8), orderType: 'TAXI', driverUserId: 'u2', status: 'CHECKIN_PENDING', checkinDeadlineAt: new Date() },
    });
    sessions.push(s.id);
    const closed = await prisma.tripSafetySession.update({
      where: { id: s.id },
      data: { status: 'CLOSED', closeReason: 'ESCALATED', escalatedToSosId: 'sos-' + nanoid(6), closedAt: new Date() },
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.closeReason).toBe('ESCALATED');
    expect(closed.escalatedToSosId).toMatch(/^sos-/);
  });
});

describe('User.enhancedSafetyMonitoring [safety M4a]', () => {
  it('defaults FALSE — enhanced monitoring is opt-in only, never inferred (§5.1)', async () => {
    const u = await prisma.user.create({
      data: {
        phone: '+59268' + Math.floor(Math.random() * 90000 + 10000),
        firstName: 'Guardian',
        lastName: 'ModelTest',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
      },
    });
    users.push(u.id);
    expect(u.enhancedSafetyMonitoring).toBe(false);
  });
});
