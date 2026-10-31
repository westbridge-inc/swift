/**
 * [VAT-DOCS · owner 30 Oct 2026] "Add VAT at checkout" (StoreVatMode ADD_VAT_AT_CHECKOUT), in ONE place.
 *
 * A VAT-registered store whose prices EXCLUDE VAT types them as it always has. While a PERSON's approval of its VAT
 * stands in that mode, the server adds 14% INTO the price every customer surface shows and every order charges
 * (Item.basePrice, Option.additionalPrice), and keeps what the store typed beside it (Item.vatListedPrice,
 * Option.vatListedAdditionalPrice). The law (sources in vat-rate.ts): an advertised price must include the tax and
 * say so (VAT Act s.90(2); GRA Policy #13: no "tax shock" at checkout), so the VAT is never a line that appears only
 * at the end: the customer sees the full price on the menu, in the cart and at checkout, before ordering, and the
 * order (cash, or the store's own MMG) is for exactly that total.
 *
 * Why the price itself, not a figure added on top of an order total: every money path (cart quote, checkout, the
 * MMG amount, the rider's cash float, substitutions, receipts, the store's VAT report) and every app build already
 * reads basePrice as "what the customer pays". Keeping that one meaning keeps all of them right with no change, and
 * the VAT inside the price is then computed exactly as for a store whose prices already include VAT (vat-math.ts).
 *
 * The rule:
 *   - customer price = the typed price x (1 + 14%), half-up to the whole Guyana dollar (`priceWithVatAdded`; the SQL
 *     below is the same arithmetic, pinned equal by the tests);
 *   - only STANDARD-rated items (and their options) get VAT added; zero-rated and exempt goods carry none (VAT Act
 *     s.17-s.18), so their price stays as typed;
 *   - VAT is added exactly while `storeAddsVatToPrices` holds: a PERSON approved the store, its mode is
 *     ADD_VAT_AT_CHECKOUT, and the number on its profile is still the approved one. The moment any of these stops
 *     (withdrawn, rejected, a new certificate or number sent and waiting, the store says "no" or picks "my prices
 *     already include VAT", the item becomes zero-rated or exempt) every price goes back to what the store typed, in
 *     the same transaction. So a store that is not approved never has VAT added to its prices.
 *   - The STORE_VAT switch is not part of it: with the switch off no approval can be given or changed (decisions
 *     refuse), and a store already approved keeps its VAT-inclusive prices exactly like a store whose typed prices
 *     include VAT (only the "incl. VAT" words and the frozen VAT stop). Withdrawing the store's VAT, or the store
 *     answering "no", puts its typed prices back at any time.
 *
 * Writers: every path that writes a price the store TYPED (item and option editors, file imports, the till sync, a
 * menu copied from another branch) stores it with `typedItemPrice` / `typedOptionPrice` (the derived mark cleared),
 * then calls `reconcileVatPricing` for those items in the same transaction. Every VAT decision calls it for the whole
 * store. `reconcileVatPricing` is the only code that writes vatListedPrice / vatListedAdditionalPrice.
 */
import { Prisma } from '@prisma/client';
import { STORE_VAT_RATE_BPS } from './vat-rate';
import { STORE_VAT_SELECT, type StoreVatRow } from './store-vat';

type Tx = Prisma.TransactionClient;

export const ADD_VAT_MODE = 'ADD_VAT_AT_CHECKOUT';

/** True exactly while a person's approval makes this store's typed prices get VAT added. */
export function storeAddsVatToPrices(row: Pick<StoreVatRow, 'vatStatus' | 'vatMode' | 'vatApprovedNumber' | 'vatApprovedName' | 'vatRegistrationNumber'>): boolean {
  return row.vatStatus === 'APPROVED'
    && row.vatMode === ADD_VAT_MODE
    && !!row.vatApprovedNumber && !!row.vatApprovedName
    && row.vatApprovedNumber === row.vatRegistrationNumber;
}

/** The price a customer pays for a standard-rated price the store typed before VAT: + the rate, half-up to whole GYD.
 *  Exact integer arithmetic (cents as BigInt). */
export function priceWithVatAdded(typed: number | Prisma.Decimal | string, rateBps: number = STORE_VAT_RATE_BPS): number {
  const value = Number(typed);
  if (!Number.isFinite(value) || value < 0) throw new RangeError('VAT: a price is not a finite, non-negative number');
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new RangeError('VAT: the rate is not a whole number of basis points');
  const cents = BigInt(Math.round(value * 100));
  const num = cents * BigInt(10_000 + rateBps);
  const den = 1_000_000n; // 10,000 (basis points) x 100 (cents per dollar)
  return Number((2n * num + den) / (2n * den));
}

/** An item price the store typed: written as typed, with the derived mark cleared (reconcile adds VAT if due). */
export function typedItemPrice(price: number | Prisma.Decimal): { basePrice: number | Prisma.Decimal; vatListedPrice: null } {
  return { basePrice: price, vatListedPrice: null };
}

/** An option's extra price the store typed (same rule as typedItemPrice). */
export function typedOptionPrice(price: number | Prisma.Decimal): { additionalPrice: number | Prisma.Decimal; vatListedAdditionalPrice: null } {
  return { additionalPrice: price, vatListedAdditionalPrice: null };
}

/** What the store typed for this item: its price before VAT while VAT is added, the price itself otherwise. */
export function storeTypedPrice(row: { basePrice: Prisma.Decimal | number | string; vatListedPrice?: Prisma.Decimal | number | string | null }): number {
  return Number(row.vatListedPrice ?? row.basePrice);
}

export class VatPriceBeforeVatRequired extends Error {}

/**
 * A price edit from an app that does not know about "add VAT at checkout" (it shows and sends basePrice, the price
 * customers pay). For an item whose VAT is added: the same number sent back unchanged is no change (every save sends
 * every field); any other number is refused, because it cannot be told whether it is before or after VAT. The caller
 * maps the refusal to 409 VAT_PRICE_BEFORE_VAT. A price sent as `vatListedPrice` (the updated apps) is always the
 * price before VAT.
 */
export function itemPriceEdit(
  existing: { basePrice: Prisma.Decimal | number; vatListedPrice: Prisma.Decimal | number | null },
  body: { basePrice?: number; vatListedPrice?: number },
): ReturnType<typeof typedItemPrice> | null {
  if (body.vatListedPrice !== undefined) return typedItemPrice(body.vatListedPrice);
  if (body.basePrice === undefined) return null;
  if (existing.vatListedPrice === null) return typedItemPrice(body.basePrice);
  if (body.basePrice === Number(existing.basePrice)) return null;
  throw new VatPriceBeforeVatRequired();
}

/** The option twin of itemPriceEdit. */
export function optionPriceEdit(
  existing: { additionalPrice: Prisma.Decimal | number; vatListedAdditionalPrice: Prisma.Decimal | number | null },
  body: { additionalPrice?: number; vatListedAdditionalPrice?: number },
): ReturnType<typeof typedOptionPrice> | null {
  if (body.vatListedAdditionalPrice !== undefined) return typedOptionPrice(body.vatListedAdditionalPrice);
  if (body.additionalPrice === undefined) return null;
  if (existing.vatListedAdditionalPrice === null) return typedOptionPrice(body.additionalPrice);
  if (body.additionalPrice === Number(existing.additionalPrice)) return null;
  throw new VatPriceBeforeVatRequired();
}

/**
 * [REVIEW-M #2255 S4-2] A NEW price from an app that does not know about "add VAT at checkout" (basePrice /
 * additionalPrice without the price before VAT) on a store that adds VAT is as ambiguous as an older app's edit: it
 * cannot be told whether VAT is in it, so it is refused the same way (409 VAT_PRICE_BEFORE_VAT) and nothing is
 * created. Unambiguous, so accepted: the updated apps' price before VAT, a zero-rated or exempt item (no VAT is ever
 * added to it), a free option (0), and any store that adds no VAT. Checked under the same store lock reconcile takes,
 * in the transaction that writes the rows, so an approval can never slip in between.
 */
export async function refuseOlderAppNewPrice(tx: Tx, vendorId: string, ambiguous: boolean, vatClass: string | null | undefined = 'STANDARD'): Promise<void> {
  if (!ambiguous || (vatClass ?? 'STANDARD') !== 'STANDARD') return;
  await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${vendorId} FOR KEY SHARE /* store-vat-pricing */`;
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: STORE_VAT_SELECT });
  if (vendor && storeAddsVatToPrices(vendor)) throw new VatPriceBeforeVatRequired();
}

/** A price an older app sent for a new row, without the price before VAT beside it (a 0 is the same either way). */
export function sentOnlyCustomerPrice(typed: number | undefined, customer: number | undefined): boolean {
  return typed === undefined && customer !== undefined && customer !== 0;
}

export const VAT_PRICE_BEFORE_VAT_MESSAGE =
  'This store adds VAT to its prices, so type the price before VAT. Update the Swift app, or change it on the web dashboard.';

/**
 * Bring the store's prices in line with its VAT: VAT added to every standard-rated item (and its options) while
 * `storeAddsVatToPrices` holds, every price back to what the store typed otherwise. Idempotent; writes only rows that
 * differ. `itemIds` limits it to those items (an item write); absent = the whole store (a VAT decision).
 *
 * Serialised with every VAT decision on the store row: the decisions hold it FOR UPDATE, an item write takes it
 * FOR KEY SHARE here, so an item written while a person approves is either seen by the approval's own reconcile or
 * reconciles itself after the approval committed. Never both missed.
 *
 * [REVIEW-G #2255 S3-1] It never touches items."updatedAt": that stamp means "the store changed this listing" (the
 * weekly re-tier and the fee quote count a hidden listing changed in the last 7 days), and a VAT decision is Swift's
 * write, not the store's. Search is refreshed by the callers (scheduleVendorSearchSync), not by the stamp.
 * [REVIEW-G #2255 S3-2] Every statement is scoped to this store (i."vendorId"): another store's prices never move.
 */
export async function reconcileVatPricing(
  tx: Tx, vendorId: string, opts: { itemIds?: readonly string[]; rateBps?: number } = {},
): Promise<{ added: number; restored: number }> {
  if (opts.itemIds && opts.itemIds.length === 0) return { added: 0, restored: 0 };
  await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${vendorId} FOR KEY SHARE /* store-vat-pricing */`;
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: STORE_VAT_SELECT });
  if (!vendor) return { added: 0, restored: 0 };
  const adds = storeAddsVatToPrices(vendor);
  const bps = opts.rateBps ?? STORE_VAT_RATE_BPS;
  const factor = 10_000 + bps;
  const items = opts.itemIds ? Prisma.sql`AND i."id" IN (${Prisma.join([...opts.itemIds])})` : Prisma.empty;

  let added = 0;
  if (adds) {
    added += await tx.$executeRaw`
      UPDATE "items" AS i
         SET "vatListedPrice" = COALESCE(i."vatListedPrice", i."basePrice"),
             "basePrice" = ROUND(COALESCE(i."vatListedPrice", i."basePrice") * ${factor}::int / 10000, 0)
       WHERE i."vendorId" = ${vendorId} AND i."vatClass" = 'STANDARD' ${items}
         AND (i."vatListedPrice" IS NULL OR i."basePrice" <> ROUND(i."vatListedPrice" * ${factor}::int / 10000, 0))`;
    added += await tx.$executeRaw`
      UPDATE "options" AS o
         SET "vatListedAdditionalPrice" = COALESCE(o."vatListedAdditionalPrice", o."additionalPrice"),
             "additionalPrice" = ROUND(COALESCE(o."vatListedAdditionalPrice", o."additionalPrice") * ${factor}::int / 10000, 0)
        FROM "option_groups" AS g, "items" AS i
       WHERE o."optionGroupId" = g."id" AND g."itemId" = i."id"
         AND i."vendorId" = ${vendorId} AND i."vatClass" = 'STANDARD' ${items}
         AND (o."vatListedAdditionalPrice" IS NULL OR o."additionalPrice" <> ROUND(o."vatListedAdditionalPrice" * ${factor}::int / 10000, 0))`;
  }
  // Back to what the store typed: every item when the store adds no VAT, the zero-rated / exempt ones when it does.
  const notAdded = adds ? Prisma.sql`AND i."vatClass" <> 'STANDARD'` : Prisma.empty;
  let restored = await tx.$executeRaw`
    UPDATE "items" AS i
       SET "basePrice" = i."vatListedPrice", "vatListedPrice" = NULL
     WHERE i."vendorId" = ${vendorId} AND i."vatListedPrice" IS NOT NULL ${notAdded} ${items}`;
  restored += await tx.$executeRaw`
    UPDATE "options" AS o
       SET "additionalPrice" = o."vatListedAdditionalPrice", "vatListedAdditionalPrice" = NULL
      FROM "option_groups" AS g, "items" AS i
     WHERE o."optionGroupId" = g."id" AND g."itemId" = i."id"
       AND i."vendorId" = ${vendorId} AND o."vatListedAdditionalPrice" IS NOT NULL ${notAdded} ${items}`;
  return { added, restored };
}
