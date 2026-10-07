import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  MMG_HISTORY_MARGIN_MS,
  MMG_HISTORY_ROWS,
  MMG_HISTORY_SUCCESS,
  historyQueryFor,
  judge,
  mmgCreationInstant,
  mmgStampOf,
  paymentHistoryOf,
  paymentTimeCheckOf,
  rowsNaming,
  type PaymentHistory,
  type SuccessAnswer,
} from '../modules/billing/mmg-checkout.service';
import { lookupDetailFrom, type MmgLookupDetail } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// [7 Oct] Condition (5) of the owner's automatic confirmation reads the
// payment's time from MMG's Transaction History, not from the lookup.
// MMG (7 Oct): the lookup's creationDate is the moment of the LOOKUP; history's
// modificationDate is when the transaction was performed. Everything below is
// MMG UAT's own data for the 1 Oct payment, read by the 7 Oct probe:
// - the checkout opened 15:38:19 Guyana time (19:38:19Z); MMG's success reply
//   naming 20402048536279 reached Swift at 19:39:05Z;
// - history lists it with transactionReference AND transactionReceipt equal to
//   that transactionId (not the lookup's ledger number), transactionStatus
//   "completed", amount "500", GYD, modificationDate "2026-10-01T15:38:31.000Z"
//   (Guyana wall clock written with a "Z": 19:38:31Z, 12 s after it opened);
// - the lookup, asked on 7 Oct, stamped creationDate "2026-10-07T12:21:18.777Z":
//   its own moment.
// ---------------------------------------------------------------------------

const TXN = '20402048536279';
const LEDGER = '20402048601581';
const MERCHANT = '5926000001';
const opened = new Date('2026-10-01T19:38:19Z');
const uat = { merchantTransactionId: '1790883499', amount: new Prisma.Decimal(500), currencyCode: 'GYD', createdAt: opened, expiresAt: new Date(opened.getTime() + 30 * 60_000) };
const replied = new Date('2026-10-01T19:39:05Z');
/** Guyana wall-clock time written with a "Z", as MMG writes its times (UAT). */
const wall = (at: Date | number) => new Date(new Date(at).getTime() - 4 * 3_600_000).toISOString();
/** MMG's history row for the 1 Oct payment (party values are synthetic; probe 2 proved external_id is the checkout reference). */
const ROW = {
  amount: '500', currency: 'GYD', displayType: 'EMerchant Payment', transactionStatus: 'completed', descriptionText: '',
  modificationDate: '2026-10-01T15:38:31.000Z', transactionReference: TXN, transactionReceipt: TXN,
  debitParty: [{ key: 'accountid', value: 'P-DEBIT' }, { key: 'accountcategory', value: 'P-CAT' }],
  creditParty: [{ key: 'accountid', value: 'P-CREDIT' }, { key: 'accountcategory', value: 'P-CAT' }],
  external_id: uat.merchantTransactionId,
};
const row = (patch: Record<string, unknown> = {}) => ({ ...ROW, ...patch });
/** The same day's other UAT row: a payment that is not this one. */
const OTHER = row({ modificationDate: '2026-10-01T15:38:15.000Z', transactionReference: '20402048536111', transactionReceipt: '20402048536111' });
const LOOKUP_CLOCK = '2026-10-07T12:21:18.777Z';
/** MMG's lookup of the 1 Oct payment, its creationDate whatever `creationDate` is. */
const lookupWith = (creationDate: unknown, patch: Partial<Extract<MmgLookupDetail, { outcome: 'found' }>> = {}): MmgLookupDetail => ({
  ...lookupDetailFrom({
    amount: '500', currency: 'GYD', subType: 'subscriber_mpay', descriptionText: null, requestDate: 'P-REQUEST',
    debitParty: [{ key: 'accountid', value: '6000002' }], creditParty: [{ key: 'accountid', value: MERCHANT }],
    metadata: [{ key: 'amount', value: '500' }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
    transactionStatus: 'successful', creationDate, transactionReference: LEDGER, transactionReceipt: 'P-RECEIPT', executionId: 'P-EXEC',
  }, TXN),
  ...patch,
});
const answered: SuccessAnswer = { txnId: TXN };
const unanswered: SuccessAnswer = { txnId: null, reason: 'NO_SUCCESS_ANSWER' };
const rows = (naming: Record<string, unknown>[], truncated = false): PaymentHistory => ({ outcome: 'rows', naming, truncated });
const verdictOf = (history: PaymentHistory | null | undefined, o: {
  detail?: MmgLookupDetail; success?: SuccessAnswer; zone?: 'GUYANA_WALL_CLOCK' | 'UTC' | null; reply?: Date | null;
} = {}) => judge(uat, TXN, o.detail ?? lookupWith(LOOKUP_CLOCK), [MERCHANT], [], o.success ?? answered, {
  zone: o.zone === undefined ? 'GUYANA_WALL_CLOCK' : o.zone, firstReplyAt: o.reply === undefined ? replied : o.reply, history,
});
const CONFIRMED = { verdict: 'CONFIRM', txnId: TXN, ledgerReference: LEDGER };

describe('[7 Oct] condition (5): the payment time is MMG history’s modificationDate for THIS transaction, never the lookup’s clock', () => {
  it('the 1 Oct UAT payment confirms by its history time (12 s after the checkout opened), whatever the lookup’s own clock says', () => {
    for (const creationDate of [LOOKUP_CLOCK, '2026-10-01T15:39:36.526Z', null, 'yesterday']) {
      expect(verdictOf(rows([ROW]), { detail: lookupWith(creationDate) }), String(creationDate)).toEqual(CONFIRMED);
    }
    expect(paymentTimeCheckOf(uat, TXN, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: replied, history: rows([ROW]) })).toBe('INSIDE');
  });

  it.each([
    ['missing', undefined], ['null', null], ['empty', ''], ['different', '1790883498'],
    ['MMG transaction id', TXN], ['lookup ledger number', LEDGER],
    ['number', 1790883499], ['leading space', ' 1790883499'], ['trailing space', '1790883499 '],
    ['prefix', 'x1790883499'], ['suffix', '1790883499x'], ['newline', '1790883499\n'],
  ])('history external_id %s is a decisive HOLD, even without a successful checkout reply', (_name, external_id) => {
    for (const success of [answered, unanswered]) {
      expect(verdictOf(rows([row({ external_id })]), { success }))
        .toEqual({ verdict: 'HOLD', txnId: TXN, reason: 'HISTORY_REFERENCE_MISMATCH', decisive: true });
    }
  });

  it('a late lookup of an in-time payment confirms: MMG stamps creationDate with the moment of the lookup', () => {
    for (const lateMs of [3.5 * 60_000, 3_600_000, 6 * 86_400_000]) {
      expect(verdictOf(rows([ROW]), { detail: lookupWith(wall(replied.getTime() + lateMs)) })).toEqual(CONFIRMED);
    }
  });

  it('what the lookup’s clock let through is HELD: a payment made 3h48m before the checkout opened, with MMG’s prompt lookup stamping its own moment', () => {
    const before = opened.getTime() - (3 * 60 + 48) * 60_000;
    const prompt = lookupWith(wall(replied.getTime() + 20_000));
    expect(verdictOf(rows([row({ modificationDate: wall(before) })]), { detail: prompt }))
      .toEqual({ verdict: 'HOLD', txnId: TXN, reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
    // A week before, the same.
    expect(verdictOf(rows([row({ modificationDate: wall(opened.getTime() - 7 * 86_400_000) })]), { detail: prompt }))
      .toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
  });

  it('the zone binds: read as UTC, the 1 Oct history time is four hours before the checkout existed, and is HELD', () => {
    expect(mmgCreationInstant(ROW.modificationDate, 'GUYANA_WALL_CLOCK')).toBe(Date.parse('2026-10-01T19:38:31Z'));
    expect(verdictOf(rows([ROW]), { zone: 'UTC' })).toEqual({ verdict: 'HOLD', txnId: TXN, reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', decisive: true });
  });

  it('[Sol delta3] a time four hours older than the checkout, written in true UTC but read as Guyana time, lands three minutes after the reply and is HELD', () => {
    expect(verdictOf(rows([row({ modificationDate: '2026-10-01T15:42:05.000Z' })])))
      .toEqual({ verdict: 'HOLD', txnId: TXN, reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: true });
  });

  it('two minutes of clock tolerance on each side, and no more: the window opens two minutes before the checkout and closes two minutes after the first reply or the deadline, whichever is first', () => {
    const at = (ms: number, reply: Date = replied) => verdictOf(rows([row({ modificationDate: wall(ms) })]), { reply });
    expect(at(opened.getTime() - 120_000)).toEqual(CONFIRMED);
    expect(at(opened.getTime() - 120_001)).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW' });
    expect(at(replied.getTime() + 120_000)).toEqual(CONFIRMED);
    expect(at(replied.getTime() + 120_001)).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AFTER_REPLY' });
    // A reply that came after the deadline: the deadline binds.
    const lateReply = new Date(uat.expiresAt.getTime() + 5 * 60_000);
    expect(at(uat.expiresAt.getTime() + 120_000, lateReply)).toEqual(CONFIRMED);
    expect(at(uat.expiresAt.getTime() + 120_001, lateReply)).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_OUTSIDE_WINDOW' });
  });

  it('a transaction no reply named cannot be bounded, and with no zone set nothing is verified: both HELD', () => {
    expect(verdictOf(rows([ROW]), { reply: null })).toEqual({ verdict: 'HOLD', txnId: TXN, reason: 'PAYMENT_TIME_AFTER_REPLY', decisive: true });
    expect(verdictOf(rows([ROW]), { zone: null })).toEqual({ verdict: 'HOLD', txnId: TXN, reason: 'CREATION_ZONE_UNVERIFIED', decisive: true });
    expect(verdictOf(rows([ROW]), { zone: null, success: unanswered })).toMatchObject({ verdict: 'HOLD', reason: 'CREATION_ZONE_UNVERIFIED', decisive: false });
  });

  it.each([
    ['history was never asked', undefined, 'PAYMENT_TIME_UNAVAILABLE'],
    ['history was never asked (null)', null, 'PAYMENT_TIME_UNAVAILABLE'],
    ['MMG’s history could not be read', { outcome: 'error' } as PaymentHistory, 'PAYMENT_TIME_UNAVAILABLE'],
    ['no row in the window', rows([]), 'PAYMENT_TIME_NOT_IN_HISTORY'],
    ['an answer cut short at the row limit, ours not in it', rows([], true), 'PAYMENT_TIME_UNAVAILABLE'],
    ['an answer cut short at the row limit, ours in it (another may be cut off)', rows([ROW], true), 'PAYMENT_TIME_UNAVAILABLE'],
  ] as const)('%s: HELD, never credited; it may resolve on a later check, so it waits out the window while confirming, and holds at once on a late check when MMG’s answer ties it to this checkout', (_label, history, reason) => {
    expect(verdictOf(history)).toEqual({ verdict: 'HOLD', txnId: TXN, reason, decisive: false, decisiveWhenLate: true });
    expect(verdictOf(history, { success: unanswered })).toEqual({ verdict: 'HOLD', txnId: TXN, reason, decisive: false, decisiveWhenLate: false });
  });

  it.each([
    ['two rows naming it', [ROW, ROW], 'PAYMENT_TIME_AMBIGUOUS'],
    ['two rows naming it, at different times', [ROW, row({ modificationDate: '2026-10-01T15:38:40.000Z' })], 'PAYMENT_TIME_AMBIGUOUS'],
    ['its receipt is another number', [row({ transactionReceipt: '20402048536111' })], 'PAYMENT_TIME_DISAGREES'],
    ['its reference is another number', [row({ transactionReference: LEDGER })], 'PAYMENT_TIME_DISAGREES'],
    ['its reference as a JSON number', [row({ transactionReference: 20402048536279 })], 'PAYMENT_TIME_DISAGREES'],
    ['the lookup’s word "successful", which history does not use', [row({ transactionStatus: 'successful' })], 'PAYMENT_TIME_DISAGREES'],
    ['"Completed" in capitals', [row({ transactionStatus: 'Completed' })], 'PAYMENT_TIME_DISAGREES'],
    ['"pending"', [row({ transactionStatus: 'pending' })], 'PAYMENT_TIME_DISAGREES'],
    ['no status', [row({ transactionStatus: undefined })], 'PAYMENT_TIME_DISAGREES'],
    ['one cent short', [row({ amount: '499.99' })], 'PAYMENT_TIME_DISAGREES'],
    ['another amount', [row({ amount: '1500' })], 'PAYMENT_TIME_DISAGREES'],
    ['no amount', [row({ amount: undefined })], 'PAYMENT_TIME_DISAGREES'],
    ['another currency', [row({ currency: 'USD' })], 'PAYMENT_TIME_DISAGREES'],
    ['no currency', [row({ currency: undefined })], 'PAYMENT_TIME_DISAGREES'],
    ['a time that cannot be read', [row({ modificationDate: 'yesterday' })], 'PAYMENT_TIME_UNREADABLE'],
    ['a date with no time', [row({ modificationDate: '2026-10-01' })], 'PAYMENT_TIME_UNREADABLE'],
    ['no time', [row({ modificationDate: undefined })], 'PAYMENT_TIME_UNREADABLE'],
  ] as const)('a history row for it with %s is HELD for a person, never credited: at once when MMG’s answer ties it to this checkout', (_label, naming, reason) => {
    expect(verdictOf(rows([...naming]))).toEqual({ verdict: 'HOLD', txnId: TXN, reason, decisive: true });
    expect(verdictOf(rows([...naming]), { success: unanswered })).toEqual({ verdict: 'HOLD', txnId: TXN, reason, decisive: false });
  });

  it('"completed" is the one word history uses for a finished payment (UAT, 7 Oct); nothing else counts', () => {
    expect(MMG_HISTORY_SUCCESS).toEqual(['completed']);
  });

  it.each([
    ['MMG’s lookup word is not "successful"', { detail: lookupWith(LOOKUP_CLOCK, { statusText: 'completed' }) }, 'STATUS_NOT_SUCCESSFUL'],
    ['one cent short in the lookup', { detail: lookupWith(LOOKUP_CLOCK, { amountMinor: 49_999 }) }, 'AMOUNT_MISMATCH'],
    ['another currency in the lookup', { detail: lookupWith(LOOKUP_CLOCK, { currencyCode: 'USD' }) }, 'CURRENCY_MISMATCH'],
    ['paid to someone else’s merchant', { detail: lookupWith(LOOKUP_CLOCK, { creditAccounts: ['5926999999'] }) }, 'MERCHANT_MISMATCH'],
    ['no merchant named', { detail: lookupWith(LOOKUP_CLOCK, { creditAccounts: null }) }, 'MERCHANT_UNCONFIRMED'],
    ['no ledger number', { detail: lookupWith(LOOKUP_CLOCK, { ledgerReference: null }) }, 'LEDGER_REFERENCE_MISSING'],
    ['no success answer from MMG for this checkout', { success: unanswered }, 'NO_SUCCESS_ANSWER'],
    ['MMG’s success answer named another transaction', { success: { txnId: '20402048536111' } }, 'NOT_THE_ANSWERED_TRANSACTION'],
    ['a success answer received after the checkout closed', { success: { txnId: null, reason: 'SUCCESS_ANSWER_AFTER_CLOSE' } }, 'SUCCESS_ANSWER_AFTER_CLOSE'],
  ] as const)('no other condition is loosened: with the history time inside, %s is still HELD, never credited', (_label, o, reason) => {
    expect(verdictOf(rows([ROW]), o as never)).toMatchObject({ verdict: 'HOLD', reason });
  });

  it('a payment that is not one, or that MMG does not know, is never confirmed by its history', () => {
    expect(verdictOf(rows([ROW]), { detail: lookupWith(LOOKUP_CLOCK, { status: 'pending' }) }).verdict).toBe('PENDING');
    expect(verdictOf(rows([ROW]), { detail: lookupWith(LOOKUP_CLOCK, { status: 'declined' }) }).verdict).toBe('DECLINED');
    expect(verdictOf(rows([ROW]), { detail: { outcome: 'not_found' } }).verdict).toBe('NOT_FOUND');
    expect(verdictOf(rows([ROW]), { detail: { outcome: 'error', reason: 'x' } }).verdict).toBe('ERROR');
  });
});

describe('[7 Oct] which history rows name a transaction, and what Swift writes down', () => {
  it('a row names the transaction when its transactionReference or transactionReceipt IS it: a whole string, never a substring or a number', () => {
    const byReference = row({ transactionReceipt: 'X' });
    const byReceipt = row({ transactionReference: 'Y' });
    const naming = rowsNaming([OTHER, ROW, byReference, byReceipt, row({ transactionReference: ` ${TXN}`, transactionReceipt: `${TXN}0` }), row({ transactionReference: Number(TXN), transactionReceipt: Number(TXN) }), row({ transactionReference: null, transactionReceipt: undefined })], TXN);
    expect(naming).toEqual([ROW, byReference, byReceipt]);
    // A second record naming it either way makes the answer ambiguous: held, never credited.
    expect(verdictOf(rows(rowsNaming([ROW, byReceipt], TXN)))).toMatchObject({ verdict: 'HOLD', reason: 'PAYMENT_TIME_AMBIGUOUS', decisive: true });
  });

  it('reads back exactly what was written down: MMG’s failure is an error; a stored answer needs its naming rows and a yes/no for being cut short, or it is an error', () => {
    expect(paymentHistoryOf({ failure: 'HISTORY_FAILED', body: { naming: [ROW], truncated: false } })).toEqual({ outcome: 'error' });
    expect(paymentHistoryOf({ failure: null, body: { query: {}, rowsReturned: 2, truncated: false, naming: [ROW] } })).toEqual(rows([ROW]));
    expect(paymentHistoryOf({ failure: 'HISTORY_NOT_FOUND', body: { rowsReturned: 1, truncated: false, naming: [] } })).toEqual(rows([]));
    expect(paymentHistoryOf({ failure: null, body: { truncated: true, naming: [ROW] } })).toEqual(rows([ROW], true));
    for (const body of [null, 'x', [], { truncated: false }, { naming: [ROW] }, { naming: {}, truncated: false }, { naming: [ROW, null], truncated: false }, { naming: [ROW], truncated: 'false' }]) {
      expect(paymentHistoryOf({ failure: null, body }), JSON.stringify(body)).toEqual({ outcome: 'error' });
    }
  });
});

describe('[7 Oct] the history query: MMG reads its dates as its own stamps, and `offset` is a row COUNT', () => {
  it('writes an instant the way MMG reads it, to the whole second: Guyana wall clock with a "Z", or UTC', () => {
    // The probe's narrow window that found the 1 Oct rows was written exactly so.
    expect(mmgStampOf(Date.parse('2026-10-01T19:30:00Z'), 'GUYANA_WALL_CLOCK')).toBe('2026-10-01T15:30:00.000Z');
    expect(mmgStampOf(Date.parse('2026-10-01T19:30:00Z'), 'UTC')).toBe('2026-10-01T19:30:00.000Z');
    expect(mmgStampOf(Date.parse('2026-10-01T19:30:00.400Z'), 'GUYANA_WALL_CLOCK')).toBe('2026-10-01T15:30:00.000Z');
    expect(mmgStampOf(Date.parse('2026-10-01T19:30:00.400Z'), 'GUYANA_WALL_CLOCK', 'ceil')).toBe('2026-10-01T15:30:01.000Z');
    expect(mmgStampOf(Date.parse('2027-01-01T02:30:00Z'), 'GUYANA_WALL_CLOCK')).toBe('2026-12-31T22:30:00.000Z');
    for (const zone of ['GUYANA_WALL_CLOCK', 'UTC'] as const) {
      for (const at of [Date.parse('2026-10-01T19:38:31Z'), Date.parse('2026-03-08T06:59:59Z'), Date.parse('2026-12-31T23:59:59Z')]) {
        expect(mmgCreationInstant(mmgStampOf(at, zone), zone), `${zone} ${at}`).toBe(at);
      }
    }
  });

  it('asks for every row from two minutes and the margin before the checkout opened, to two minutes and the margin after the first reply or the deadline, never past now; up to MMG_HISTORY_ROWS rows', () => {
    expect(MMG_HISTORY_ROWS).toBe(100);
    expect(MMG_HISTORY_MARGIN_MS).toBe(10 * 60_000);
    // Asked five seconds after the reply: the window ends now (rounded up to the second).
    expect(historyQueryFor(uat, replied, 'GUYANA_WALL_CLOCK', new Date('2026-10-01T19:39:10.200Z')))
      .toEqual({ fromdate: '2026-10-01T15:26:19.000Z', todate: '2026-10-01T15:39:11.000Z', rows: 100 });
    // Asked later: twelve minutes after the reply.
    expect(historyQueryFor(uat, replied, 'GUYANA_WALL_CLOCK', new Date('2026-10-01T22:00:00Z')))
      .toEqual({ fromdate: '2026-10-01T15:26:19.000Z', todate: '2026-10-01T15:51:05.000Z', rows: 100 });
    expect(historyQueryFor(uat, replied, 'UTC', new Date('2026-10-01T22:00:00Z')))
      .toEqual({ fromdate: '2026-10-01T19:26:19.000Z', todate: '2026-10-01T19:51:05.000Z', rows: 100 });
    // A reply after the deadline: the deadline bounds it.
    expect(historyQueryFor(uat, new Date(uat.expiresAt.getTime() + 5 * 60_000), 'GUYANA_WALL_CLOCK', new Date('2026-10-02T00:00:00Z')).todate)
      .toBe('2026-10-01T16:20:19.000Z');
  });

  it('every time the rule accepts lies inside the window asked for', () => {
    const query = historyQueryFor(uat, replied, 'GUYANA_WALL_CLOCK', new Date('2026-10-01T22:00:00Z'));
    const from = mmgCreationInstant(query.fromdate, 'GUYANA_WALL_CLOCK')!;
    const to = mmgCreationInstant(query.todate, 'GUYANA_WALL_CLOCK')!;
    for (let at = opened.getTime() - 120_000; at <= replied.getTime() + 120_000; at += 7_000) {
      expect(paymentTimeCheckOf(uat, TXN, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: replied, history: rows([row({ modificationDate: wall(Math.floor(at / 1000) * 1000) })]) })).toBe('INSIDE');
      expect(at >= from && at <= to).toBe(true);
    }
  });
});
