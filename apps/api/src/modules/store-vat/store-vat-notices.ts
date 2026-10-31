/**
 * [STORE-VAT · owner O-5 · REVIEW-F #2085 S4 · REVIEW-M S4-2] What the store is told when a PERSON decides its VAT, in
 * VAT words (never the generic "Document approved": approving the certificate alone changes nothing for customers).
 * The approval asks the store to check each item's class first: every item starts as standard-rated, so zero-rated
 * staples would show VAT until the store marks them (the store's responsibility; it is told so).
 */
import { STORE_VAT_RATE_PERCENT } from './vat-rate';

/** [REVIEW-F #2102 S4] The certificate's effective date as people read it ("1 Jan 2026"). It is a calendar day (a DATE
 *  column, midnight UTC), so it is read in UTC: never shifted to the evening before. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export function calendarDay(date: Date): string {
  // One fixed month table (not Intl): the web and the phone print the same words ("1 Sep 2026", never "1 Sept 2026").
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The reviewer's words as one sentence: trimmed, ending in a full stop. */
function sentence(reason: string): string {
  const t = reason.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function storeVatApprovedNotice(v: { registeredName: string; number: string; effectiveFrom: Date; ratePercent?: number; mode?: string | null }): { title: string; body: string } {
  const rate = v.ratePercent ?? STORE_VAT_RATE_PERCENT;
  // [VAT-DOCS · owner 30 Oct 2026] A store whose typed prices exclude VAT has the VAT added into each price customers see.
  // [REVIEW-F #2255 S4-1] The VAT is the store's ("VAT charged by <store>"): never worded as Swift adding it.
  const adds = v.mode === 'ADD_VAT_AT_CHECKOUT';
  const prices = adds
    ? `From now on, ${addedWords(rate)}, so customers see and pay prices that include VAT, `
    : `From now on, your prices include VAT at ${rate}% `;
  return {
    title: 'Your VAT is approved',
    // [REVIEW-F #2102 S4-1] Approval needs the effective date to have arrived, so it is often in the past: the date is the
    // certificate's, and VAT is in the store's prices from now on (orders placed before approval carry none).
    body: `A person at Swift checked your GRA VAT certificate. Your certificate is in effect from ${calendarDay(v.effectiveFrom)}. `
      + prices
      + `and your receipts say “VAT charged by ${v.registeredName} · VAT reg. no. ${v.number}”. `
      + (adds ? UNMARKED_ITEMS : 'Check each item’s VAT class now: zero-rated and exempt goods carry no VAT.'),
  };
}

function addedWords(rate: number): string {
  return `VAT at ${rate}% is added to the prices you type for standard-rated items`;
}

/** [REVIEW-F #2255 S3-1] Every item starts standard-rated (Item.vatClass default), so when VAT is added to the store's
 *  prices an item it has not marked zero-rated or exempt costs customers the VAT too: said plainly, with what to do. */
const UNMARKED_ITEMS = 'Swift treats every item as standard-rated until you mark it: until then customers pay VAT on it, so mark your zero-rated and exempt items now.';

/** [VAT-DOCS · owner ruling 31 Oct 2026] A person approved an approved store's change of price choice: what customers
 *  pay changes from now on. */
export function storeVatModeChangeApprovedNotice(mode: string, ratePercent: number = STORE_VAT_RATE_PERCENT): { title: string; body: string } {
  return {
    title: 'Your price change is approved',
    body: 'A person at Swift approved your change. '
      + (mode === 'ADD_VAT_AT_CHECKOUT'
        ? `From now on, ${addedWords(ratePercent)}, so customers see and pay prices that include VAT. ${UNMARKED_ITEMS}`
        : `From now on, your prices include VAT at ${ratePercent}%: customers pay the prices you type.`)
      + ' Orders already placed keep their prices.',
  };
}

/** [VAT-DOCS · owner ruling 31 Oct 2026] A person did not approve the change: nothing moved. */
export function storeVatModeChangeRejectedNotice(reason: string): { title: string; body: string } {
  return {
    title: 'Your price change was not approved',
    body: `${sentence(reason)} Nothing changed: your prices and what customers pay stay as they were.`,
  };
}

export function storeVatRejectedNotice(reason: string): { title: string; body: string } {
  return {
    title: 'Your VAT was not approved',
    body: `${sentence(reason)} Correct it and send your GRA VAT certificate again. Nothing changed for your customers.`,
  };
}

export function storeVatWithdrawnNotice(reason: string, mode?: string | null): { title: string; body: string } {
  return {
    title: 'Your VAT was withdrawn',
    body: `${sentence(reason)} New orders carry no VAT and your prices no longer say “incl. VAT”.`
      // [VAT-DOCS] A store whose VAT was added to its prices gets the prices it typed back.
      + (mode === 'ADD_VAT_AT_CHECKOUT' ? ' VAT is no longer added to your prices: customers pay the prices you typed.' : '')
      + ' Orders already placed keep their VAT.',
  };
}
