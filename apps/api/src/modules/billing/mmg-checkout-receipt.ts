import type { MmgCheckoutIntent } from '@prisma/client';

// ---------------------------------------------------------------------------
// [MMG support lookup] The two references a partner can quote to support, on
// every checkout the partner routes return (MMG-CHECKOUT-API.md section 5):
//   - swiftReference: ours, the merchantTransactionId sent to MMG. Always.
//   - mmgTransactionId: MMG's transaction, only once MMG's own records
//     confirmed it (CONFIRMED). A transaction a reply merely NAMED (a
//     CONFIRMING or HELD checkout) is a lead for a person, never a receipt:
//     showing it would read as "paid" before Swift has credited anything.
// One rule, used by the service's view and the subscription payload alike.
// ---------------------------------------------------------------------------

export interface PartnerReceiptIds {
  swiftReference: string;
  mmgTransactionId: string | null;
}

export function partnerReceiptIds(intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'mmgTransactionId' | 'status'>): PartnerReceiptIds {
  return {
    swiftReference: intent.merchantTransactionId,
    mmgTransactionId: intent.status === 'CONFIRMED' ? intent.mmgTransactionId : null,
  };
}
