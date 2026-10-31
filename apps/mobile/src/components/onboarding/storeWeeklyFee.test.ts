import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_ROLES, storeFeeAck, storeFeeCardEnabled, storeFeeCardView, storeFeeKey, storeFeeMoney, storeFeeToTick, tickHolds } from './storeWeeklyFee';
import { GO_LIVE_STEP_WORDS, ownerStepWords } from '../../lib/branches';

// [RETIER PR-A2 · owner 30 Oct 2026] A store whose weekly fee follows its catalogue above the first step goes live
// only after its owner reads that exact fee and ticks it. The figure, why and the words are the server's
// (GET /vendor/onboarding/weekly-fee); the app sends back exactly what it showed, for the store it showed it for, and
// only the owner sees it. Synthetic figures only.

const TERMS = {
  version: 'v1',
  items: [
    { heading: 'What it covers', text: 'The Swift app and its tools for your work.' },
    { heading: 'If the price changes', text: 'Swift tells you in the app at least 14 days before.' },
  ],
  tick: 'I understand the weekly fee.',
};
const view = (over: Record<string, unknown> = {}) => ({
  vendorId: 'v1', set: false, required: true, ticked: false, items: 10000, cardRate: 45000, dealRate: null,
  why: 'It has 10,000 items for sale, so it is on the department store rate of GY$45,000 a week.',
  weeklyFee: { amount: 45000, currencyCode: 'GYD', tier: 'department', version: 'v1' }, terms: TERMS, ...over,
});

describe('[RETIER PR-A2] the store weekly-fee card reads only the server', () => {
  it('a fee to tick: the store, the exact amount, currency, why, the words; the tick sends back exactly that, for that store', () => {
    const fee = storeFeeToTick(view(), 'v1');
    expect(fee).toEqual({ vendorId: 'v1', amount: 45000, currencyCode: 'GYD', version: 'v1', why: view().why, items: TERMS.items, tick: TERMS.tick });
    expect(storeFeeAck(fee!)).toEqual({ vendorId: 'v1', weeklyFeeAck: { version: 'v1', amount: 45000, currencyCode: 'GYD' } });
  });

  it('nothing to tick: not required, already ticked, a fee already set, anything malformed, or an answer about another store', () => {
    expect(storeFeeToTick(view({ required: false }), 'v1')).toBeNull();
    expect(storeFeeToTick(view({ ticked: true }), 'v1')).toBeNull();
    expect(storeFeeToTick(view({ set: true, required: false, weeklyFee: null }), 'v1')).toBeNull();
    expect(storeFeeToTick(view({ weeklyFee: { amount: 0, currencyCode: 'GYD', version: 'v1' } }), 'v1')).toBeNull();
    expect(storeFeeToTick(view({ terms: { ...TERMS, version: 'v2' } }), 'v1')).toBeNull();
    expect(storeFeeToTick(view({ terms: { ...TERMS, tick: '' } }), 'v1')).toBeNull();
    expect(storeFeeToTick(view({ terms: { ...TERMS, items: [] } }), 'v1')).toBeNull();
    expect(storeFeeToTick(view(), 'v2')).toBeNull();
    expect(storeFeeToTick(view({ vendorId: undefined }), 'v1')).toBeNull();
    expect(storeFeeToTick(view(), null)).toBeNull();
    expect(storeFeeToTick(null, 'v1')).toBeNull();
    expect(storeFeeToTick('nope', 'v1')).toBeNull();
  });

  it('a tick counts only for the exact fee it was given to: another amount, currency, version or store empties the box', () => {
    const fee = storeFeeToTick(view(), 'v1')!;
    const key = storeFeeKey(fee);
    expect(tickHolds(key, fee)).toBe(true);
    expect(tickHolds(null, fee)).toBe(false);
    expect(tickHolds(key, null)).toBe(false);
    expect(tickHolds(key, storeFeeToTick(view({ weeklyFee: { amount: 20000, currencyCode: 'GYD', tier: 'large', version: 'v1' } }), 'v1'))).toBe(false);
    expect(tickHolds(key, storeFeeToTick(view({ weeklyFee: { amount: 45000, currencyCode: 'USD', tier: 'department', version: 'v1' } }), 'v1'))).toBe(false);
    expect(tickHolds(key, storeFeeToTick(view({ weeklyFee: { amount: 45000, currencyCode: 'GYD', tier: 'department', version: 'v2' }, terms: { ...TERMS, version: 'v2' } }), 'v1'))).toBe(false);
    expect(tickHolds(key, storeFeeToTick(view({ vendorId: 'v9' }), 'v9'))).toBe(false);
  });

  it('only the OWNER of a named store, on a store role, sees it; a manager, a mover or no store never does', () => {
    expect([...STORE_ROLES].sort()).toEqual(['RESTAURANT', 'SERVICE', 'STORE', 'SUPERMARKET']);
    expect(storeFeeCardEnabled('SUPERMARKET', { vendorId: 'v1', isOwner: true })).toBe(true);
    expect(storeFeeCardEnabled('SUPERMARKET', { vendorId: 'v1', isOwner: false })).toBe(false);
    expect(storeFeeCardEnabled('SUPERMARKET', { vendorId: '', isOwner: true })).toBe(false);
    expect(storeFeeCardEnabled('SUPERMARKET', null)).toBe(false);
    expect(storeFeeCardEnabled('MOVER', { vendorId: 'v1', isOwner: true })).toBe(false);
  });

  it('[REVIEW-F S3-1] a failed read, or an answer that says a tick is needed but cannot be read, shows an error with Try again — never nothing', () => {
    const owner = { vendorId: 'v1', isOwner: true };
    expect(storeFeeCardView('SUPERMARKET', owner, { data: undefined, isError: true })).toEqual({ kind: 'error' });
    expect(storeFeeCardView('SUPERMARKET', owner, { data: view({ weeklyFee: { amount: 45000.5, currencyCode: 'GYD', tier: 'department', version: 'v1' } }), isError: false })).toEqual({ kind: 'error' });
    expect(storeFeeCardView('SUPERMARKET', owner, { data: view({ terms: null }), isError: false })).toEqual({ kind: 'error' });
    expect(storeFeeCardView('SUPERMARKET', owner, { data: view(), isError: false })).toMatchObject({ kind: 'tick', fee: { amount: 45000 } });
    // nothing to do, still loading, another store, or not the owner's: nothing
    expect(storeFeeCardView('SUPERMARKET', owner, { data: view({ required: false }), isError: false })).toEqual({ kind: 'none' });
    expect(storeFeeCardView('SUPERMARKET', owner, { data: undefined, isError: false })).toEqual({ kind: 'none' });
    expect(storeFeeCardView('SUPERMARKET', owner, { data: view({ vendorId: 'v9' }), isError: false })).toEqual({ kind: 'none' });
    expect(storeFeeCardView('SUPERMARKET', { vendorId: 'v1', isOwner: false }, { data: view(), isError: true })).toEqual({ kind: 'none' });
  });

  it('[REVIEW-F S4-1] a fee is whole currency units: a fractional amount is never offered to tick', () => {
    expect(storeFeeToTick(view({ weeklyFee: { amount: 45000.5, currencyCode: 'GYD', tier: 'department', version: 'v1' } }), 'v1')).toBeNull();
  });

  it('the go-live step is named for the owner', () => {
    expect(GO_LIVE_STEP_WORDS.WEEKLY_FEE).toBe('Read and tick its weekly fee');
    expect(ownerStepWords({ status: 'PENDING_APPROVAL', goLive: { waitingFor: 'OWNER', steps: ['WEEKLY_FEE'] } })).toEqual(['Read and tick its weekly fee']);
  });

  it('wiring: both checklists pass the store and whether the person owns it; the card reads and ticks with that store\'s header', () => {
    const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
    expect(read('DocumentChecklist.tsx')).toContain('<StoreWeeklyFeeCard role={role} scope={storeFee} />');
    expect(read('..', '..', 'modules', 'vendor', 'screens', 'BusinessSetup.tsx')).toContain("storeFee={store.id ? { vendorId: store.id, isOwner: myRole === 'OWNER' } : null}");
    expect(read('..', '..', 'modules', 'vendor', 'screens', 'VendorAccountScreen.tsx')).toContain('storeFee={store?.id ? { vendorId: store.id, isOwner } : null}');
    const api = read('..', '..', 'services', 'api.ts');
    expect(api).toContain("api.get('/vendor/onboarding/weekly-fee', { headers: { [VENDOR_STORE_HEADER]: vendorId } })");
    expect(api).toContain("api.post('/vendor/onboarding/weekly-fee', tick, { headers: { [VENDOR_STORE_HEADER]: tick.vendorId } })");
    const card = read('StoreWeeklyFeeCard.tsx');
    expect(card).toContain('const checked = tickHolds(tickedKey, fee);');
    expect(card).toContain('onError: () => setTickedKey(null),');
    // [REVIEW-G S4 M2] the card reads only when its own gate says so, and draws only what the view helper says
    expect(card).toContain('const enabled = storeFeeCardEnabled(role, scope);');
    expect(card).toMatch(/useQuery\(\{[\s\S]*enabled,\n {2}\}\);/);
    expect(card).toContain('const view = storeFeeCardView(role, scope, { data: read.data, isError: read.isError });');
    expect(card).toContain("<PillButton label=\"Try again\" variant=\"soft\" onPress={() => void read.refetch()} />");
  });
});

// [REVIEW-F S4-1 on #2246] The card names the fee as every phone fee screen does (GY$45,000, lib/fee-status feeMoney),
// and as the website card does; another currency keeps its own code.
describe('the card names the amount as the fee screens do', () => {
  it('GYD reads GY$45,000; another currency keeps its code', () => {
    expect(storeFeeMoney({ amount: 45000, currencyCode: 'GYD' })).toBe('GY$45,000');
    expect(storeFeeMoney({ amount: 300, currencyCode: 'USD' })).toBe('USD 300');
  });

  it('the card renders that figure, not the plain "$" shop price', () => {
    const card = readFileSync(join(__dirname, 'StoreWeeklyFeeCard.tsx'), 'utf8');
    expect(card).toContain('Your weekly fee: {storeFeeMoney(fee)} a week');
    expect(card).not.toMatch(/moneyIn\(/);
  });
});
