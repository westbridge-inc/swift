import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { serveEmergencyPolicy, setEmergencyPolicy } from '../modules/country/emergency-policy';

// ---------------------------------------------------------------------------
// [L10 §2] The owner confirmed Guyana's numbers (police 911, fire 912,
// ambulance 913, all verified, 5 Oct 2026). The ops script stores them on the
// market's CountryConfig — the one setting the phone and the trip page read —
// idempotently, through the same validation the public route serves with.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL']! } } });
let original: Prisma.JsonValue = null;
// The script sits outside this package's rootDir (src), so it is loaded by
// path, the way the livetest suites load theirs; tsconfig.scripts.json
// type-checks the script itself.
let GY_EMERGENCY_POLICY: Record<'police' | 'fire' | 'ambulance', { number: string; verified: boolean }>;

beforeAll(async () => {
  ({ GY_EMERGENCY_POLICY } = await import(pathToFileURL(join(__dirname, '../../scripts/set-emergency-policy.ts')).href));
  original = (await prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { emergency: true } })).emergency;
});
afterAll(async () => {
  await prisma.countryConfig.update({ where: { code: 'GY' }, data: { emergency: original === null ? Prisma.DbNull : (original as Prisma.InputJsonValue) } });
  await prisma.$disconnect();
});

describe('[L10 §2] the Guyana emergency policy script', () => {
  it('records the owner-confirmed numbers, all verified', () => {
    expect(GY_EMERGENCY_POLICY.police).toMatchObject({ number: '911', verified: true });
    expect(GY_EMERGENCY_POLICY.fire).toMatchObject({ number: '912', verified: true });
    expect(GY_EMERGENCY_POLICY.ambulance).toMatchObject({ number: '913', verified: true });
  });

  it('stores them once (a second run changes nothing) and the public route then serves exactly them, signed', async () => {
    await prisma.countryConfig.update({ where: { code: 'GY' }, data: { emergency: Prisma.DbNull } });
    expect((await setEmergencyPolicy(prisma, 'GY', GY_EMERGENCY_POLICY)).status).toBe('updated');
    expect((await setEmergencyPolicy(prisma, 'gy', GY_EMERGENCY_POLICY)).status).toBe('unchanged');
    const served = await serveEmergencyPolicy(prisma, 'GY');
    expect(served.status).toBe('served');
    if (served.status !== 'served') return;
    expect(served.signed.numbers).toMatchObject({
      police: { number: '911', verified: true }, fire: { number: '912', verified: true }, ambulance: { number: '913', verified: true },
    });
  });

  it('refuses a policy the phone could not trust, and writes nothing', async () => {
    const before = (await prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { emergency: true } })).emergency;
    await expect(setEmergencyPolicy(prisma, 'GY', { police: { number: '911', verified: true } })).rejects.toThrow(/verification date/);
    await expect(setEmergencyPolicy(prisma, 'GY', { police: { number: 'call-me', verified: false } })).rejects.toThrow(/dialable/);
    await expect(setEmergencyPolicy(prisma, 'XQ', GY_EMERGENCY_POLICY)).rejects.toThrow(/no such market/);
    expect((await prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { emergency: true } })).emergency).toEqual(before);
  });
});
