/**
 * [WEB-ONBOARDING · owner rulings 1 Nov 2026 (D3, D1/F13)] The weekly fee words, v2: "How you pay" names the website too,
 * since the weekly fee is paid on MMG's checkout page from swiftgy.com as well as from the app, and "When it starts"
 * says the free trial plainly (when, how long, once per person per kind of partner). A version is a promise about
 * specific words, so this is a NEW version (weekly_fee_acknowledgement v2) beside v1, which never changes (rows in the
 * ledger are anchored to it). New ticks are taken on v2 only; a partner who ticked v1 is not asked again (a store
 * owner's store-fee tick and a pro's fee tick are read across both versions). The partner agreements and LEGAL_VERSION
 * are not touched: these words are their own versioned document, like the 18+ tick. Service-free.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertWeeklyFeeAck, WEEKLY_FEE_ACK_HONOURED_VERSIONS, WEEKLY_FEE_ACK_TEXT, WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_VERSION, WEEKLY_FEE_TERMS_V1,
  weeklyFeeTerms,
} from '../modules/partner/weekly-fee-ack';
import { latestStoreFeeTick } from '../modules/partner/store-fee';
import { latestProFeeTick } from '../modules/services/pro-fee';
import { DEPARTMENT_TRIAL_DAYS, TRIAL_DAYS } from '../modules/subscription/trial-length';
import { guyanaTiers } from '../modules/ops/platform-config';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const HOW_YOU_PAY_V2 = 'In the Swift app or on swiftgy.com, on MMG’s checkout page, one week at a time. Paying by card is not offered yet.';
/**
 * [D1 / F13 · REVIEW-LIGHT2 M S2+S3] The free trial said plainly AND true on every screen these words are ticked on:
 * sign-up (a new store, rider or taxi driver), Add a branch (a branch has no trial of its own: it shares its business's,
 * and the page says "Billed from the day Swift approves it" when that has ended), and a pro's fee tick (a pro's trial
 * starts as the Pro Agreement says). "if you get one" stays: the trial law can refuse one (an earlier trial, an
 * overdue, paused or ended subscription in the same person's accounts, a review hold).
 */
const WHEN_IT_STARTS_V2 = 'Nothing is paid at sign-up. The weekly fee starts only after Swift approves you, and after your free trial if you get one. A new partner\u2019s free trial lasts 14 days, or 7 days for a store with 10,000 or more items when Swift approves it, counted from the day Swift approves you (for a service provider, from the day the Pro Agreement says). A new branch has no trial of its own: it shares its business\u2019s. Each person gets one free trial for each kind of partner, and none while an earlier Swift subscription of theirs is overdue, paused or ended.';
const CHANGED: Record<string, string> = { 'How you pay': HOW_YOU_PAY_V2, 'When it starts': WHEN_IT_STARTS_V2 };

describe('[D3] the weekly fee words v2', () => {
  it('serves v2: "How you pay" names the website and "When it starts" says the trial; the other lines and the tick are v1’s', () => {
    const served = weeklyFeeTerms();
    expect(WEEKLY_FEE_ACK_VERSION).toBe('v2');
    expect(served.version).toBe('v2');
    expect(served.items.map((i) => i.heading)).toEqual(WEEKLY_FEE_TERMS_V1.items.map((i) => i.heading));
    served.items.forEach((item, i) => {
      expect(item.text, item.heading).toBe(CHANGED[item.heading] ?? WEEKLY_FEE_TERMS_V1.items[i]!.text);
    });
    expect(served.tick).toBe(WEEKLY_FEE_TERMS_V1.tick);
    expect(WEEKLY_FEE_ACK_TEXT).toBe([...served.items.map((i) => `${i.heading}: ${i.text}`), served.tick].join('\n'));
  });

  it('the trial words are the trial law’s own numbers (a change to one is a new version)', () => {
    expect([TRIAL_DAYS, DEPARTMENT_TRIAL_DAYS, guyanaTiers.departmentCatalogueThreshold]).toEqual([14, 7, 10000]);
    expect(WHEN_IT_STARTS_V2).toContain(`free trial lasts ${TRIAL_DAYS} days, or ${DEPARTMENT_TRIAL_DAYS} days for a store with ${guyanaTiers.departmentCatalogueThreshold.toLocaleString('en-US')} or more items`);
  });

  it('[REVIEW-LIGHT2 M] true wherever v2 is ticked: no trial promised outright, a branch shares its business’s, a pro’s follows the Pro Agreement, none while an earlier subscription is overdue, paused or ended', () => {
    const when = weeklyFeeTerms().items.find((i) => i.heading === 'When it starts')!.text;
    expect(when).toContain('after your free trial if you get one');
    expect(when).toMatch(/^Nothing is paid at sign-up\. The weekly fee starts only after Swift approves you/);
    expect(when).toContain('A new branch has no trial of its own: it shares its business\u2019s.');
    expect(when).toContain('for a service provider, from the day the Pro Agreement says');
    expect(when).toContain('none while an earlier Swift subscription of theirs is overdue, paused or ended');
    expect(when).not.toMatch(/Your free trial starts once/);
  });

  it('v1 keeps its exact words (the ledger rows already anchored to them)', () => {
    expect(sha256(WEEKLY_FEE_ACK_TEXT_V1)).toBe('ba908e03ef6687ef0f753e501100d02ea25e7f40072304a5e1003b53ee2449af');
    expect(WEEKLY_FEE_ACK_TEXT_V1).toContain('How you pay: In the Swift app, on MMG’s checkout page, one week at a time.');
  });

  it('a NEW tick is taken on v2 only: a tab that read v1 is asked to read the words again', () => {
    expect(() => assertWeeklyFeeAck(true, { version: 'v1', amount: 6000, currencyCode: 'GYD' })).toThrow(expect.objectContaining({ code: 'WEEKLY_FEE_TERMS_CHANGED' }));
    expect(() => assertWeeklyFeeAck(true, { version: 'v2', amount: 6000, currencyCode: 'GYD' })).not.toThrow();
  });

  it('a partner who ticked v1 is not asked again: the store-fee and pro-fee ticks are read across v1 and v2', async () => {
    expect([...WEEKLY_FEE_ACK_HONOURED_VERSIONS]).toEqual(['v1', 'v2']);
    const seen: unknown[] = [];
    const db = { consentRecord: { findFirst: async (args: { where: unknown }) => { seen.push(args.where); return { action: 'granted', evidence: { weeklyFee: { amount: 15000, currencyCode: 'GYD' } } }; } } } as never;
    expect(await latestStoreFeeTick(db, 'owner-1', 'store-1')).toEqual({ amount: 15000, currencyCode: 'GYD' });
    expect(await latestProFeeTick(db, 'pro-1')).toEqual({ amount: 15000, currencyCode: 'GYD' });
    for (const where of seen) expect(where).toMatchObject({ documentType: 'weekly_fee_acknowledgement', documentVersion: { in: ['v1', 'v2'] } });
  });
});
