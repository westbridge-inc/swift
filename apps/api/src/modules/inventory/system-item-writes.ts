import { Prisma, type PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// [RETIER · REVIEW-M #2259 S4-1] Swift's own writes to a store's listings.
//
// `items."updatedAt"` means "the store changed this listing": a new store's fee
// (partner/store-fee.ts catalogueCountWhere) and the weekly re-tier
// (billing.service weekCatalogueWhere) count a listing that is not for sale when
// it was changed in the last 7 days, so hiding listings just before a count
// changes nothing. A re-tier notice tells a store how to stop a rise: have fewer
// items for sale by a named day, then add none and leave every item that is not
// for sale as it is. So a write the STORE did not make must never move that
// stamp, or a store that did exactly that is still counted and charged:
// a customer's order selling an item out, a cancelled order putting stock back,
// a picker's substitution, Swift's reviewers, a lapsed check hiding a store's
// listings, an account being wound down or erased.
//
// Prisma stamps `@updatedAt` on every `item.update` / `updateMany` / `upsert`.
// So every write here is plain SQL that never names "updatedAt" (as #2255's VAT
// reconcile, store-vat/vat-pricing.ts). A store's own writes (the item editor,
// stock counts, in-store sales, a till file it confirms, removing a listing)
// stay where they are and keep the stamp.
//
// `system-item-writes.test.ts` is the gate: a source census of every item writer
// in the API (each file is either the store's or Swift's), and a database test
// per write here proving the stamp stays put and the count does not move.
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

/** A moment as a timestamp(3) column holds it (UTC), whatever the session's time zone (as billing/settlement-import.ts). */
export const asUtcColumn = (at: Date): Prisma.Sql => Prisma.sql`(${at}::timestamptz AT TIME ZONE 'UTC')`;

/** A sale or a picker's substitution took the last unit: the stock engine hides the listing ("zero hides, restock
 *  un-hides"). Only while it is still for sale and its count is at or below zero, as before. */
export async function hideSoldOut(db: Db, itemId: string, now: Date = new Date()): Promise<number> {
  return db.$executeRaw`
    UPDATE "items" SET "isAvailable" = false, "autoHiddenAt" = ${asUtcColumn(now)}
     WHERE "id" = ${itemId} AND "isAvailable" = true AND "stockQuantity" IS NOT NULL AND "stockQuantity" <= 0`;
}

/** [Q12] The store's per-listing order counter, counted once per order the store can see. */
export async function countItemsOrdered(db: Db, itemIds: readonly string[]): Promise<number> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return 0;
  return db.$executeRaw`UPDATE "items" SET "totalOrdered" = "totalOrdered" + 1 WHERE "id" IN (${Prisma.join(ids)})`;
}

/** A store whose checks lapsed (`onlyForSale: false`: every listing) or an account wound down (`onlyForSale: true`)
 *  goes dark: its listings are taken off sale by Swift, not by the store. */
export async function hideStoreListings(db: Db, vendorIds: readonly string[], opts: { onlyForSale: boolean }): Promise<number> {
  if (vendorIds.length === 0) return 0;
  const forSale = opts.onlyForSale ? Prisma.sql`AND "isAvailable" = true` : Prisma.empty;
  return db.$executeRaw`UPDATE "items" SET "isAvailable" = false WHERE "vendorId" IN (${Prisma.join([...vendorIds])}) ${forSale}`;
}

/** The owner's account is being erased: every listing photo's address is cleared (archived listings included). */
export async function clearListingPhotos(db: Db, vendorId: string): Promise<number> {
  return db.$executeRaw`UPDATE "items" SET "imageUrl" = NULL WHERE "vendorId" = ${vendorId} AND "imageUrl" IS NOT NULL`;
}

/** [GUARDRAILS §8] A person at Swift removed this listing as prohibited: one way, once (only a row not already
 *  removed), in this tenant. Returns how many rows it removed (0 = already removed). */
export async function markListingProhibited(
  db: Db,
  input: { itemId: string; tenantId: string; prohibitedClass: string; reason: string; at?: Date },
): Promise<number> {
  return db.$executeRaw`
    UPDATE "items"
       SET "prohibitedAt" = ${asUtcColumn(input.at ?? new Date())}, "prohibitedClass" = ${input.prohibitedClass},
           "prohibitedReason" = ${input.reason}, "isAvailable" = false
     WHERE "id" = ${input.itemId} AND "tenantId" = ${input.tenantId} AND "prohibitedAt" IS NULL`;
}

/** A person at Swift approved exactly these words of a held listing. */
export async function approveListingWords(db: Db, input: { itemId: string; tenantId: string; wordsHash: string; at?: Date }): Promise<number> {
  return db.$executeRaw`
    UPDATE "items" SET "reviewApprovedHash" = ${input.wordsHash}, "reviewApprovedAt" = ${asUtcColumn(input.at ?? new Date())}
     WHERE "id" = ${input.itemId} AND "tenantId" = ${input.tenantId}`;
}
