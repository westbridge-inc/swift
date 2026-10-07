/**
 * [L10 §2] Set Guyana's emergency numbers on the market's CountryConfig — the
 * ONE server setting the phone dials from and the public trip page shows.
 *
 * Values: police 911, fire 912, ambulance 913, all verified — confirmed by the
 * owner on 5 Oct 2026. This file is the record of that confirmation; app
 * logic never hard-codes these numbers (only the phone's offline fallback
 * carries them, apps/mobile/src/lib/emergencyPolicy.ts).
 *
 * Idempotent: running it again changes nothing. A dry run by default: it
 * prints what it would store and writes only with
 *   EMERGENCY_POLICY_CONFIRM=SET_GY_EMERGENCY_POLICY
 * Usage (from apps/api, with DATABASE_URL pointing at the target database):
 *   npx tsx scripts/set-emergency-policy.ts
 */
import { PrismaClient } from '@prisma/client';
import { setEmergencyPolicy, parseEmergencyPolicy } from '../src/modules/country/emergency-policy';

const CONFIRMATION = 'SET_GY_EMERGENCY_POLICY';
const COUNTRY = 'GY';
const CONFIRMED_AT = '2026-10-05T00:00:00.000Z';
const CONFIRMED_BY = 'owner';

export const GY_EMERGENCY_POLICY = {
  police: { number: '911', verified: true, verifiedAt: CONFIRMED_AT, verifiedBy: CONFIRMED_BY },
  fire: { number: '912', verified: true, verifiedAt: CONFIRMED_AT, verifiedBy: CONFIRMED_BY },
  ambulance: { number: '913', verified: true, verifiedAt: CONFIRMED_AT, verifiedBy: CONFIRMED_BY },
} as const;

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
  const { problem } = parseEmergencyPolicy(COUNTRY, GY_EMERGENCY_POLICY);
  if (problem) throw new Error(`The recorded policy is invalid: ${problem}`);
  const prisma = new PrismaClient();
  try {
    const row = await prisma.countryConfig.findUnique({ where: { code: COUNTRY }, select: { emergency: true } });
    if (!row) throw new Error(`No ${COUNTRY} market row — run the platform seed first`);
    console.log(`[emergency-policy] ${COUNTRY} now: ${JSON.stringify(row.emergency)}`);
    console.log(`[emergency-policy] ${COUNTRY} to store: ${JSON.stringify(GY_EMERGENCY_POLICY)}`);
    if (process.env['EMERGENCY_POLICY_CONFIRM'] !== CONFIRMATION) {
      console.log(`[emergency-policy] dry run — set EMERGENCY_POLICY_CONFIRM=${CONFIRMATION} to write`);
      return;
    }
    const res = await setEmergencyPolicy(prisma, COUNTRY, GY_EMERGENCY_POLICY);
    console.log(`[emergency-policy] ${COUNTRY}: ${res.status}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('set-emergency-policy.ts')) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
