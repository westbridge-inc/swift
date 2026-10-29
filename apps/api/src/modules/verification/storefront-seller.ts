import type { Prisma, PrismaClient } from '@prisma/client';
import { safeMmgNumber } from '../../utils/mmg-number';
import { offeredStoreMmgPayUrl } from '../../utils/store-mmg';
import { vendorTenantForCaller } from '../vendor/vendor-visibility';
import { compilePublicStorefrontDisclosure, type DisclosureBlock } from './storefront-disclosure';
import { FOOD_HANDLER_CERT_DOC_TYPE } from './doc-registry';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * [R3 · Consumer Affairs Act 2011 s.70 · legal research D10 + E5 · owner 15 Oct 2026] The seller block every store
 * page shows — the app's store screen and the website's store page read this ONE projection:
 *  - who sells: the store's legal name, business address and phone, from the compiled supplier-information block
 *    (storefront-disclosure.ts: VALID records and labelled fallbacks, the phone the store PUBLISHED);
 *  - how payment works: cash at handover always; the store's own MMG only while the checkout would offer it (a valid
 *    MMG number, or a valid pay link while STORE_MMG_PAY_LINK is on), so the page never names a way to pay the
 *    checkout would not offer;
 *  - the store's own refund rule (its owner's words, vendor/refund-rule.ts), then the statutory-rights sentence.
 * Only what is on file: a fact Swift does not hold is null, and the page says "Ask the store" — never a guess.
 * A store whose supplier block is withheld (not live, not approved) has no seller block.
 */

/** Legal research E5, verbatim (owner 15 Oct 2026): shown under every store's refund rule. */
export const STATUTORY_RIGHTS_SENTENCE =
  "This does not affect your rights under Guyana's Consumer Affairs Act 2011 to return goods or get a refund from the business.";

export interface StorefrontSeller {
  legalName: string | null;
  address: string | null;
  phone: string | null;
  /** Cash at handover is always offered; `storeMmg` = paying straight into the store's own MMG account is offered too. */
  payment: { cash: true; storeMmg: boolean };
  refundRule: string | null;
  statutoryRights: string;
  /** [FOOD-PERMIT · owner 24 Oct 2026] The trust badge: a current food handler's certificate is on file (a VALID record
   *  in the compiled block). Optional for a registered restaurant, required of a home cook; never its number. */
  foodHandlerCertificate: boolean;
}

/** Project the seller block from a compiled public disclosure and the store's own payment and refund facts. */
export function storefrontSeller(
  disclosure: DisclosureBlock,
  store: { mmgPayUrl: string | null; mmgNumber?: string | null; refundRule: string | null },
): StorefrontSeller {
  const refundRule = store.refundRule?.trim() || null;
  return {
    legalName: disclosure.legalName?.value ?? null,
    address: disclosure.address?.value ?? null,
    phone: disclosure.contact?.value ?? null,
    // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] "Pay the store directly in MMG" is said only while the
    // checkout would offer it: the store has a valid MMG number (or, only while STORE_MMG_PAY_LINK is
    // on, a valid pay link). The number itself is never on the storefront.
    payment: { cash: true, storeMmg: safeMmgNumber(store.mmgNumber) !== null || offeredStoreMmgPayUrl(store.mmgPayUrl) !== null },
    refundRule,
    statutoryRights: STATUTORY_RIGHTS_SENTENCE,
    foodHandlerCertificate: disclosure.licences.some((licence) => licence.docType === FOOD_HANDLER_CERT_DOC_TYPE),
  };
}

/**
 * The seller block for one store's public page. `disclosure` may be passed when the caller already compiled it
 * (the app's store read does); null = the store's supplier block is withheld, so there is no seller block either.
 * The store's payment link and refund rule are read here and never leave as raw columns.
 */
export async function publicStorefrontSeller(
  db: Db, vendorId: string, disclosure?: DisclosureBlock | null,
): Promise<StorefrontSeller | null> {
  const block = disclosure === undefined ? await compilePublicStorefrontDisclosure(db, vendorId) : disclosure;
  if (!block) return null;
  const store = await db.vendor.findFirst({
    where: { id: vendorId, ...vendorTenantForCaller() },
    select: { mmgPayUrl: true, mmgNumber: true, refundRule: true },
  });
  return store ? storefrontSeller(block, store) : null;
}
