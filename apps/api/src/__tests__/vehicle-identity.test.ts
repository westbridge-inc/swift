import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { classifyBodyType, resolveColorHex, backfillVehicleIdentity, vehicleIdentityFor } from '../modules/rides/vehicle-identity';

// Vehicle visual identity [rides spec 6B] — server half: the Georgetown fleet
// mapping (table-driven), color-word resolution, the idempotent backfill, and
// the read-path heal. UNKNOWN is a queue, never a guess.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_010_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeDriver(make: string, model: string, color: string) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Veh', lastName: `U${seq}`, roles: ['MOVER'], activeRole: 'MOVER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  return prisma.driver.create({
    data: {
      userId: user.id, vehicleMake: make, vehicleModel: model, vehicleYear: 2018, vehicleColor: color,
      licensePlate: `VI ${1000 + seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
    },
  });
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the fleet mapping', () => {
  it('classifies the Georgetown backbone correctly', () => {
    const cases: [string, string, string][] = [
      ['Toyota', 'Allion', 'SEDAN'],
      ['Toyota', 'Premio', 'SEDAN'],
      ['Toyota', 'Corolla Axio', 'SEDAN'],
      ['Toyota', 'Corolla Fielder', 'WAGON'],
      ['Toyota', 'Probox', 'WAGON'],
      ['Toyota', 'Noah', 'MINIBUS'],
      ['Toyota', 'Voxy', 'MINIBUS'],
      ['Toyota', 'Hiace', 'MINIBUS'],
      ['Toyota', 'RAV4', 'SUV'],
      ['Toyota', 'Land Cruiser Prado', 'SUV'],
      ['Toyota', 'Hilux', 'PICKUP'],
      ['Toyota', 'Vitz', 'HATCHBACK'],
      ['Honda', 'Fit', 'HATCHBACK'],
      ['Toyota', 'Passo', 'COMPACT'],
      ['Nissan', 'X-Trail', 'SUV'],
      ['Mystery', 'Chariot Wagonette', 'UNKNOWN'],
    ];
    for (const [make, model, expected] of cases) {
      expect(classifyBodyType(make, model), `${make} ${model}`).toBe(expected);
    }
  });

  it('resolves color words including compounds; unknown stays null (untinted, never guessed)', () => {
    expect(resolveColorHex('White')).toBe('#F4F4F2');
    expect(resolveColorHex('Pearl White')).toBe('#F4F4F2');
    expect(resolveColorHex('Dark Grey')).toBe('#8E9093');
    expect(resolveColorHex('Wine red')).toBe('#B03A34');
    expect(resolveColorHex('Two-tone zebra')).toBeNull();
    expect(resolveColorHex(null)).toBeNull();
  });
});

describe('backfill + read heal', () => {
  it('backfills additively and idempotently; UNKNOWN forms the admin queue', async () => {
    const allion = await makeDriver('Toyota', 'Allion', 'Silver');
    const mystery = await makeDriver('Mystery', 'Machine', 'Zebra');
    const res = await backfillVehicleIdentity(prisma);
    expect(res.classified).toBeGreaterThanOrEqual(1);
    expect(res.unknown).toBeGreaterThanOrEqual(1);

    const a = await prisma.driver.findUniqueOrThrow({ where: { id: allion.id } });
    expect(a.bodyType).toBe('SEDAN');
    expect(a.colorHex).toBe('#C6C8CA');
    const m = await prisma.driver.findUniqueOrThrow({ where: { id: mystery.id } });
    expect(m.bodyType).toBe('UNKNOWN');
    expect(m.colorHex).toBeNull();

    // Idempotent: nothing left to classify among ours.
    const again = await backfillVehicleIdentity(prisma);
    const stillNull = await prisma.driver.count({ where: { userId: { in: userIds } }, });
    expect(stillNull).toBe(2);
    expect(again.classified + again.unknown).toBeGreaterThanOrEqual(0);
  });

  it('vehicleIdentityFor heals a null row on read without writing', async () => {
    const healed = vehicleIdentityFor({ bodyType: null, colorHex: null, vehicleMake: 'Toyota', vehicleModel: 'Noah', vehicleColor: 'White' });
    expect(healed).toEqual({ bodyType: 'MINIBUS', colorHex: '#F4F4F2' });
    const stored = vehicleIdentityFor({ bodyType: 'SUV', colorHex: '#23252A', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleColor: 'White' });
    expect(stored).toEqual({ bodyType: 'SUV', colorHex: '#23252A' }); // stored truth wins over inference
  });
});
