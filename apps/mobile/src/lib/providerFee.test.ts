import { describe, expect, it } from 'vitest';
import { PRO_FEE_COVERED_COPY, proFeeBanner, proFeeTick } from './providerFee';
import { providerVerificationPresentation } from '../modules/services/serviceCatalogPresentation';

// [BILL-PRO PR5] A pro's fee, drawn only from what the server states.
const TERMS = { version: 'v1', items: [{ heading: 'What it covers', text: 'The Swift app.' }], tick: 'I understand the weekly fee.', amount: 8000, currencyCode: 'GYD', acknowledged: false };

describe('the "I understand the weekly fee" tick', () => {
  it('is shown with the server\'s words and amount until the server says it is given', () => {
    expect(proFeeTick({ data: null, feeTerms: TERMS })).toEqual({
      kind: 'tick', key: 'v1:8000:GYD', terms: { version: 'v1', items: TERMS.items, tick: TERMS.tick }, ack: { version: 'v1', amount: 8000, currencyCode: 'GYD' },
    });
    expect(proFeeTick({ data: null, feeTerms: { ...TERMS, acknowledged: true } })).toEqual({ kind: 'none' });
    expect(proFeeTick({ data: null })).toEqual({ kind: 'none' });
    expect(proFeeTick(null)).toEqual({ kind: 'none' });
  });
});

describe('the dashboard never says "Live" while the server says the pro is not listed', () => {
  const fee = (why: string) => ({ required: true as const, operable: false, why: why as never, source: null, subscriptionId: null });
  it('names the one thing to do', () => {
    expect(proFeeBanner({ isVerified: true, listed: false, fee: fee('AGREEMENT') })).toMatchObject({ listed: false, action: 'AGREEMENT' });
    expect(proFeeBanner({ isVerified: true, listed: false, fee: fee('FEE_TERMS') })?.body).toMatch(/I understand the weekly fee/);
    expect(proFeeBanner({ isVerified: true, listed: false, fee: fee('STATUS') })).toMatchObject({ action: 'FEE', body: 'Pay this week’s fee to be listed again. Jobs already booked can still go ahead.' });
    expect(proFeeBanner({ isVerified: true, listed: false, fee: fee('GRACE_LAPSED') })?.action).toBe('FEE');
  });
  it('says nothing for a listed pro, an unverified one, a pro with no fee required, or an older API', () => {
    expect(proFeeBanner({ isVerified: true, listed: true, fee: { required: true, operable: true, why: null, source: 'OWN', subscriptionId: 's' } })).toBeNull();
    expect(proFeeBanner({ isVerified: false, listed: false, fee: fee('STATUS') })).toBeNull();
    expect(proFeeBanner({ isVerified: true, listed: true, fee: { required: false, operable: true } })).toBeNull();
    expect(proFeeBanner({ isVerified: true })).toBeNull();
  });
  it('the status pill follows `listed`; without it the documents decide, as before', () => {
    expect(providerVerificationPresentation(undefined, true, false)).toMatchObject({ label: 'Not listed', live: false });
    expect(providerVerificationPresentation(undefined, true, true)).toMatchObject({ label: 'Live', live: true });
    expect(providerVerificationPresentation(undefined, true)).toMatchObject({ label: 'Live', live: true });
    expect(providerVerificationPresentation(undefined, false, false)).toMatchObject({ live: false });
  });
});

describe('[REVIEW-M #2229 N1 · Business Agreement s.12] the words a store-covered pro reads', () => {
  it('say one fee (the store\'s) and that an in-flight provider-fee payment is kept as credit', () => {
    expect(PRO_FEE_COVERED_COPY).toContain('covers your provider profile: you pay one fee');
    expect(PRO_FEE_COVERED_COPY).toContain('kept as credit on your provider fee, never lost');
    expect(PRO_FEE_COVERED_COPY).not.toMatch(/needs no separate fee/);
  });
});
