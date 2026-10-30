import { describe, it, expect } from 'vitest';
import { calendarDay, storeVatApprovedNotice, storeVatRejectedNotice, storeVatWithdrawnNotice } from '../modules/store-vat/store-vat-notices';

// [STORE-VAT · REVIEW-F #2085 S4 · REVIEW-M S4-2] The store's VAT notices: what changed, in VAT words; the approval asks for
// item classes first; never "tax invoice"; the reviewer's reason reads as one sentence.
describe('store VAT notices', () => {
  it('approval: the date, the rate, the receipt words, and the item classes to check', () => {
    expect(storeVatApprovedNotice({ registeredName: 'Shop Ltd', number: '012345678', effectiveFrom: new Date('2026-01-01T00:00:00Z') })).toEqual({
      title: 'Your VAT is approved',
      body: 'A person at Swift checked your GRA VAT certificate. Your certificate is in effect from 1 Jan 2026. From now on, your prices include VAT at 14% and your receipts say '
        + '“VAT charged by Shop Ltd · VAT reg. no. 012345678”. Check each item’s VAT class now: zero-rated and exempt goods carry no VAT.',
    });
  });

  it('[VAT-DOCS] approval and withdrawal for a store whose VAT Swift adds to its typed prices', () => {
    expect(storeVatApprovedNotice({ registeredName: 'Shop Ltd', number: '012345678', effectiveFrom: new Date('2026-01-01T00:00:00Z'), mode: 'ADD_VAT_AT_CHECKOUT' }).body).toBe(
      'A person at Swift checked your GRA VAT certificate. Your certificate is in effect from 1 Jan 2026. From now on, Swift adds VAT at 14% to the prices you type for '
      + 'standard-rated items, so customers see and pay prices that include VAT, and your receipts say “VAT charged by Shop Ltd · VAT reg. no. 012345678”. '
      + 'Check each item’s VAT class now: zero-rated and exempt goods carry no VAT.');
    expect(storeVatWithdrawnNotice('GRA cancelled it.', 'ADD_VAT_AT_CHECKOUT').body).toBe('GRA cancelled it. New orders carry no VAT and your prices no longer say “incl. VAT”. '
      + 'Swift no longer adds VAT to your prices: customers pay the prices you typed. Orders already placed keep their VAT.');
    expect(storeVatWithdrawnNotice('GRA cancelled it.', 'PRICES_INCLUDE_VAT').body).toBe(storeVatWithdrawnNotice('GRA cancelled it.').body);
  });

  it('[REVIEW-F #2102 S4] the effective date as people read it, the calendar day itself (never the evening before)', () => {
    expect(calendarDay(new Date('2026-09-01T00:00:00Z'))).toBe('1 Sep 2026');
    expect(calendarDay(new Date('2026-12-31T00:00:00Z'))).toBe('31 Dec 2026');
  });

  it('a refusal and a withdrawal carry the reviewer’s reason as one sentence', () => {
    expect(storeVatRejectedNotice(' The photo is unreadable ').body).toBe('The photo is unreadable. Correct it and send your GRA VAT certificate again. Nothing changed for your customers.');
    expect(storeVatWithdrawnNotice('GRA cancelled it.').body).toBe('GRA cancelled it. New orders carry no VAT and your prices no longer say “incl. VAT”. Orders already placed keep their VAT.');
  });

  it('no notice ever says invoice', () => {
    for (const n of [storeVatApprovedNotice({ registeredName: 'A', number: '1', effectiveFrom: new Date() }), storeVatRejectedNotice('x'), storeVatWithdrawnNotice('y')]) {
      expect(`${n.title} ${n.body}`.toLowerCase()).not.toContain('invoice');
    }
  });
});
