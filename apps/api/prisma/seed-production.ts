import { PrismaClient } from '@prisma/client';
import { seedPlatformSpine } from './seed-platform';

/**
 * PRODUCTION seed (SWIFT-010). Seeds ONLY the platform spine — tenant, config,
 * every CountryConfig, launch zones — and NOTHING else. There are zero demo
 * vendors, users, orders, or drivers: a real entity exists only after a real
 * signup → documents → approval → activation (this is the "keep" spine the
 * Go-Live purge preserves, and the state `assertProductionData` demands at boot).
 *
 * The bootstrap admin is NOT hardcoded — a fixed phone in prod would be a
 * standing backdoor. Set SEED_ADMIN_PHONE (E.164) to mint the first SUPER_ADMIN;
 * they then log in via the normal OTP flow. Without it, seed the spine and warn.
 *
 * Run: NODE_ENV=production npx prisma db seed  (with prisma.seed pointed here),
 * or: node --loader ts-node/esm prisma/seed-production.ts
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.warn('Seeding PRODUCTION spine (no demo data)…');
    await seedPlatformSpine(prisma);

    const adminPhone = process.env['SEED_ADMIN_PHONE'];
    if (adminPhone) {
      if (!/^\+[1-9]\d{6,14}$/.test(adminPhone)) {
        throw new Error(`SEED_ADMIN_PHONE must be E.164 (e.g. +5926001000); got "${adminPhone}".`);
      }
      await prisma.user.upsert({
        where: { phone: adminPhone },
        update: { roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] }, activeRole: 'SUPER_ADMIN', status: 'ACTIVE' },
        create: {
          phone: adminPhone,
          firstName: 'Swift',
          lastName: 'Admin',
          roles: ['SUPER_ADMIN', 'CUSTOMER'],
          activeRole: 'SUPER_ADMIN',
          status: 'ACTIVE',
          isPhoneVerified: true,
          admin: { create: { permissions: ['*'] } },
        },
      });
      console.warn(`Bootstrap SUPER_ADMIN ensured for ${adminPhone}.`);
    } else {
      console.warn('SEED_ADMIN_PHONE not set — spine seeded WITHOUT a bootstrap admin. Set it to mint the first SUPER_ADMIN.');
    }

    console.warn('Production spine seed complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
