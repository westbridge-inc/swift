/**
 * Go-Live demo-data purge + pre-launch cleanliness check [LIVE-001, engagement #4].
 *
 * TWO jobs:
 *   1. VERIFY a production-bound DB is demo-free before launch (the common case:
 *      a fresh prod DB seeded only by seed-production.ts has zero demo → this
 *      exits "clean, safe to launch").
 *   2. PURGE the demo layer if it leaked in (guarded, backup-required, FK-safe).
 *
 * SAFETY (this deletes irreversibly — it is DRY-RUN unless forced):
 *   - Dry-run by default: classifies + reports, deletes NOTHING.
 *   - Classifies every user into DEMO / ADMIN(keep) / SPINE(keep) / UNCLASSIFIED.
 *     UNCLASSIFIED = neither a demo marker nor an admin (e.g. leftover test
 *     accounts). It is NEVER deleted automatically — it's surfaced for a human,
 *     because "everything that isn't spine" is too blunt a hammer for a purge.
 *   - Admins (ADMIN/SUPER_ADMIN) and the platform spine (CountryConfig, Zone)
 *     are always preserved.
 *   - Executing requires ALL of: PURGE_EXECUTE=1, PURGE_CONFIRM_BACKUP=YES
 *     (you asserting a backup exists), and a real (non-local) DATABASE_URL is
 *     the caller's responsibility to point at. Even then it only removes the
 *     DEMO set unless PURGE_INCLUDE_UNCLASSIFIED=1 is ALSO set.
 *
 * Run (from apps/api, where @prisma/client resolves):
 *   cd apps/api
 *   DATABASE_URL=... npx tsx ../../scripts/go-live/purge-demo.ts               # dry-run report
 *   DATABASE_URL=... PURGE_EXECUTE=1 PURGE_CONFIRM_BACKUP=YES \
 *     npx tsx ../../scripts/go-live/purge-demo.ts                             # purge the DEMO set
 */
import { PrismaClient } from '@prisma/client';

// seed.ts creates every demo account in the +592600XXXX range (see prisma/seed.ts).
const DEMO_PHONE_PREFIX = '+592600';

const prisma = new PrismaClient();

async function main() {
  const execute = process.env['PURGE_EXECUTE'] === '1' && process.env['PURGE_CONFIRM_BACKUP'] === 'YES';
  const includeUnclassified = process.env['PURGE_INCLUDE_UNCLASSIFIED'] === '1';

  const [total, admins, demoUsers, spine] = await Promise.all([
    prisma.user.count(),
    prisma.user.findMany({ where: { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } }, select: { id: true } }),
    prisma.user.findMany({ where: { phone: { startsWith: DEMO_PHONE_PREFIX } }, select: { id: true, roles: true } }),
    Promise.all([prisma.countryConfig.count(), prisma.zone.count().catch(() => 0)]),
  ]);

  const adminIds = new Set(admins.map((a) => a.id));
  // A demo account that is ALSO an admin (e.g. SEED_ADMIN_PHONE set inside the
  // demo range) is KEPT — never delete an admin.
  const demoDeletable = demoUsers.filter((u) => !adminIds.has(u.id));
  const demoIds = demoDeletable.map((u) => u.id);
  const unclassified = total - adminIds.size - demoUsers.length;

  // What the demo users own (headline cascade — the rest cascades on delete).
  const [demoVendors, demoOrders] = await Promise.all([
    prisma.vendor.count({ where: { owner: { userId: { in: demoIds } } } }),
    prisma.order.count({ where: { customerId: { in: demoIds } } }),
  ]);

  console.log('\n=== Swift Go-Live · demo-data classification ===');
  console.log(`DATABASE: ${(process.env['DATABASE_URL'] || '').replace(/:[^:@]*@/, ':****@')}`);
  console.log(`\nusers total: ${total}`);
  console.log(`  KEEP  admins (ADMIN/SUPER_ADMIN):        ${adminIds.size}`);
  console.log(`  DELETE demo (${DEMO_PHONE_PREFIX}XXXX, non-admin): ${demoDeletable.length}  → ${demoVendors} vendor(s), ${demoOrders} order(s) cascade`);
  console.log(`  REVIEW unclassified (neither demo nor admin): ${unclassified}  ← NEVER auto-deleted`);
  console.log(`\nKEEP platform spine: ${spine[0]} CountryConfig · ${spine[1]} Zone`);

  if (demoDeletable.length === 0 && unclassified === 0) {
    console.log('\n✅ CLEAN: only the platform spine and admin(s) remain — safe to launch.');
  } else if (unclassified > 0) {
    console.log(`\n⚠️  ${unclassified} unclassified account(s) exist (likely leftover test data). A production DB seeded only by seed-production.ts would show 0 here. Review before launch; this tool will not delete them unless PURGE_INCLUDE_UNCLASSIFIED=1.`);
  }

  if (!execute) {
    console.log('\nDRY-RUN — nothing was deleted. To purge the DEMO set:');
    console.log('  PURGE_EXECUTE=1 PURGE_CONFIRM_BACKUP=YES npx tsx scripts/go-live/purge-demo.ts');
    return;
  }

  // --- execute path (guarded) ---------------------------------------------
  const toDelete = includeUnclassified
    ? (await prisma.user.findMany({ where: { NOT: { roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } } }, select: { id: true } })).map((u) => u.id)
    : demoIds;
  console.log(`\n🗑  EXECUTING: deleting ${toDelete.length} account(s) and their owned data (backup asserted)…`);
  // FK-safe: delete owned vendors (cascades their catalog/orders) then the users
  // (cascades sessions/carts/ratings). Relies on the schema's onDelete rules;
  // run inside a transaction so a failure rolls back wholly.
  await prisma.$transaction(async (tx) => {
    await tx.vendor.deleteMany({ where: { owner: { userId: { in: toDelete } } } });
    await tx.user.deleteMany({ where: { id: { in: toDelete } } });
  });
  console.log('✅ Purge complete. Re-run the dry-run to confirm a clean spine.');
}

main()
  .catch((e) => { console.error('purge failed:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
