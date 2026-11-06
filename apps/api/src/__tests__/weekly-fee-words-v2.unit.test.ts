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
  assertWeeklyFeeAck, WEEKLY_FEE_ACK_HONOURED_VERSIONS, WEEKLY_FEE_ACK_TEXT, WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_TEXT_V2, WEEKLY_FEE_ACK_TEXT_V3, WEEKLY_FEE_ACK_VERSION, WEEKLY_FEE_TERMS_V1,
  weeklyFeeTerms,
} from '../modules/partner/weekly-fee-ack';
import { latestStoreFeeTick } from '../modules/partner/store-fee';
import { latestProFeeTick } from '../modules/services/pro-fee';
import { DEPARTMENT_TRIAL_DAYS, TRIAL_DAYS } from '../modules/subscription/trial-length';
import { guyanaTiers } from '../modules/ops/platform-config';
import { FEE_RISE_NOTICE_DAYS } from '../modules/billing/fee-rise-notice';
import { PRICE_BOOK_NOTICE_DAYS } from '../modules/billing/price-book';

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
/** [OWNER 5 Nov 2026] v3 adds paying Westbridge Inc. directly, in person; nothing about the fee changed. */
const HOW_YOU_PAY_V3 = 'In the Swift app or on swiftgy.com, on MMG’s checkout page, one week at a time. Or in person, directly to Westbridge Inc., by cash, cheque or bank transfer: a cheque counts once it clears, a payment counts once Swift records it, and you get a receipt. Never give it to anyone else. Paying by card is not offered yet.';
/**
 * [REVIEW-G18 S3-1] v3 also says the price rule as the code does it: a RISE waits at least 14 days after the notice
 * (fee-rise-notice.ts FEE_RISE_NOTICE_DAYS, price-book.ts PRICE_BOOK_NOTICE_DAYS) and never touches a week already
 * paid; a CUT applies at once, from the next weekly fee not yet paid or charged (billing.service applyCardPriceCuts:
 * "Issued charges and paid weeks keep their amount"; price-book.ts "A lower price needs no wait"; owner 29 Oct). v1 and
 * v2 said 14 days for ANY change, which a cut does not wait for. The same words as the agreements' fee-cut line (#2376).
 */
const PRICE_CHANGES_V3 = 'If the price goes up, Swift tells you in the app at least 14 days before, and the new price applies only from your first weekly fee due after that, never to a week you have already paid. If it goes down, the lower price applies from your next weekly fee not yet paid or charged, with a notice in the app.';
/** The v3 words as ticked, pinned (the integration test anchors the ledger row to the same text). */
const V3_SHA256 = '9d8c7559e85aedb9ad3a178fe0f0d6927599a2439d6d97b1e06a5481e3dc9c05';
/** [PAYAHEAD-4W · owner 6 Nov 2026] v4: up to four weeks ahead (was one week at a time), and a cut reaches weeks paid ahead. */
const HOW_YOU_PAY_V4 = 'In the Swift app or on swiftgy.com, on MMG’s checkout page, for one week or up to four weeks ahead. Or in person, directly to Westbridge Inc., by cash, cheque or bank transfer: a cheque counts once it clears, a payment counts once Swift records it, and you get a receipt. Never give it to anyone else. Paying by card is not offered yet.';
const PRICE_CHANGES_V4 = 'If the price goes up, Swift tells you in the app at least 14 days before, and the new price applies only from your first weekly fee due after that, never to a week you have already paid. If it goes down, the lower price applies from your next weekly fee not yet charged, even one you have already paid for, with a notice in the app; what you paid above it counts toward your later weekly fees.';
const V4_SHA256 = '2b3ef2cdccc4813f42f4f6f7dca6262cd89dbc91cc9c7c50d0b1f795e03fe36d';
const CHANGED: Record<string, string> = { 'How you pay': HOW_YOU_PAY_V4, 'When it starts': WHEN_IT_STARTS_V2, 'If the price changes': PRICE_CHANGES_V4 };

describe('[D3] the weekly fee words v2', () => {
  it('serves v4: "How you pay" names the website, in person and up to four weeks ahead, "When it starts" says the trial, "If the price changes" splits a rise from a cut; the other line and the tick are v1’s', () => {
    const served = weeklyFeeTerms();
    expect(WEEKLY_FEE_ACK_VERSION).toBe('v4');
    expect(served.version).toBe('v4');
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

  it('[REVIEW-G18 S3-1 · owner 6 Nov] the price line is true to the code: 14 days’ notice before a rise only, a cut from the next fee not yet charged, weeks paid ahead included', () => {
    const price = weeklyFeeTerms().items.find((i) => i.heading === 'If the price changes')!.text;
    expect([FEE_RISE_NOTICE_DAYS, PRICE_BOOK_NOTICE_DAYS]).toEqual([14, 14]);
    expect(price).toMatch(new RegExp(`^If the price goes up, Swift tells you in the app at least ${FEE_RISE_NOTICE_DAYS} days before, `));
    expect(price).toContain('never to a week you have already paid.');
    expect(price).toContain('If it goes down, the lower price applies from your next weekly fee not yet charged, even one you have already paid for');
    // The v1/v2 line promised a 14-day wait for ANY change; a cut never waits.
    expect(price).not.toMatch(/^Swift tells you in the app at least 14 days before\./);
    expect(sha256(WEEKLY_FEE_ACK_TEXT)).toBe(V4_SHA256);
  });

  it('v3 keeps its exact words (live on production; the ledger rows already anchored to them)', () => {
    expect(sha256(WEEKLY_FEE_ACK_TEXT_V3)).toBe(V3_SHA256);
    expect(WEEKLY_FEE_ACK_TEXT_V3).toContain(`How you pay: ${HOW_YOU_PAY_V3}`);
    expect(WEEKLY_FEE_ACK_TEXT_V3).toContain(`If the price changes: ${PRICE_CHANGES_V3}`);
  });

  it('v1 keeps its exact words (the ledger rows already anchored to them)', () => {
    expect(sha256(WEEKLY_FEE_ACK_TEXT_V1)).toBe('ba908e03ef6687ef0f753e501100d02ea25e7f40072304a5e1003b53ee2449af');
    expect(WEEKLY_FEE_ACK_TEXT_V1).toContain('How you pay: In the Swift app, on MMG’s checkout page, one week at a time.');
  });

  it('v2 keeps its exact words (the ledger rows already anchored to them), and they never named in person', () => {
    expect(WEEKLY_FEE_ACK_TEXT_V2).toContain(`How you pay: ${HOW_YOU_PAY_V2}`);
    expect(WEEKLY_FEE_ACK_TEXT_V2).not.toContain('in person');
  });

  it('a NEW tick is taken on the served version only: a tab that read v1, v2 or v3 is asked to read the words again', () => {
    for (const version of ['v1', 'v2', 'v3']) {
      expect(() => assertWeeklyFeeAck(true, { version, amount: 6000, currencyCode: 'GYD' })).toThrow(expect.objectContaining({ code: 'WEEKLY_FEE_TERMS_CHANGED' }));
    }
    expect(() => assertWeeklyFeeAck(true, { version: 'v4', amount: 6000, currencyCode: 'GYD' })).not.toThrow();
  });

  it('a partner who ticked v1 is not asked again: the store-fee and pro-fee ticks are read across every version', async () => {
    expect([...WEEKLY_FEE_ACK_HONOURED_VERSIONS]).toEqual(['v1', 'v2', 'v3', 'v4']);
    const seen: unknown[] = [];
    const db = { consentRecord: { findFirst: async (args: { where: unknown }) => { seen.push(args.where); return { action: 'granted', evidence: { weeklyFee: { amount: 15000, currencyCode: 'GYD' } } }; } } } as never;
    expect(await latestStoreFeeTick(db, 'owner-1', 'store-1')).toEqual({ amount: 15000, currencyCode: 'GYD' });
    expect(await latestProFeeTick(db, 'pro-1')).toEqual({ amount: 15000, currencyCode: 'GYD' });
    for (const where of seen) expect(where).toMatchObject({ documentType: 'weekly_fee_acknowledgement', documentVersion: { in: ['v1', 'v2', 'v3', 'v4'] } });
  });
});
