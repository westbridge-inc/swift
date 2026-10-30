import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRO_FEE_COVERED_COPY, PRO_FEE_COVERED_TICK_LINE, PRO_FEE_RUNNING_TICK_LINE, proFeeAgreementFirst, proFeeBanner, proFeeChangedLine, proFeeNoFeeWords, proFeeTick, proFeeTickRunningLine,
  proFeeTickStartsLine, type ProFeeStanding,
} from './providerFee';
import { providerVerificationPresentation } from '../modules/services/serviceCatalogPresentation';

// [BILL-PRO PR5] A pro's fee, drawn only from what the server states.
const TERMS = { version: 'v1', items: [{ heading: 'What it covers', text: 'The Swift app.' }], tick: 'I understand the weekly fee.', amount: 8000, currencyCode: 'GYD', acknowledged: false };

const ON: ProFeeStanding = { required: true, operable: false, why: 'FEE_TERMS', source: null, subscriptionId: null };
const OFF: ProFeeStanding = { required: false, operable: true };
const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the "I understand the weekly fee" tick', () => {
  it('is shown with the server\'s words and amount until the server says it is given', () => {
    expect(proFeeTick({ data: null, standing: ON, feeTerms: TERMS })).toEqual({
      kind: 'tick', key: 'v1:8000:GYD', terms: { version: 'v1', items: TERMS.items, tick: TERMS.tick }, ack: { version: 'v1', amount: 8000, currencyCode: 'GYD' },
    });
    expect(proFeeTick({ data: null, standing: ON, feeTerms: { ...TERMS, acknowledged: true } })).toEqual({ kind: 'none' });
    expect(proFeeTick({ data: null, standing: ON })).toEqual({ kind: 'none' });
    expect(proFeeTick(null)).toEqual({ kind: 'none' });
  });

  it('[REVIEW-F #2231 S4-5] is never asked while the fee is not required (switch off), whatever the API serves', () => {
    expect(proFeeTick({ data: null, standing: OFF, feeTerms: TERMS })).toEqual({ kind: 'none' });
    expect(proFeeTick({ data: null, feeTerms: TERMS })).toEqual({ kind: 'none' });
  });

  it('[REVIEW-F #2231 S3-1] is given to ONE amount: a new amount is a new key, and the screen keeps a tick only for its key', () => {
    const at8 = proFeeTick({ data: null, standing: ON, feeTerms: TERMS });
    const at9 = proFeeTick({ data: null, standing: ON, feeTerms: { ...TERMS, amount: 9000 } });
    expect(at8.kind === 'tick' && at9.kind === 'tick' && at8.key !== at9.key).toBe(true);
    const s = src('src/modules/services/screens/ProviderWeeklyFeeScreen.tsx');
    expect(s).toContain("const ticked = tick.kind === 'tick' && tickedFor === tick.key;");
    expect(s).toContain('onToggle={() => setTickedFor(ticked ? null : tick.key)}');
    expect(s).not.toMatch(/useState\(false\);\s*\n[^\n]*setTicked\b/);
    expect(s).toContain('disabled={!ticked || ack.isPending}');
  });

  it('[REVIEW-G #2230 S3-1] the fee changed since the tick: names both amounts and asks again', () => {
    const view = { data: null, standing: ON, feeTerms: { ...TERMS, amount: 9000, changed: true, acknowledgedAmount: 8000, acknowledgedCurrencyCode: 'GYD' } };
    expect(proFeeChangedLine(view)).toBe('The weekly fee changed from $8,000 to $9,000 a week. Read it again and tick \u201cI understand the weekly fee\u201d to confirm the new amount. Nothing starts at the new amount until you do.');
    expect(proFeeChangedLine({ ...view, feeTerms: { ...view.feeTerms, changed: false } })).toBeNull();
    expect(proFeeChangedLine({ ...view, standing: OFF })).toBeNull();
    expect(proFeeChangedLine({ data: null, standing: ON, feeTerms: TERMS })).toBeNull(); // an older API: no `changed`
    expect(src('src/modules/services/screens/ProviderWeeklyFeeScreen.tsx')).toContain('const changed = proFeeChangedLine(view);');
  });

  it('[REVIEW-F #2231 S4-4] says the tick starts the fee for an approved pro; never for a covered or unapproved one', () => {
    const view = { data: null, standing: ON, feeTerms: TERMS };
    expect(proFeeTickStartsLine(view, true)).toMatch(/^Ticking this starts your weekly fee today: first a 14-day free trial/);
    expect(proFeeTickStartsLine(view, false)).toBeNull();
    expect(proFeeTickStartsLine({ ...view, coveredBy: 'STORE' }, true)).toBeNull();
  });

  it('[REVIEW-F #2231 S4] the agreement not accepted: never "ticking this starts your fee"; the agreement words and Review button instead', () => {
    const view = { data: null, standing: { ...ON, why: 'AGREEMENT' as const }, feeTerms: TERMS };
    // The tick is still asked (both ticks), but it cannot start the fee until the agreement is accepted.
    expect(proFeeTick(view).kind).toBe('tick');
    expect(proFeeTickStartsLine(view, true)).toBeNull();
    expect(proFeeTickStartsLine({ ...view, standing: { ...ON, why: 'MISSING' as const } }, true)).toBeNull();
    expect(proFeeTickStartsLine({ data: null, standing: ON, feeTerms: TERMS }, true)).not.toBeNull(); // only FEE_TERMS
    expect(proFeeAgreementFirst(view)).toEqual({
      title: 'Accept the Business Agreement first',
      body: 'Your weekly fee can start only after you accept the Business Agreement that covers service providers. Ticking here does not start it on its own, and you are not listed until both are done.',
    });
    expect(proFeeAgreementFirst({ data: null, standing: ON, feeTerms: TERMS })).toBeNull();
    expect(proFeeAgreementFirst({ ...view, feeTerms: { ...TERMS, acknowledged: true } })).toBeNull(); // no tick asked: the no-fee card says it
    expect(proFeeAgreementFirst({ ...view, standing: OFF })).toBeNull();
    const s = src('src/modules/services/screens/ProviderWeeklyFeeScreen.tsx');
    expect(s).toContain('const agreementFirst = proFeeAgreementFirst(view);');
    // The agreement card itself (up to its own </Card>) carries the words AND the Review button.
    const card = /\{agreementFirst \? \(\s*<Card>((?:(?!<\/Card>)[\s\S])*)<\/Card>/.exec(s)?.[1] ?? '';
    expect(card).toContain('{agreementFirst.title}');
    expect(card).toContain('{agreementFirst.body}');
    expect(card).toContain('<ReviewAgreementButton />');
  });
});

describe('[REVIEW-F #2231 S3-2] no fee of their own: the words follow where the server says the pro stands', () => {
  const view = (standing: ProFeeStanding) => ({ data: null, standing });
  it('switch off: nothing starts until Swift tells them', () => {
    expect(proFeeNoFeeWords(view(OFF), true)).toMatchObject({ title: 'No weekly fee yet', action: null });
  });
  it('agreement not accepted: asks for it, with the button', () => {
    expect(proFeeNoFeeWords(view({ ...ON, why: 'AGREEMENT' }), true)).toMatchObject({ title: 'Accept the Business Agreement', action: 'AGREEMENT' });
  });
  it('documents not approved: starts after approval; never "nothing is charged until Swift tells you"', () => {
    const w = proFeeNoFeeWords(view({ ...ON, why: 'MISSING' }), false);
    expect(w.title).toBe('Your weekly fee starts after approval');
    expect(w.body).toContain('You are not listed until then.');
  });
  it('ticked and approved but not born yet (or a store cover just ended): being set up, not listed until it is', () => {
    const w = proFeeNoFeeWords(view({ ...ON, why: 'MISSING' }), true);
    expect(w.title).toBe('Your weekly fee is being set up');
    expect(w.body).toContain('You are not listed until it is set up');
    expect(w.body).not.toContain('Nothing is charged until then');
  });
});

describe('[REVIEW-F #2231 S3-3 · S4-1 · S4-3] a covered pro and a fee behind the tick', () => {
  it('a covered pro asked to tick is told why, so it never reads as a second charge', () => {
    expect(PRO_FEE_COVERED_TICK_LINE).toContain('it applies only if your store\u2019s weekly fee ends');
    expect(PRO_FEE_COVERED_TICK_LINE).toContain('you pay only that one');
    expect(src('src/modules/services/screens/ProviderWeeklyFeeScreen.tsx')).toMatch(/view\?\.coveredBy === 'STORE' \? \([\s\S]*PRO_FEE_COVERED_TICK_LINE/);
  });
  it('a fee that exists stays one tap away behind the tick or the store cover (PINV-8)', () => {
    const s = src('src/modules/services/screens/ProviderWeeklyFeeScreen.tsx');
    expect(s).toContain("if (view?.data && (showOwnFee || (tick.kind === 'none' && !view.coveredBy))) {");
    expect(s).toContain("{view?.data && !showOwnFee && (tick.kind === 'tick' || view.coveredBy === 'STORE') ? (");
  });
});

describe('[REVIEW-F #2231 S3-4] the dashboard and the fee screen never go stale', () => {
  it('accepting the agreement re-reads the pro\'s standing and fee', () => {
    const s = src('src/components/LegalAcceptanceModal.tsx');
    expect(s).toContain("void qc.invalidateQueries({ queryKey: ['services', 'provider-me'] });");
    expect(s).toContain("void qc.invalidateQueries({ queryKey: ['provider', 'fee'] });");
  });
  it('the dashboard reads the standing again on focus (back from the fee screen or the agreement)', () => {
    const s = src('src/modules/services/screens/ServiceProviderScreen.tsx');
    expect(s).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\s*void refetchProfile\(\);\s*void qc\.invalidateQueries\(\{ queryKey: \['provider', 'fee'\] \}\);/);
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

describe('[REVIEW-M #2238 S4-1] a pro whose fee is already running is asked to tick again (new words)', () => {
  const born = { data: { id: 's1', status: 'ACTIVE' } as never, standing: ON, feeTerms: TERMS };
  it('never "Ticking this starts your weekly fee today" (no new trial): the fee runs, and a price change is told in advance', () => {
    expect(proFeeTick(born).kind).toBe('tick');
    expect(proFeeTickStartsLine(born, true)).toBeNull();
    expect(proFeeTickRunningLine(born)).toBe(PRO_FEE_RUNNING_TICK_LINE);
    expect(PRO_FEE_RUNNING_TICK_LINE).toContain('does not start a new free trial');
    expect(PRO_FEE_RUNNING_TICK_LINE).toContain('told to you in advance');
  });
  it('before the fee is born, or with nothing to tick, or covered by the store\'s fee: no running line', () => {
    expect(proFeeTickRunningLine({ data: null, standing: ON, feeTerms: TERMS })).toBeNull();
    expect(proFeeTickRunningLine({ ...born, feeTerms: { ...TERMS, acknowledged: true } })).toBeNull();
    expect(proFeeTickRunningLine({ ...born, coveredBy: 'STORE' })).toBeNull();
    expect(proFeeTickRunningLine({ ...born, standing: OFF })).toBeNull();
  });
  it('the agreement card never says the fee "can start only after" when it already runs', () => {
    const card = proFeeAgreementFirst({ ...born, standing: { ...ON, why: 'AGREEMENT' } });
    expect(card?.title).toBe('Accept the Business Agreement first');
    expect(card?.body).not.toMatch(/can start only after/);
    expect(card?.body).toBe('You are not listed and take no new jobs until you accept the Business Agreement that covers service providers. Ticking here does not do that on its own.');
  });
  it('the screen shows the running line under the tick', () => {
    const s = src('src/modules/services/screens/ProviderWeeklyFeeScreen.tsx');
    expect(s).toContain('const runningLine = proFeeTickRunningLine(view);');
    expect(s).toMatch(/\{runningLine \? <T [^>]*>\{runningLine\}<\/T> : null\}/);
  });
});
