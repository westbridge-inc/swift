import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { FloatService } from './float.service';

// D.3 FloatService — method-level coverage of the float lifecycle (the gate
// itself is covered end-to-end by acceptance #2). Uses a real GY rider fixture.
const prisma = new PrismaClient();
const float = new FloatService(prisma);
const PHONE = '+5920009820';
let userId = '';
let riderId = '';

async function cleanup() {
  const u = await prisma.user.findUnique({ where: { phone: PHONE }, select: { id: true } });
  if (!u) return;
  await prisma.rider.deleteMany({ where: { userId: u.id } });
  await prisma.user.delete({ where: { id: u.id } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.countryConfig
    .update({ where: { code: 'GY' }, data: { floatL1: 8000, floatL2: 20000, floatL3: 40000 } })
    .catch(() => undefined);
  const u = await prisma.user.create({
    data: {
      phone: PHONE,
      firstName: 'Float',
      lastName: 'Test',
      roles: ['RIDER'],
      activeRole: 'RIDER',
      isPhoneVerified: true,
      countryCode: 'GY',
      trustLevel: 'L1',
    },
  });
  userId = u.id;
  const r = await prisma.rider.create({ data: { userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } });
  riderId = r.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('FloatService (D.3)', () => {
  it('floatLimitFor returns the per-trust-level limit', async () => {
    expect(await float.floatLimitFor('GY', 'L1')).toBe(8000);
    expect(await float.floatLimitFor('GY', 'L2')).toBe(20000);
    expect(await float.floatLimitFor('GY', 'L3')).toBe(40000);
  });

  it('recomputeForUser sets the rider limit from trust + country', async () => {
    await float.recomputeForUser(userId);
    const r = await prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(Number(r.floatLimit)).toBe(8000); // L1 → floatL1
  });

  it('commit increments committedFloat and available reflects it', async () => {
    await float.commit(prisma, riderId, 5000);
    const r = await prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(Number(r.committedFloat)).toBe(5000);
    expect(float.available(r)).toBe(3000); // 8000 − 5000
  });

  it('release decrements and clamps at zero (never negative)', async () => {
    await float.release(prisma, riderId, 9999); // over-release
    const r = await prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(Number(r.committedFloat)).toBe(0); // clamped, not −4999
  });

  it('concurrent releases are atomic — every one counts, no lost update', async () => {
    // Five committed cash orders for one rider, all terminating at once.
    await prisma.rider.update({ where: { id: riderId }, data: { committedFloat: 5000 } });
    await Promise.all(Array.from({ length: 5 }, () => float.release(prisma, riderId, 1000)));
    const r = await prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    // All five decrements applied → 0. The old read-then-write would let racing
    // releases read the same value and clobber each other, leaving float stuck > 0.
    expect(Number(r.committedFloat)).toBe(0);
  });
});
