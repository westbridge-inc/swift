/**
 * [STORE-VAT · owner O-5 · REVIEW-F #2085 S4 · REVIEW-M S4-2] What the store is told when a PERSON decides its VAT, in
 * VAT words (never the generic "Document approved": approving the certificate alone changes nothing for customers).
 * The approval asks the store to check each item's class first: every item starts as standard-rated, so zero-rated
 * staples would show VAT until the store marks them (the store's responsibility; it is told so).
 */
import { STORE_VAT_RATE_PERCENT } from './vat-rate';

/** The reviewer's words as one sentence: trimmed, ending in a full stop. */
function sentence(reason: string): string {
  const t = reason.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function storeVatApprovedNotice(v: { registeredName: string; number: string; effectiveFrom: Date; ratePercent?: number }): { title: string; body: string } {
  return {
    title: 'Your VAT is approved',
    body: `A person at Swift checked your GRA VAT certificate. From ${v.effectiveFrom.toISOString().slice(0, 10)}, your prices include VAT at `
      + `${v.ratePercent ?? STORE_VAT_RATE_PERCENT}% and your receipts say “VAT charged by ${v.registeredName} · VAT reg. no. ${v.number}”. `
      + 'Check each item’s VAT class now: zero-rated and exempt goods carry no VAT.',
  };
}

export function storeVatRejectedNotice(reason: string): { title: string; body: string } {
  return {
    title: 'Your VAT was not approved',
    body: `${sentence(reason)} Correct it and send your GRA VAT certificate again. Nothing changed for your customers.`,
  };
}

export function storeVatWithdrawnNotice(reason: string): { title: string; body: string } {
  return {
    title: 'Your VAT was withdrawn',
    body: `${sentence(reason)} New orders carry no VAT and your prices no longer say “incl. VAT”. Orders already placed keep their VAT.`,
  };
}
