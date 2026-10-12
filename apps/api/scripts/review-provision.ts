/**
 * [STA-1 operator runbook] review:provision | review:seed | review:status | review:rotate | review:expire <sessionId>
 *
 *   pnpm review:provision -- --slug review-apple-2026-09 [--ttl-days 14]   (CUSTOMER, RIDER and DRIVER logins)
 *   pnpm review:seed      -- --slug review-apple-2026-09   (the Part 6 content pack + the verified rider and taxi driver; idempotent; REVIEW tenants only)
 *   pnpm review:status    -- --slug review-apple-2026-09
 *   pnpm review:rotate    -- --slug review-apple-2026-09
 *   pnpm review:expire    -- <sessionId>
 *
 * Codes are printed ONCE, here, for the store review notes. Nothing else ever
 * shows them: the database holds a salted hash.
 */
import { PrismaClient } from '@prisma/client';
import { provisionReviewTenant, rotateReviewCredentials, expireReviewSession, reviewStatus } from '../src/modules/review/provision';
import { seedReviewContentPack, partnersComplete, PACK_IMAGE_LICENCE } from '../src/modules/review/content-pack';

const prisma = new PrismaClient();
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

async function main(): Promise<number> {
  switch (cmd) {
    case 'provision': {
      const slug = flag('slug'); if (!slug) { console.error('usage: provision --slug review-<name> [--ttl-days N]'); return 2; }
      const r = await provisionReviewTenant(prisma, { slug, ttlDays: flag('ttl-days') ? Number(flag('ttl-days')) : undefined });
      console.log(`tenant ${r.tenantId} (REVIEW, purge-protected) · session ${r.sessionId} expires ${r.expiresAt.toISOString()}`);
      for (const c of r.credentials) console.log(`  ${c.role}: ${c.identifier}  code ${c.code}   ← store review notes; shown once`);
      console.log(`content pack: ${r.contentPack}${r.contentPack === 'PRESENT' ? '' : ` — run: pnpm review:seed -- --slug ${r.tenantId}`}`);
      return 0;
    }
    case 'seed': {
      const slug = flag('slug'); if (!slug) { console.error('usage: seed --slug review-<name>'); return 2; }
      const r = await seedReviewContentPack(prisma, { slug });
      console.log(`content pack ${r.version} on ${r.tenantId} (REVIEW): ${r.stores}/${r.expectedStores} stores (${r.orderableStores} open for orders), ${r.categories} categories, ${r.items}/${r.expectedItems} items in GYD — ${r.state}`);
      console.log(`partners: rider ${r.partners.RIDER.ready}/${r.partners.RIDER.credentials} ready to go online, taxi driver ${r.partners.DRIVER.ready}/${r.partners.DRIVER.credentials} ready to go online (${r.partnerDocumentsCommitted} fixture document(s) committed this run)`);
      if (!partnersComplete(r.partners)) console.log(`partners incomplete: mint the rider and driver logins with: pnpm review:provision -- --slug ${r.tenantId}, then run this seed again`);
      console.log(`images: ${PACK_IMAGE_LICENCE}`);
      console.log('checkout, taxi and parcel bookings in this tenant are refused with a friendly message (DL-5): no order, no money, no provider; the partners’ job boards are empty by design, they owe no weekly fee and receive no SMS');
      return r.state === 'PRESENT' ? 0 : 1;
    }
    case 'status': {
      const slug = flag('slug'); if (!slug) { console.error('usage: status --slug review-<name>'); return 2; }
      console.log(JSON.stringify(await reviewStatus(prisma, slug), null, 2));
      return 0;
    }
    case 'rotate': {
      const slug = flag('slug'); if (!slug) { console.error('usage: rotate --slug review-<name>'); return 2; }
      const minted = await rotateReviewCredentials(prisma, slug);
      for (const c of minted) console.log(`  ${c.role}: ${c.identifier}  code ${c.code}   ← update the store review notes; shown once`);
      console.log(`${minted.length} credential(s) rotated; the previous codes stopped working now`);
      return minted.length ? 0 : 1;
    }
    case 'expire': {
      const id = rest[0]; if (!id) { console.error('usage: expire <sessionId>'); return 2; }
      const verdict = await expireReviewSession(prisma, id);
      console.log(`${id}: ${verdict}`);
      return verdict === 'EXPIRED' ? 0 : 1;
    }
    default:
      console.error('usage: review-provision.ts provision|seed|status|rotate|expire …');
      return 2;
  }
}

main().then((code) => prisma.$disconnect().then(() => process.exit(code))).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
