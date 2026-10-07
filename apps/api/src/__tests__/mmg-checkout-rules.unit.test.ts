import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { bindingOf, checkoutReplyFrom, judge, mmgCreationInstant, sameMsisdn, successAnswerOf, type PaymentHistory } from '../modules/billing/mmg-checkout.service';
import {
  FEE_CHECKOUT_PLATFORMS_KEY,
  checkoutAmountGyd,
  clientPlatform,
  feePayActions,
  mmgCheckoutLive,
  resetFeeCheckoutSwitchCache,
} from '../modules/billing/fee-pay-actions';
import { FEE_RESTORE_LINE, feeCoveredLine, feeDueLine, guyanaDay, mmgPayLine } from '../modules/billing/fee-notice-copy';
import type { MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import { MMG_LOOKUP_REFERENCE_FIELDS, echoedReferencesFrom, lookupDetailFrom, type MmgLookupDetail } from '../providers/mmg/mmg-provider';
import { setAppLogger } from '../utils/logger';
import { PROVIDER_IDENTITY_BACKFILL_KEY } from '../modules/billing/provider-identity-backfill';

// ---------------------------------------------------------------------------
// The rules of the MMG weekly-fee checkout that need no database: which MMG
// transaction a reply may name, what a lookup answer means for a checkout,
// when the pay action is live, and what a fee notice may say.
// (MMG-CHECKOUT-API.md is the contract; mmg-checkout-service.test.ts runs the
// same rules against the database.)
// ---------------------------------------------------------------------------

const REF = '179000000000012345';
const OTHER_REF = '179000000000099999';
const MERCHANT = '5926000001';
const CREATED = new Date('2026-09-29T12:00:00Z');
const intent = { merchantTransactionId: REF, amount: new Prisma.Decimal(1500), currencyCode: 'GYD', createdAt: CREATED, expiresAt: new Date(CREATED.getTime() + 30 * 60_000) };
/** MMG stamps creationDate as Guyana wall-clock time written with a "Z" (UAT, 1 Oct). */
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
/** MMG's lookup answer in the exact UAT shape (evidence/mmg-uat/ROUNDTRIP-PROOF-20261001.md). */
const uatAnswer = (patch: Record<string, unknown> = {}) => ({
  transactionStatus: 'successful', amount: '1500', currency: 'GYD', creationDate: gyStamp(new Date(CREATED.getTime() + 5 * 60_000)),
  subType: 'subscriber_mpay', transactionReference: 'MMGLEDGER1',
  creditParty: [{ key: 'accountid', value: MERCHANT }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'amount', value: '1500' }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
  descriptionText: null, ...patch,
});
const found = (patch: Partial<Extract<MmgLookupDetail, { outcome: 'found' }>> = {}): MmgLookupDetail => ({ ...lookupDetailFrom(uatAnswer(), 'MMGTX1'), ...patch });
/** MMG's success answer for THIS checkout (ResultCode 0) naming the transaction. */
const answered = { txnId: 'MMGTX1' } as const;
/** No success answer from MMG for this checkout. */
const unanswered = { txnId: null, reason: 'NO_SUCCESS_ANSWER' } as const;
/** [7 Oct] MMG's Transaction History record of MMGTX1 (UAT shape, 7 Oct): "completed", both of
 *  its numbers MMGTX1, the amount and currency, and modificationDate, when the payment was
 *  made, as MMG writes it (Guyana wall clock with a "Z"), or exactly the string given. */
const record = (paid: Date | string | undefined, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  external_id: REF, amount: '1500', currency: 'GYD', displayType: 'EMerchant Payment', transactionStatus: 'completed', descriptionText: '',
  modificationDate: paid instanceof Date ? gyStamp(paid) : paid, transactionReference: 'MMGTX1', transactionReceipt: 'MMGTX1', ...patch,
});
/** What MMG's history answered for MMGTX1: these records, the answer whole. */
const historyOf = (...naming: Record<string, unknown>[]): PaymentHistory => ({ outcome: 'rows', naming, truncated: false });
/** [DS632] Condition (5) as staging and UAT read it: MMG_CHECKOUT_CREATION_ZONE=GUYANA_WALL_CLOCK
 *  (verified 1 Oct), with MMG's reply naming the transaction first seen at the latest
 *  moment it still counts (the deadline plus two minutes), and [7 Oct] MMG's history
 *  dating the payment five minutes after the checkout opened. These cases are about other
 *  conditions; the zone and the reply-time bound have their own block below. */
const GY = { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: new Date(intent.expiresAt.getTime() + 2 * 60_000), history: historyOf(record(new Date(CREATED.getTime() + 5 * 60_000))) } as const;
/** MMG's answer echoing THIS checkout's reference in a confirmed field [F1]: never present in UAT. */
const echo = { echoedReferences: [REF] };

describe('the official MMG response fields', () => {
  it('reads only root fields and keeps the exact transaction string', () => {
    expect(checkoutReplyFrom({ merchantTransactionId: REF, transactionId: 'MMG-TX-777', ResultCode: '0', nested: { transactionId: 'OTHER999' }, htmlResponse: 'NO888' }))
      .toEqual({ merchantTransactionId: REF, transactionId: 'MMG-TX-777', resultCode: '0' });
  });

  it('does not guess candidates from arbitrary fields, even if many look like ids', () => {
    const ids = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`transactionId${i}`, `TX${100000 + i}`]));
    expect(checkoutReplyFrom({ ...ids, merchantTransactionId: REF, ResultCode: '0' })).toBeNull();
  });

  it('failure codes can omit transactionId; a success without one is malformed', () => {
    for (const ResultCode of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(checkoutReplyFrom({ merchantTransactionId: REF, ResultCode })).toEqual({ merchantTransactionId: REF, transactionId: null, resultCode: ResultCode });
    }
    expect(checkoutReplyFrom({ merchantTransactionId: REF, ResultCode: '0' })).toBeNull();
  });

  it.each([123, [], {}, ' TX1', 'TX1 ', 'TX1\n', 'TX/1', 'X'.repeat(129)])('rejects malformed transactionId %s', (transactionId) => {
    expect(checkoutReplyFrom({ merchantTransactionId: REF, ResultCode: '0', transactionId })).toBeNull();
  });

  it('one MSISDN spelled with or without 592', () => {
    expect(sameMsisdn('5926000001', '6000001')).toBe(true);
    expect(sameMsisdn('+592 600-0001', '5926000001')).toBe(true);
    expect(sameMsisdn('5926000001', '5926000002')).toBe(false);
    expect(sameMsisdn('123', '123')).toBe(false);
  });
});

describe('what a lookup answer means for a checkout [owner, 1 Oct · I2 · F1]', () => {
  it('confirms automatically only when MMG answered success for THIS checkout naming the transaction, and its lookup says "successful", exactly the amount, in GYD, to our merchant, inside the checkout window, with its ledger number', () => {
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], answered, GY)).toEqual({ verdict: 'CONFIRM', txnId: 'MMGTX1', ledgerReference: 'MMGLEDGER1' });
    // Our merchant MSISDN spelled without the country code; MMG's echo changes nothing.
    expect(judge(intent, 'MMGTX1', found({ creditAccounts: ['6000001'] }), [MERCHANT], [], answered, GY).verdict).toBe('CONFIRM');
    expect(judge(intent, 'MMGTX1', found(echo), [MERCHANT], [], answered, GY).verdict).toBe('CONFIRM');
  });

  it('the UAT round trip of 1 Oct confirms: MMG history’s Guyana-time record of the payment falls inside the checkout window', () => {
    // Checkout opened 15:38:19 Guyana time (its reference was that epoch second);
    // MMG answered ResultCode 0 naming 20402048536279; the lookup answered:
    const opened = new Date(1790883499 * 1000);
    const uatIntent = { merchantTransactionId: REF, amount: new Prisma.Decimal(500), currencyCode: 'GYD', createdAt: opened, expiresAt: new Date(opened.getTime() + 30 * 60_000) };
    const detail = lookupDetailFrom(uatAnswer({ amount: '500', creationDate: '2026-10-01T15:39:36.526Z', transactionReference: '20402048601581', metadata: [{ key: 'amount', value: '500' }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }] }), '20402048536279');
    // MMG's reply was read at 15:39:05 Guyana time; [7 Oct] MMG's history dates the
    // payment 15:38:31 (the lookup's creationDate is the lookup's own moment).
    const replied = new Date('2026-10-01T19:39:05Z');
    const history = historyOf(record('2026-10-01T15:38:31.000Z', { amount: '500', transactionReference: '20402048536279', transactionReceipt: '20402048536279' }));
    expect(judge(uatIntent, '20402048536279', detail, [MERCHANT], [], { txnId: '20402048536279' }, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: replied, history }))
      .toEqual({ verdict: 'CONFIRM', txnId: '20402048536279', ledgerReference: '20402048601581' });
    // Read as UTC, that time would be four hours before the checkout existed.
    expect(mmgCreationInstant('2026-10-01T15:38:31.000Z', 'GUYANA_WALL_CLOCK')).toBe(Date.parse('2026-10-01T19:38:31.000Z'));
    expect(judge(uatIntent, '20402048536279', detail, [MERCHANT], [], { txnId: '20402048536279' }, { zone: 'UTC', firstReplyAt: replied, history }))
      .toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
  });

  it('without MMG’s success answer naming it, an exact successful payment is held for a person at once, never credited; MMG’s echo alone included', () => {
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], unanswered, GY)).toEqual({ verdict: 'HOLD', txnId: 'MMGTX1', reason: 'NO_SUCCESS_ANSWER', decisive: true });
    expect(judge(intent, 'MMGTX1', found(echo), [MERCHANT], [], unanswered, GY)).toEqual({ verdict: 'HOLD', txnId: 'MMGTX1', reason: 'NO_SUCCESS_ANSWER', decisive: true });
    for (const reason of ['MMG_ANSWERS_DISAGREE', 'SUCCESS_ANSWER_AFTER_CLOSE', 'CHECKOUT_NOT_OPEN']) {
      expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], { txnId: null, reason }, GY)).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
    }
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], { txnId: 'MMGTX2' }, GY)).toMatchObject({ verdict: 'HOLD', reason: 'NOT_THE_ANSWERED_TRANSACTION', decisive: true });
  });

  it.each([
    ['another checkout’s reference', [OTHER_REF], 'REFERENCE_MISMATCH'],
    ['ours and another', [REF, OTHER_REF], 'REFERENCE_AMBIGUOUS'],
    ['our reference padded', [` ${REF}`], 'REFERENCE_MISMATCH'],
    ['our reference with a digit more', [`${REF}0`], 'REFERENCE_MISMATCH'],
  ] as const)('[F1] a lookup echoing %s is held at once, even after MMG’s success answer', (_label, echoedReferences, reason) => {
    expect(judge(intent, 'MMGTX1', found({ echoedReferences: [...echoedReferences] }), [MERCHANT], [], answered)).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
  });

  it('[F1] our reference inside some other text binds nothing: there is no substring binding', () => {
    const verdict = judge(intent, 'MMGTX1', found({ raw: { description: `Swift ${REF}`, merchantTransactionId: REF } }), [MERCHANT], [], unanswered, GY);
    expect(verdict).toMatchObject({ verdict: 'HOLD', reason: 'NO_SUCCESS_ANSWER' });
  });

  it('[F1] a lookup that names another of our checkouts is held, even when MMG answered success for this one', () => {
    expect(judge(intent, 'MMGTX1', found(echo), [MERCHANT], [OTHER_REF], answered)).toMatchObject({ verdict: 'HOLD', reason: 'REFERENCE_OF_ANOTHER_CHECKOUT', decisive: true });
  });

  it.each([
    ['MMG’s word is "completed", not "successful"', { statusText: 'completed' }, 'STATUS_NOT_SUCCESSFUL'],
    ['MMG’s word in capitals', { statusText: 'SUCCESSFUL' }, 'STATUS_NOT_SUCCESSFUL'],
    ['one cent short', { amountMinor: 149_999 }, 'AMOUNT_MISMATCH'],
    ['one dollar more', { amountMinor: 150_100 }, 'AMOUNT_MISMATCH'],
    ['an amount MMG did not send', { amountMinor: null }, 'AMOUNT_MISMATCH'],
    ['another currency', { currencyCode: 'USD' }, 'CURRENCY_MISMATCH'],
    ['no currency', { currencyCode: null }, 'CURRENCY_MISMATCH'],
    ['someone else’s merchant', { creditAccounts: ['5926999999'] }, 'MERCHANT_MISMATCH'],
    ['a foreign account beside ours', { creditAccounts: [MERCHANT, '5926999999'] }, 'MERCHANT_MISMATCH'],
    ['[DS632] an "accountid" entry with no readable value beside ours', { creditAccounts: ['', MERCHANT] }, 'MERCHANT_MISMATCH'],
    ['our number under a key that is not "accountid"', { creditAccounts: [], creditParties: [MERCHANT] }, 'MERCHANT_UNCONFIRMED'],
    ['no merchant named', { creditAccounts: null }, 'MERCHANT_UNCONFIRMED'],
    ['no ledger number', { ledgerReference: null }, 'LEDGER_REFERENCE_MISSING'],
    ['a malformed ledger number', { ledgerReference: ' 20402048601581' }, 'LEDGER_REFERENCE_MISSING'],
  ] as const)('holds %s for a person, never credits: at once when MMG’s answer ties it to this checkout, after the window otherwise', (_label, patch, reason) => {
    expect(judge(intent, 'MMGTX1', found(patch as never), [MERCHANT], [], unanswered, GY)).toMatchObject({ verdict: 'HOLD', reason, decisive: false });
    expect(judge(intent, 'MMGTX1', found(patch as never), [MERCHANT], [], answered, GY)).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
    expect(judge(intent, 'MMGTX1', found({ ...(patch as object), ...echo } as never), [MERCHANT], [], unanswered, GY)).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
  });

  it.each([
    ['a transaction a week before the checkout', record(new Date(CREATED.getTime() - 7 * 86_400_000)), 'PAYMENT_TIME_OUTSIDE_WINDOW'],
    ['paid three minutes before the checkout opened', record(new Date(CREATED.getTime() - 3 * 60_000)), 'PAYMENT_TIME_OUTSIDE_WINDOW'],
    ['paid three minutes after it closed', record(new Date(CREATED.getTime() + 33 * 60_000)), 'PAYMENT_TIME_OUTSIDE_WINDOW'],
    ['a payment time that cannot be read', record('yesterday'), 'PAYMENT_TIME_UNREADABLE'],
    ['no payment time', record(undefined), 'PAYMENT_TIME_UNREADABLE'],
  ] as const)('[7 Oct] MMG’s history dating it %s: held for a person, never credited: at once when MMG’s answer ties it to this checkout, after the window otherwise', (_label, paid, reason) => {
    const history = historyOf(paid);
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], unanswered, { ...GY, history })).toMatchObject({ verdict: 'HOLD', reason, decisive: false });
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], answered, { ...GY, history })).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
    expect(judge(intent, 'MMGTX1', found(echo), [MERCHANT], [], unanswered, { ...GY, history })).toMatchObject({ verdict: 'HOLD', reason, decisive: true });
  });

  it('[7 Oct] the lookup’s creationDate decides nothing: it is the lookup’s own moment (MMG); a week before, a week after, unreadable or missing, the payment confirms by its history time', () => {
    for (const createdAt of [gyStamp(new Date(CREATED.getTime() - 7 * 86_400_000)), gyStamp(new Date(CREATED.getTime() + 7 * 86_400_000)), 'yesterday', null]) {
      expect(judge(intent, 'MMGTX1', found({ createdAt }), [MERCHANT], [], answered, GY), String(createdAt)).toEqual({ verdict: 'CONFIRM', txnId: 'MMGTX1', ledgerReference: 'MMGLEDGER1' });
    }
  });

  it('the checkout window carries two minutes of clock tolerance on each side, and no more', () => {
    const at = (ms: number) => ({ ...GY, history: historyOf(record(new Date(ms))) });
    const opened = CREATED.getTime();
    const closed = intent.expiresAt.getTime();
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], answered, at(opened - 120_000)).verdict).toBe('CONFIRM');
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], answered, at(opened - 121_000))).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW' });
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], answered, at(closed + 120_000)).verdict).toBe('CONFIRM');
    expect(judge(intent, 'MMGTX1', found(), [MERCHANT], [], answered, at(closed + 121_000))).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW' });
  });

  it('declined, expired and reversed are not payments, and only MMG’s answer for THIS checkout says a payment failed [F5]', () => {
    for (const status of ['declined', 'expired', 'reversed'] as const) {
      expect(judge(intent, 'T', found({ status }), [MERCHANT])).toMatchObject({ verdict: 'DECLINED', bound: false });
      expect(judge(intent, 'T', found({ status, ...echo }), [MERCHANT])).toMatchObject({ verdict: 'DECLINED', bound: true });
    }
    expect(judge(intent, 'T', found({ status: 'declined', ...echo }), [MERCHANT], [OTHER_REF])).toMatchObject({ verdict: 'DECLINED', bound: false });
    expect(judge(intent, 'T', found({ status: 'pending', ...echo }), [MERCHANT]).verdict).toBe('PENDING');
    expect(judge(intent, 'T', { outcome: 'not_found' }, [MERCHANT]).verdict).toBe('NOT_FOUND');
    expect(judge(intent, 'T', { outcome: 'error', reason: 'x' }, [MERCHANT]).verdict).toBe('ERROR');
  });

  it('[F1] binding is exact: one distinct echoed value, equal to ours', () => {
    expect(bindingOf(REF, [])).toBe('NOT_ECHOED');
    expect(bindingOf(REF, [REF])).toBe('BOUND');
    expect(bindingOf(REF, [REF, REF])).toBe('BOUND');
    expect(bindingOf(REF, [OTHER_REF])).toBe('MISMATCH');
    expect(bindingOf(REF, [REF, OTHER_REF])).toBe('AMBIGUOUS');
  });
});

describe('MMG’s own success answer for a checkout [owner, 1 Oct]', () => {
  const open = { merchantTransactionId: REF, expiresAt: intent.expiresAt, status: 'CONFIRMING' as const };
  const answer = (detail: string, transactionId: string | undefined, minutesAfterOpen = 2, ref = REF) => ({
    detail, createdAt: new Date(CREATED.getTime() + minutesAfterOpen * 60_000),
    body: { merchantTransactionId: ref, ...(transactionId === undefined ? {} : { transactionId }), ResultCode: detail.slice(-1) },
  });

  it('is ResultCode 0 naming this checkout and one transaction, received while the checkout was open', () => {
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1')])).toEqual({ txnId: 'T1' });
    // The return door and the notify door may both carry it, in either order.
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1', 3), answer('MMG_RESULT_0', 'T1', 1)])).toEqual({ txnId: 'T1' });
    // An expired checkout whose success answer came in time still has it.
    expect(successAnswerOf({ ...open, status: 'EXPIRED' }, [answer('MMG_RESULT_0', 'T1')])).toEqual({ txnId: 'T1' });
    // A configuration alert (3, 4, 5) is not a payment answer.
    expect(successAnswerOf(open, [answer('MMG_RESULT_3', 'T1'), answer('MMG_RESULT_0', 'T1')])).toEqual({ txnId: 'T1' });
  });

  it('is absent when MMG never answered success for this checkout', () => {
    expect(successAnswerOf(open, [])).toEqual({ txnId: null, reason: 'NO_SUCCESS_ANSWER' });
    expect(successAnswerOf(open, [answer('MMG_RESULT_7', 'T1')])).toEqual({ txnId: null, reason: 'NO_SUCCESS_ANSWER' });
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1', 2, OTHER_REF)])).toEqual({ txnId: null, reason: 'NO_SUCCESS_ANSWER' });
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', undefined)])).toEqual({ txnId: null, reason: 'NO_SUCCESS_ANSWER' });
    expect(successAnswerOf(open, [{ detail: 'MMG_RESULT_0', createdAt: CREATED, body: null }])).toEqual({ txnId: null, reason: 'NO_SUCCESS_ANSWER' });
  });

  it.each(['1', '2', '6', '7'])('disagrees when MMG also answered %s for the same checkout', (code) => {
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1'), answer(`MMG_RESULT_${code}`, undefined, 3)]))
      .toEqual({ txnId: null, reason: 'MMG_ANSWERS_DISAGREE' });
    expect(successAnswerOf(open, [answer(`MMG_RESULT_${code}`, 'T1', 1), answer('MMG_RESULT_0', 'T1')]))
      .toEqual({ txnId: null, reason: 'MMG_ANSWERS_DISAGREE' });
  });

  it('disagrees when MMG answered success naming two transactions', () => {
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1'), answer('MMG_RESULT_0', 'T2')])).toEqual({ txnId: null, reason: 'MMG_ANSWERS_DISAGREE' });
  });

  it('counts only an answer that reached us by the deadline, with two minutes of clock tolerance', () => {
    const closeMin = 30;
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1', closeMin + 2)])).toEqual({ txnId: 'T1' });
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1', closeMin + 2.02)])).toEqual({ txnId: null, reason: 'SUCCESS_ANSWER_AFTER_CLOSE' });
    expect(successAnswerOf(open, [answer('MMG_RESULT_0', 'T1', closeMin + 60), answer('MMG_RESULT_0', 'T1', 5)])).toEqual({ txnId: 'T1' });
  });

  it.each(['OPEN', 'NOT_PAID', 'HELD', 'CONFIRMED'] as const)('a %s checkout has no answer that can confirm it', (status) => {
    expect(successAnswerOf({ ...open, status }, [answer('MMG_RESULT_0', 'T1')])).toEqual({ txnId: null, reason: 'CHECKOUT_NOT_OPEN' });
  });
});

describe('MMG’s creationDate is Guyana time in staging and UAT [owner, 1 Oct · UAT · DS632 GUYANA_WALL_CLOCK]', () => {
  const GUYANA = 'GUYANA_WALL_CLOCK' as const;
  it('reads the wall-clock stamp as Guyana time (UTC−4), with or without the "Z" MMG writes', () => {
    expect(mmgCreationInstant('2026-10-01T15:39:36.526Z', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
    expect(mmgCreationInstant('2026-10-01T15:39:36.526', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
    expect(mmgCreationInstant('2026-10-01T15:39:36Z', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.000Z'));
    expect(mmgCreationInstant('2026-12-31T22:30:00.000Z', GUYANA)).toBe(Date.parse('2027-01-01T02:30:00.000Z'));
    // Fractions of a second are read as written, never through floating point.
    expect(mmgCreationInstant('2026-10-01T15:39:36.29Z', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.290Z'));
    expect(mmgCreationInstant('2026-10-01T15:39:36.1Z', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.100Z'));
    expect(mmgCreationInstant('2026-10-01T15:39:36.123456789Z', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.123Z'));
  });

  it('honours an explicit numeric offset as stated', () => {
    expect(mmgCreationInstant('2026-10-01T15:39:36.526-04:00', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
    expect(mmgCreationInstant('2026-10-01T19:39:36.526+00:00', GUYANA)).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
  });

  it.each([null, '', 'yesterday', '2026-10-01', '2026-02-30T10:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T15:39:36.526Zjunk', ' 2026-10-01T15:39:36Z', '2026-10-01 15:39:36'])(
    'cannot read %s, in either zone', (stamp) => {
      expect(mmgCreationInstant(stamp, GUYANA)).toBeNull();
      expect(mmgCreationInstant(stamp, 'UTC')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// [DS632] Condition (5) holds only as well as the zone MMG's time for the
// payment is read in ([7 Oct] its history record's modificationDate).
// MMG_CHECKOUT_CREATION_ZONE names it: GUYANA_WALL_CLOCK (what MMG UAT writes,
// verified 1 Oct and 7 Oct) or UTC. Unset, nothing is confirmed
// automatically. And MMG cannot have made a payment after Swift first heard
// of it: a time later than the first reply naming the transaction (two
// minutes' tolerance) is held as PAYMENT_TIME_AFTER_REPLY.
// ---------------------------------------------------------------------------
describe('[DS632] condition (5) is read in the configured zone, MMG_CHECKOUT_CREATION_ZONE', () => {
  // The UAT checkout of 1 Oct: opened 15:38:19 Guyana time (19:38:19Z), open
  // for 30 minutes; MMG's success reply read at 19:39:05Z; MMG's payment made
  // at 19:39:36.526Z. A payment made 3h48m before the checkout opened is one
  // that was never this checkout's.
  const opened = new Date('2026-10-01T19:38:19Z');
  const uat = { merchantTransactionId: REF, amount: new Prisma.Decimal(1500), currencyCode: 'GYD', createdAt: opened, expiresAt: new Date(opened.getTime() + 30 * 60_000) };
  const replied = new Date('2026-10-01T19:39:05Z');
  const paid = new Date('2026-10-01T19:39:36.526Z');
  const before = new Date(opened.getTime() - (3 * 60 + 48) * 60_000);
  /** MMG writing true UTC, or Guyana wall-clock time, both labelled "Z". */
  const trueUtc = (at: Date) => at.toISOString();
  const guyanaTime = (at: Date) => gyStamp(at);
  /** [7 Oct] MMG's history dating the payment `stamp` (the lookup's creationDate decides nothing). */
  const verdictFor = (stamp: string, zone: 'GUYANA_WALL_CLOCK' | 'UTC' | null, reply: Date | null = replied) =>
    judge(uat, 'MMGTX1', found(), [MERCHANT], [], answered, { zone, firstReplyAt: reply, history: historyOf(record(stamp)) });

  it('UTC: "Z" is UTC, an explicit offset is honoured as stated, and a stamp with no zone cannot be read', () => {
    expect(mmgCreationInstant('2026-10-01T19:39:36.526Z', 'UTC')).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
    expect(mmgCreationInstant('2026-10-01T19:39:36.29Z', 'UTC')).toBe(Date.parse('2026-10-01T19:39:36.290Z'));
    expect(mmgCreationInstant('2026-10-01T15:39:36.526-04:00', 'UTC')).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
    expect(mmgCreationInstant('2026-10-01T19:39:36.526+00:00', 'UTC')).toBe(Date.parse('2026-10-01T19:39:36.526Z'));
    expect(mmgCreationInstant('2026-10-01T19:39:36.526', 'UTC')).toBeNull();
    expect(mmgCreationInstant('2026-10-01T19:39:36', 'UTC')).toBeNull();
    expect(verdictFor('2026-10-01T19:39:36.526', 'UTC')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_UNREADABLE', decisive: true });
  });

  it('unset (or not valid): condition (5) cannot be verified, so a payment that meets every other condition is HELD, never credited', () => {
    for (const stamp of [guyanaTime(paid), trueUtc(paid), '2026-10-01T15:39:36.526-04:00']) {
      expect(verdictFor(stamp, null)).toEqual({ verdict: 'HOLD', txnId: 'MMGTX1', reason: 'CREATION_ZONE_UNVERIFIED', decisive: true });
    }
    // With no zone named at all, the same.
    expect(judge(uat, 'MMGTX1', found({ createdAt: guyanaTime(paid) }), [MERCHANT], [], answered)).toMatchObject({ verdict: 'HOLD', reason: 'CREATION_ZONE_UNVERIFIED', decisive: true });
    // Without MMG's success answer it waits out the window like any other mismatch.
    expect(judge(uat, 'MMGTX1', found({ createdAt: guyanaTime(paid) }), [MERCHANT], [], unanswered, { zone: null, firstReplyAt: replied }))
      .toMatchObject({ verdict: 'HOLD', reason: 'CREATION_ZONE_UNVERIFIED', decisive: false });
  });

  it('the 1 Oct UAT round trip still confirms with GUYANA_WALL_CLOCK', () => {
    expect(verdictFor('2026-10-01T15:39:36.526Z', 'GUYANA_WALL_CLOCK')).toEqual({ verdict: 'CONFIRM', txnId: 'MMGTX1', ledgerReference: 'MMGLEDGER1' });
  });

  it('the DS632 scenario, both ways: a payment made 3h48m before the checkout is never this checkout’s, whichever way MMG writes the stamp; a payment made inside it confirms only when the zone matches', () => {
    // MMG writes true UTC; Swift is configured UTC.
    expect(verdictFor(trueUtc(before), 'UTC')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
    expect(verdictFor(trueUtc(paid), 'UTC')).toEqual({ verdict: 'CONFIRM', txnId: 'MMGTX1', ledgerReference: 'MMGLEDGER1' });
    // MMG writes Guyana time (UAT); Swift is configured GUYANA_WALL_CLOCK.
    expect(verdictFor(guyanaTime(before), 'GUYANA_WALL_CLOCK')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
    expect(verdictFor(guyanaTime(paid), 'GUYANA_WALL_CLOCK')).toEqual({ verdict: 'CONFIRM', txnId: 'MMGTX1', ledgerReference: 'MMGLEDGER1' });
    // Unset: neither is credited.
    for (const stamp of [trueUtc(before), trueUtc(paid), guyanaTime(before), guyanaTime(paid)]) {
      expect(verdictFor(stamp, null)).toMatchObject({ verdict: 'HOLD', reason: 'CREATION_ZONE_UNVERIFIED' });
    }
    // A zone that does not match what MMG writes never credits a payment made in time.
    expect(verdictFor(trueUtc(paid), 'GUYANA_WALL_CLOCK')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: true });
    expect(verdictFor(guyanaTime(paid), 'UTC')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
  });

  it('[Sol delta3] a payment four hours older than the checkout, written in true UTC but read as Guyana time, lands three minutes after the reply and is HELD: two minutes bind', () => {
    // MMG writes 15:42:05Z meaning true UTC: four hours before the checkout
    // opened (19:38:19Z). Read as Guyana time it becomes 19:42:05Z: inside the
    // checkout's window, and three minutes after the reply (19:39:05Z).
    expect(verdictFor('2026-10-01T15:42:05.000Z', 'GUYANA_WALL_CLOCK'))
      .toEqual({ verdict: 'HOLD', txnId: 'MMGTX1', reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: true });
  });

  it('PAYMENT_TIME_AFTER_REPLY: MMG’s time for the payment may be at most two minutes after Swift first saw a reply naming the transaction', () => {
    expect(verdictFor(guyanaTime(new Date(replied.getTime() + 120_000)), 'GUYANA_WALL_CLOCK').verdict).toBe('CONFIRM');
    expect(verdictFor(guyanaTime(new Date(replied.getTime() + 120_001)), 'GUYANA_WALL_CLOCK'))
      .toEqual({ verdict: 'HOLD', txnId: 'MMGTX1', reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: true });
    expect(verdictFor(trueUtc(new Date(replied.getTime() + 120_001)), 'UTC')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AFTER_REPLY' });
    // A true-UTC stamp read as Guyana time lands four hours late: caught here, before the window.
    expect(verdictFor(trueUtc(paid), 'GUYANA_WALL_CLOCK')).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AFTER_REPLY' });
    // Without MMG's success answer it waits out the window like any other mismatch.
    expect(judge(uat, 'MMGTX1', found(), [MERCHANT], [], unanswered, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: replied, history: historyOf(record(trueUtc(paid))) }))
      .toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: false });
    // A transaction no reply named cannot be bounded, and holds the same way.
    expect(verdictFor(guyanaTime(paid), 'GUYANA_WALL_CLOCK', null)).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: true });
  });
});

describe('the reference MMG’s lookup echoes [F1] (UAT, 1 Oct: no lookup field carries it)', () => {
  it('no field carries it, so no lookup answer, whatever it carries, binds to a checkout', () => {
    expect(MMG_LOOKUP_REFERENCE_FIELDS).toEqual([]);
    const answer = { merchantTransactionId: REF, reference: REF, merchantReference: REF, externalReference: REF, orderId: REF, description: REF };
    expect(echoedReferencesFrom(answer)).toEqual([]);
  });

  it('reads exactly the named key paths, whole strings only: never a substring, never a number', () => {
    const answer = { a: REF, nested: { ref: REF }, text: `Swift ${REF}`, num: Number(REF), deep: { x: { y: OTHER_REF } } };
    expect(echoedReferencesFrom(answer, ['a'])).toEqual([REF]);
    expect(echoedReferencesFrom(answer, ['nested.ref', 'deep.x.y'])).toEqual([REF, OTHER_REF]);
    expect(echoedReferencesFrom(answer, ['text'])).toEqual([`Swift ${REF}`]);
    expect(echoedReferencesFrom(answer, ['num', 'missing', 'nested', 'a.b'])).toEqual([]);
    expect(echoedReferencesFrom(null, ['a'])).toEqual([]);
  });
});

describe('[DS633] the contract says what a PAYMENT_CONFIRMING refusal carries', () => {
  it('documents error.details.ref as optional: a client never relies on it', () => {
    const contract = readFileSync(join(__dirname, '..', 'modules/billing/MMG-CHECKOUT-API.md'), 'utf8');
    const row = contract.split('\n').find((line) => line.startsWith('| 409 | `PAYMENT_CONFIRMING`'));
    expect(row, 'the PAYMENT_CONFIRMING row of section 4').toBeDefined();
    expect(row).toMatch(/`error\.details\.ref` is optional/);
  });
});

describe('the backfill completion record [F2]', () => {
  it('lives under a key the admin config route can never write, so it cannot be set by hand', () => {
    // The route's own key rule, read from its source: widening it to allow ':'
    // would let a person switch checkout crediting on without the backfill.
    const routes = readFileSync(join(__dirname, '..', 'modules/admin/admin.routes.ts'), 'utf8');
    const literal = routes.match(/const configKeySchema = z\.string\(\)\.regex\(\/(.+?)\/([a-z]*),/);
    expect(literal, 'configKeySchema is still a single regex').not.toBeNull();
    const configKey = new RegExp(literal![1]!, literal![2]);
    expect(configKey.test('billing.feeCheckout.platforms')).toBe(true);
    expect(configKey.test(PROVIDER_IDENTITY_BACKFILL_KEY)).toBe(false);
  });
});

describe('the amount a checkout charges [I1]', () => {
  it('is the amount due rounded UP to whole GYD, or one week when nothing is due', () => {
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 2100 })).toBe(2100);
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 1049.5 })).toBe(1050);
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 1049.01 })).toBe(1050);
    expect(checkoutAmountGyd({ weeklyFeeGyd: 2100, amountDueGyd: 0 })).toBe(2100);
  });
});

// -- payActions ------------------------------------------------------------------

const liveProvider = () => ({ driver: 'sandbox', merchantId: MERCHANT }) as unknown as MmgCheckoutProvider;
const offProvider = () => ({ driver: 'disabled', merchantId: null }) as unknown as MmgCheckoutProvider;
const brokenProvider = (): MmgCheckoutProvider => { throw new Error('FATAL: MMG_CHECKOUT_MERCHANT_ID is required'); };
const sub = (patch: Record<string, unknown> = {}) => ({
  id: 'sub-1', status: 'ACTIVE' as const, feeWaived: false, currencyCode: 'GYD',
  weeklyRate: new Prisma.Decimal(2100), customRate: null, nextBillingDate: new Date('2026-10-02T12:00:00Z'), ...patch,
});
/** A test double of the one delegate the rule reads: the per-platform switch row. */
function configWith(value: unknown): Pick<PrismaClient, 'platformConfig'> {
  const findUnique = vi.fn(async ({ where }: { where: { key: string } }) => (where.key === FEE_CHECKOUT_PLATFORMS_KEY && value !== undefined ? { key: where.key, value } : null));
  return { platformConfig: { findUnique } } as unknown as Pick<PrismaClient, 'platformConfig'>;
}

describe('payActions — MMG_CHECKOUT is live only when it truly is, and off is hidden', () => {
  beforeEach(() => resetFeeCheckoutSwitchCache());

  it('is live with a configured checkout, a payable subscription and the platform switched on (a missing switch is ON)', async () => {
    for (const platform of ['ios', 'android', 'web', 'unknown'] as const) {
      resetFeeCheckoutSwitchCache();
      expect(await mmgCheckoutLive(configWith(undefined), sub(), platform, liveProvider), platform).toBe(true);
    }
  });

  it('is off when the checkout is not configured, or its configuration cannot load', async () => {
    expect(await mmgCheckoutLive(configWith(undefined), sub(), 'ios', offProvider)).toBe(false);
    expect(await mmgCheckoutLive(configWith(undefined), sub(), 'ios', brokenProvider)).toBe(false);
  });

  it.each(['PAUSED', 'CANCELLED'] as const)('is off for a %s subscription', async (status) => {
    expect(await mmgCheckoutLive(configWith(undefined), sub({ status }), 'ios', liveProvider)).toBe(false);
  });

  it('is off for a waived fee, a non-GYD subscription and a zero fee', async () => {
    expect(await mmgCheckoutLive(configWith(undefined), sub({ feeWaived: true }), 'ios', liveProvider)).toBe(false);
    expect(await mmgCheckoutLive(configWith(undefined), sub({ currencyCode: 'USD' }), 'ios', liveProvider)).toBe(false);
    expect(await mmgCheckoutLive(configWith(undefined), sub({ weeklyRate: new Prisma.Decimal(0) }), 'ios', liveProvider)).toBe(false);
  });

  it.each(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED'] as const)('a %s subscription can pay (paying rejoins a churned one)', async (status) => {
    expect(await mmgCheckoutLive(configWith(undefined), sub({ status }), 'android', liveProvider)).toBe(true);
  });

  it('the per-platform switch turns one platform off, and an unknown platform then counts as off', async () => {
    const config = configWith({ ios: false });
    expect(await mmgCheckoutLive(config, sub(), 'ios', liveProvider)).toBe(false);
    expect(await mmgCheckoutLive(config, sub(), 'android', liveProvider)).toBe(true);
    expect(await mmgCheckoutLive(config, sub(), 'web', liveProvider)).toBe(true);
    expect(await mmgCheckoutLive(config, sub(), 'unknown', liveProvider)).toBe(false);
  });

  it('[DS633] only a real boolean counts: any other value switches that platform off, with a warning; a row that is not an object switches every platform off', async () => {
    const warn = vi.fn();
    setAppLogger({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never);
    try {
      for (const value of [{ ios: 'false' }, { ios: 'no' }, { ios: 'true' }, { ios: 0 }, { ios: 1 }, { ios: null }, { ios: {} }]) {
        resetFeeCheckoutSwitchCache();
        warn.mockClear();
        const config = configWith(value);
        expect(await mmgCheckoutLive(config, sub(), 'ios', liveProvider), JSON.stringify(value)).toBe(false);
        expect(await mmgCheckoutLive(config, sub(), 'android', liveProvider), JSON.stringify(value)).toBe(true);
        expect(await mmgCheckoutLive(config, sub(), 'unknown', liveProvider), JSON.stringify(value)).toBe(false);
        expect(warn, JSON.stringify(value)).toHaveBeenCalled();
      }
      for (const value of [[], 'off', false, 0, null]) {
        resetFeeCheckoutSwitchCache();
        warn.mockClear();
        for (const platform of ['ios', 'android', 'web', 'unknown'] as const) {
          expect(await mmgCheckoutLive(configWith(value), sub(), platform, liveProvider), `${JSON.stringify(value)} ${platform}`).toBe(false);
        }
        expect(warn, JSON.stringify(value)).toHaveBeenCalled();
      }
      // Real booleans, and a platform missing from the row (owner ruling "3 b": on), warn about nothing.
      resetFeeCheckoutSwitchCache();
      warn.mockClear();
      const config = configWith({ ios: false, android: true });
      expect(await mmgCheckoutLive(config, sub(), 'ios', liveProvider)).toBe(false);
      expect(await mmgCheckoutLive(config, sub(), 'android', liveProvider)).toBe(true);
      expect(await mmgCheckoutLive(config, sub(), 'web', liveProvider)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      setAppLogger(console);
    }
  });

  it('the platform is what the client says, from the existing x-client-platform header', () => {
    expect(clientPlatform({ 'x-client-platform': 'iOS' })).toBe('ios');
    expect(clientPlatform({ 'x-client-platform': 'android' })).toBe('android');
    expect(clientPlatform({ 'x-client-platform': 'web' })).toBe('web');
    expect(clientPlatform({ 'x-client-platform': 'desktop' })).toBe('unknown');
    expect(clientPlatform({})).toBe('unknown');
  });

  it('payActions carry the amount only when live, CARD is off, and no agent, cash or Swift Number action exists', async () => {
    const prisma = {
      ...configWith(undefined),
      prepaidBalance: { findUnique: vi.fn(async () => ({ balance: new Prisma.Decimal(600) })) },
      // [#1389] payInfo's due-now reads an issued charge first; none here.
      subscriptionPayment: { findFirst: vi.fn(async () => null) },
      tenantBillingCurrency: { findUnique: vi.fn(async () => null) },
    } as never;
    expect(await feePayActions(prisma, sub(), 'ios', liveProvider)).toEqual([
      { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1500, currencyCode: 'GYD' },
      { id: 'CARD', state: 'off' },
    ]);
    resetFeeCheckoutSwitchCache();
    const off = await feePayActions(prisma, sub(), 'ios', offProvider);
    expect(off).toEqual([{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }]);
    expect(JSON.stringify(off)).not.toMatch(/agent|cash|san|swift ?number|account/i);
  });
});

// -- notices ---------------------------------------------------------------------

/** What no partner-facing fee wording may offer (owner, 2026-09-29). */
const FORBIDDEN = /MMG agent|any agent|at an agent|cash|Swift Number|account number|coming soon/i;

describe('what a fee notice may say', () => {
  it('points to the checkout for exactly the amount, or states the amount and when it is due', () => {
    expect(mmgPayLine(1500)).toBe('Pay GY$1,500 with MMG in the Swift app.');
    expect(feeDueLine(2100, 'GYD', null)).toBe('The weekly fee of GY$2,100 is due now.');
    expect(feeDueLine(2100.5, 'GYD', new Date('2026-09-29T15:00:00Z'), { first: true })).toBe('Your first weekly fee of GY$2,100.50 is due on Tue 29 Sep.');
    expect(feeCoveredLine(2100, 'GYD', { first: true })).toBe('Your balance already covers your first weekly fee of GY$2,100.');
  });

  it('dates in Guyana time (UTC−4, no daylight saving)', () => {
    expect(guyanaDay(new Date('2026-09-30T03:59:00Z'))).toBe('Tue 29 Sep');
    expect(guyanaDay(new Date('2026-09-30T04:00:00Z'))).toBe('Wed 30 Sep');
  });

  it('never offers an agent, cash, a Swift Number or an account number, nor "coming soon"', () => {
    for (const line of [mmgPayLine(1500), feeDueLine(1, 'GYD', null), feeCoveredLine(1, 'GYD'), FEE_RESTORE_LINE]) {
      expect(line).not.toMatch(FORBIDDEN);
    }
  });
});

describe('the census: no fee-notice source offers an agent, cash, a Swift Number or an account number', () => {
  // Every string a fee notice is built from lives in these files. Comments may
  // name what was removed; code may not say it to a partner.
  const SOURCES = [
    'modules/billing/fee-notice-copy.ts',
    'modules/billing/fee-pay-actions.ts',
    'modules/billing/trial-fee-education.ts',
    'modules/billing/mmg-checkout.service.ts',
    'modules/billing/billing.service.ts',
  ];
  const PARTNER_OFFER = /MMG agent|any MMG agent|at an agent|Swift Number|Swift account number|coming soon|Pay cash/i;

  it.each(SOURCES)('%s', (file) => {
    const code = readFileSync(join(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code.match(PARTNER_OFFER)?.[0] ?? null).toBeNull();
  });
});
