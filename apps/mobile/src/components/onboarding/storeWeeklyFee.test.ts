import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_ROLES, storeFeeAck, storeFeeToTick } from './storeWeeklyFee';
import { GO_LIVE_STEP_WORDS, ownerStepWords } from '../../lib/branches';

// [RETIER PR-A2 · owner 30 Oct 2026] A store whose weekly fee follows its catalogue above the first step goes live
// only after its owner reads that exact fee and ticks it. The figure, why and the words are the server's
// (GET /vendor/onboarding/weekly-fee); the app sends back exactly what it showed. Synthetic figures only.

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
  it('a fee to tick: the exact amount, currency, why, the words and the tick; the tick sends back exactly that', () => {
    const fee = storeFeeToTick(view());
    expect(fee).toEqual({ amount: 45000, currencyCode: 'GYD', version: 'v1', why: view().why, items: TERMS.items, tick: TERMS.tick });
    expect(storeFeeAck(fee!)).toEqual({ version: 'v1', amount: 45000, currencyCode: 'GYD' });
  });

  it('nothing to tick: not required, already ticked, a fee already set, or anything malformed shows no card', () => {
    expect(storeFeeToTick(view({ required: false }))).toBeNull();
    expect(storeFeeToTick(view({ ticked: true }))).toBeNull();
    expect(storeFeeToTick(view({ set: true, required: false, weeklyFee: null }))).toBeNull();
    expect(storeFeeToTick(view({ weeklyFee: { amount: 0, currencyCode: 'GYD', version: 'v1' } }))).toBeNull();
    expect(storeFeeToTick(view({ terms: { ...TERMS, version: 'v2' } }))).toBeNull();
    expect(storeFeeToTick(view({ terms: { ...TERMS, tick: '' } }))).toBeNull();
    expect(storeFeeToTick(view({ terms: { ...TERMS, items: [] } }))).toBeNull();
    expect(storeFeeToTick(null)).toBeNull();
    expect(storeFeeToTick('nope')).toBeNull();
  });

  it('every store role sees it (a Services business too); a mover never does', () => {
    expect([...STORE_ROLES].sort()).toEqual(['RESTAURANT', 'SERVICE', 'STORE', 'SUPERMARKET']);
    expect(STORE_ROLES.has('MOVER')).toBe(false);
  });

  it('the go-live step is named for the owner', () => {
    expect(GO_LIVE_STEP_WORDS.WEEKLY_FEE).toBe('Read and tick its weekly fee');
    expect(ownerStepWords({ status: 'PENDING_APPROVAL', goLive: { waitingFor: 'OWNER', steps: ['WEEKLY_FEE'] } })).toEqual(['Read and tick its weekly fee']);
  });

  it('the checklist draws the card, which sends the tick to the store weekly-fee route', () => {
    const checklist = readFileSync(join(__dirname, 'DocumentChecklist.tsx'), 'utf8');
    expect(checklist).toContain('<StoreWeeklyFeeCard role={role} />');
    const api = readFileSync(join(__dirname, '..', '..', 'services', 'api.ts'), 'utf8');
    expect(api).toContain("api.get('/vendor/onboarding/weekly-fee')");
    expect(api).toContain("api.post('/vendor/onboarding/weekly-fee', { weeklyFeeAck })");
  });
});
