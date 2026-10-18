import { formatPhoneForDisplay } from './phoneDisplay';

/**
 * [R3 · Consumer Affairs Act 2011 s.70 · legal research D10 + E5] The seller block every store page shows — the
 * same block the website's store page prints, projected by the API (GET /customer/vendors/:id `seller`). A fact
 * Swift does not hold arrives as null and reads "Ask the store", never a blank and never a guess; the statutory
 * sentence comes from the API too, so the app and the website print the same words.
 */
export interface StorefrontSeller {
  legalName: string | null;
  address: string | null;
  phone: string | null;
  payment: { cash: true; storeMmg: boolean };
  refundRule: string | null;
  statutoryRights: string;
}

export const ASK_THE_STORE = 'Ask the store';

/** How payment works: cash at handover always; MMG only into the store's own account, when it offers it. */
export function sellerPaymentLine(payment: StorefrontSeller['payment']): string {
  return payment.storeMmg
    ? 'Cash at handover, or MMG straight to the store’s own MMG account'
    : 'Cash at handover';
}

/** The labelled facts, in the order the page shows them; the refund rule's row is followed by `statutoryRights`. */
export function sellerFacts(seller: StorefrontSeller): Array<{ label: string; value: string }> {
  return [
    { label: 'Legal name', value: seller.legalName ?? ASK_THE_STORE },
    { label: 'Business address', value: seller.address ?? ASK_THE_STORE },
    { label: 'Phone', value: seller.phone ? formatPhoneForDisplay(seller.phone) : ASK_THE_STORE },
    { label: 'How payment works', value: sellerPaymentLine(seller.payment) },
    { label: 'Refunds', value: seller.refundRule ?? ASK_THE_STORE },
  ];
}
