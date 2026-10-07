import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  decodeSupportCursor,
  encodeSupportCursor,
  normaliseSupportQuery,
  timelineEntryOf,
  windowCheckOf,
} from '../modules/billing/mmg-checkout-support';
import { partnerReceiptIds } from '../modules/billing/mmg-checkout-receipt';
import { judge, type PaymentHistory } from '../modules/billing/mmg-checkout.service';
import { lookupDetailFrom } from '../providers/mmg/mmg-provider';
import { MMG_CHECKOUT_TIMELINE_KEYS } from '@swift/types';

// ---------------------------------------------------------------------------
// [MMG support lookup] The pure rules behind support's search and the partner's
// receipt: how a query is read (exact, digits only for ids, E.164 for phones),
// how a page is continued, what a timeline entry may say (an allowlist, never
// MMG's HTML or a token), that the window it reports is the window judge()
// decides with, and that MMG's id reaches a partner only once CONFIRMED.
// ---------------------------------------------------------------------------

describe('a support query is read exactly: digits only for ids, E.164 for phones', () => {
  it('an id keeps only its digits, however it was pasted', () => {
    expect(normaliseSupportQuery('175933812345601234').digits).toBe('175933812345601234');
    expect(normaliseSupportQuery('  MMG-2040 2048 536279 ').digits).toBe('20402048536279');
    expect(normaliseSupportQuery('Ref: 20402048601581.').digits).toBe('20402048601581');
  });

  it('too few digits to be an id is no id (a partial is never searched)', () => {
    expect(normaliseSupportQuery('12345').digits).toBeNull();
    expect(normaliseSupportQuery('abc').digits).toBeNull();
    expect(normaliseSupportQuery('').digits).toBeNull();
  });

  it('a phone becomes E.164: +592 kept, a 7-digit Guyana number gains +592, 592… gains +', () => {
    expect(normaliseSupportQuery('+592 600 1234').phones).toEqual(['+5926001234']);
    expect(normaliseSupportQuery('600-1234').phones).toEqual(['+5926001234']);
    expect(normaliseSupportQuery('5926001234').phones).toEqual(['+5926001234']);
    expect(normaliseSupportQuery('(592) 600 1234').phones).toEqual(['+5926001234']);
  });

  it('a long id is never read as a phone, and a + number that is not E.164 is not one', () => {
    expect(normaliseSupportQuery('20402048536279').phones).toEqual([]);
    expect(normaliseSupportQuery('175933812345601234').phones).toEqual([]);
    expect(normaliseSupportQuery('+12').phones).toEqual([]);
    expect(normaliseSupportQuery('+0592600123').phones).toEqual([]);
  });

  it('the shape says what was tried, never the value', () => {
    expect(normaliseSupportQuery('20402048536279').shape).toBe('ID');
    expect(normaliseSupportQuery('+5926001234').shape).toBe('ID_OR_PHONE');
    expect(normaliseSupportQuery('6001234').shape).toBe('ID_OR_PHONE');
    expect(normaliseSupportQuery('xyz').shape).toBe('UNUSABLE');
    expect(normaliseSupportQuery('').shape).toBe('EMPTY');
  });
});

describe('a page is continued by an opaque cursor that cannot be forged into anything else', () => {
  it('round-trips the last row (newest first)', () => {
    const at = new Date('2026-10-01T15:39:36.526Z');
    expect(decodeSupportCursor(encodeSupportCursor({ createdAt: at, id: 'cmg1abc' }))).toEqual({ createdAt: at, id: 'cmg1abc' });
  });

  it('anything else is refused', () => {
    for (const bad of ['', 'x', Buffer.from('2026-10-01T00:00:00.000Z').toString('base64url'), Buffer.from('not-a-date|abc').toString('base64url'),
      Buffer.from('2026-10-01T00:00:00.000Z|has space').toString('base64url'), Buffer.from(`2026-10-01T00:00:00.000Z|${'a'.repeat(80)}`).toString('base64url')]) {
      expect(decodeSupportCursor(bad), bad).toBeNull();
    }
  });
});

/** MMG stamps creationDate as Guyana wall-clock time written with a "Z" (UAT, 1 Oct). */
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
const opened = new Date('2026-10-01T19:38:19.000Z');
const intent = {
  merchantTransactionId: '175933829900012345', amount: new Prisma.Decimal(500), currencyCode: 'GYD',
  createdAt: opened, expiresAt: new Date(opened.getTime() + 30 * 60_000), status: 'CONFIRMING' as const,
};
/** MMG's lookup: its creationDate is the lookup's own moment (MMG, 7 Oct), here a week later. */
const looked = lookupDetailFrom({
  transactionStatus: 'successful', amount: '500', currency: 'GYD', creationDate: '2026-10-08T10:00:00.000Z', transactionReference: '20402048601581',
  creditParty: [{ key: 'accountid', value: '0000000' }],
}, '20402048536279');
/** [7 Oct] MMG's history record of the payment (UAT shape), made at `paid`. */
const recordAt = (paid: unknown, patch: Record<string, unknown> = {}) => ({
  amount: '500', currency: 'GYD', displayType: 'EMerchant Payment', transactionStatus: 'completed', descriptionText: '',
  modificationDate: paid, transactionReference: '20402048536279', transactionReceipt: '20402048536279',
  debitParty: [{ key: 'accountid', value: '6000002' }, { key: 'accountcategory', value: 'P-CAT' }],
  creditParty: [{ key: 'accountid', value: 'P-CREDIT' }, { key: 'accountcategory', value: 'P-CAT' }], external_id: 'P-EXTERNAL', ...patch,
});
const naming = (...rows: Record<string, unknown>[]): PaymentHistory => ({ outcome: 'rows', naming: rows, truncated: false });

describe('the window support sees is the window judge() decides with', () => {
  const success = { txnId: '20402048536279' };
  const GY = 'GUYANA_WALL_CLOCK' as const;
  const at = (ms: number) => new Date(ms);
  const replied = at(opened.getTime() + 60_000);
  const lastCountingReply = at(intent.expiresAt.getTime() + 2 * 60_000);
  type Window = NonNullable<ReturnType<typeof windowCheckOf>>;
  /** [name, MMG's history for it, the first reply naming the transaction, the window support shows, judge()'s verdict or hold reason] */
  const cases: Array<[string, PaymentHistory | null, Date | null, Window, string]> = [
    ['three minutes before it opened', naming(recordAt(gyStamp(at(opened.getTime() - 3 * 60_000)))), replied, 'OUTSIDE', 'PAYMENT_TIME_OUTSIDE_WINDOW'],
    ['one minute before it opened (inside the tolerance)', naming(recordAt(gyStamp(at(opened.getTime() - 60_000)))), replied, 'INSIDE', 'CONFIRM'],
    ['a minute after it opened, as the reply came', naming(recordAt(gyStamp(replied))), replied, 'INSIDE', 'CONFIRM'],
    // [Sol, DS663] The after-reply bound decides first, exactly as judge() does: two minutes, no more.
    ['exactly two minutes after the first reply', naming(recordAt(gyStamp(at(replied.getTime() + 2 * 60_000)))), replied, 'INSIDE', 'CONFIRM'],
    ['two minutes and one millisecond after the first reply, inside the window', naming(recordAt(gyStamp(at(replied.getTime() + 2 * 60_000 + 1)))), replied, 'AFTER_REPLY', 'PAYMENT_TIME_AFTER_REPLY'],
    ['inside the window, half an hour after the first reply', naming(recordAt(gyStamp(at(intent.expiresAt.getTime() - 60_000)))), replied, 'AFTER_REPLY', 'PAYMENT_TIME_AFTER_REPLY'],
    ['one minute after it closed, the reply as late as one still counts', naming(recordAt(gyStamp(at(intent.expiresAt.getTime() + 60_000)))), lastCountingReply, 'INSIDE', 'CONFIRM'],
    ['three minutes after it closed, the reply as late as one still counts', naming(recordAt(gyStamp(at(intent.expiresAt.getTime() + 3 * 60_000)))), lastCountingReply, 'OUTSIDE', 'PAYMENT_TIME_OUTSIDE_WINDOW'],
    // Hours out: MMG's times do not match the zone.
    ['a UTC time read as Guyana time, four hours late', naming(recordAt(replied.toISOString())), replied, 'AFTER_REPLY', 'PAYMENT_TIME_AFTER_REPLY'],
    ['no reply ever named the transaction', naming(recordAt(gyStamp(replied))), null, 'AFTER_REPLY', 'PAYMENT_TIME_AFTER_REPLY'],
    ['an unreadable time', naming(recordAt('1 Oct 2026')), replied, 'UNREADABLE', 'PAYMENT_TIME_UNREADABLE'],
    ['no time', naming(recordAt(undefined)), replied, 'UNREADABLE', 'PAYMENT_TIME_UNREADABLE'],
    // [7 Oct] What MMG's history says, or cannot say.
    ['history has no record of it', naming(), replied, 'NOT_IN_HISTORY', 'PAYMENT_TIME_NOT_IN_HISTORY'],
    ['two history records of it', naming(recordAt(gyStamp(replied)), recordAt(gyStamp(replied))), replied, 'AMBIGUOUS', 'PAYMENT_TIME_AMBIGUOUS'],
    ['a history record for another amount', naming(recordAt(gyStamp(replied), { amount: '501' })), replied, 'DISAGREES', 'PAYMENT_TIME_DISAGREES'],
    ['a history record that is not "completed"', naming(recordAt(gyStamp(replied), { transactionStatus: 'successful' })), replied, 'DISAGREES', 'PAYMENT_TIME_DISAGREES'],
    ['history could not be read', { outcome: 'error' }, replied, 'UNAVAILABLE', 'PAYMENT_TIME_UNAVAILABLE'],
    ['history cut short at the row limit', { outcome: 'rows', naming: [recordAt(gyStamp(replied))], truncated: true }, replied, 'UNAVAILABLE', 'PAYMENT_TIME_UNAVAILABLE'],
    ['history never asked', null, replied, 'UNAVAILABLE', 'PAYMENT_TIME_UNAVAILABLE'],
  ];
  it.each(cases)('%s', (_name, history, firstReplyAt, window, decided) => {
    const verdict = judge(intent, '20402048536279', looked, ['0000000'], [], success, { zone: GY, firstReplyAt, history });
    expect(verdict.verdict === 'CONFIRM' ? 'CONFIRM' : verdict.verdict === 'HOLD' ? verdict.reason : verdict.verdict).toBe(decided);
    expect(windowCheckOf(intent, '20402048536279', { zone: GY, firstReplyAt, history })).toBe(window);
    // Support says INSIDE exactly when MMG's time lets the payment be credited.
    expect(window === 'INSIDE').toBe(decided === 'CONFIRM');
  });

  it('read in the zone the server is configured with; with none, support cannot read it either', () => {
    const inTime = at(opened.getTime() + 60_000);
    expect(windowCheckOf(intent, '20402048536279', { zone: 'UTC', firstReplyAt: inTime, history: naming(recordAt(inTime.toISOString())) })).toBe('INSIDE');
    expect(windowCheckOf(intent, '20402048536279', { zone: 'UTC', firstReplyAt: inTime, history: naming(recordAt(gyStamp(inTime))) })).toBe('OUTSIDE');
    expect(windowCheckOf(intent, '20402048536279', { zone: 'UTC', firstReplyAt: inTime, history: naming(recordAt('2026-10-01T15:39:19.000-04:00')) })).toBe('INSIDE');
    // Even a time with an explicit offset: judge() verifies nothing without a configured zone, so support claims nothing.
    for (const stamp of [gyStamp(inTime), inTime.toISOString(), '2026-10-01T15:39:19.000-04:00']) {
      expect(windowCheckOf(intent, '20402048536279', { zone: null, firstReplyAt: inTime, history: naming(recordAt(stamp)) })).toBe('UNREADABLE');
    }
    // judge() holds every payment then (CREATION_ZONE_UNVERIFIED).
    expect(judge(intent, '20402048536279', looked, ['0000000'], [], success, { zone: null, firstReplyAt: inTime, history: naming(recordAt(gyStamp(inTime))) }))
      .toMatchObject({ verdict: 'HOLD', reason: 'CREATION_ZONE_UNVERIFIED' });
  });
});

describe('a timeline entry says only what the allowlist names', () => {
  const at = new Date(opened.getTime() + 60_000);
  const GY = { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: at } as const;
  it('a reply: its ResultCode, the transaction it named, whether it came in time — never its message or HTML', () => {
    const entry = timelineEntryOf(intent, {
      source: 'RETURN', detail: 'MMG_RESULT_0', failure: null, createdAt: at,
      body: { merchantTransactionId: intent.merchantTransactionId, transactionId: '20402048536279', ResultCode: '0', ResultMessage: 'Transaction Successful', htmlResponse: '<html><body><h1>Transaction Successful</h1></body></html>', token: '[redacted]' },
    }, GY);
    expect(Object.keys(entry).sort()).toEqual([...MMG_CHECKOUT_TIMELINE_KEYS].sort());
    expect(entry).toMatchObject({ source: 'RETURN', resultCode: '0', mmgTransactionId: '20402048536279', windowCheck: 'INSIDE', transactionStatus: null, amount: null });
    expect(JSON.stringify(entry)).not.toMatch(/Successful|html|redacted|token/i);
  });

  it('a lookup: MMG status, amount, currency and ledger number; no window, since its creationDate is the lookup’s own moment (MMG, 7 Oct)', () => {
    const entry = timelineEntryOf(intent, {
      source: 'LOOKUP', detail: '20402048536279', failure: null, createdAt: at,
      body: { transactionStatus: 'successful', amount: '500', currency: 'GYD', creationDate: gyStamp(at), transactionReference: '20402048601581', subType: 'subscriber_mpay', debitParty: [{ key: 'accountid', value: '6000002' }] },
    }, GY);
    expect(entry).toMatchObject({
      source: 'LOOKUP', transactionStatus: 'successful', amount: '500', currency: 'GYD',
      mmgTransactionId: '20402048536279', mmgTransactionReference: '20402048601581', windowCheck: null, resultCode: null,
    });
    expect(JSON.stringify(entry)).not.toContain('6000002');
  });

  it('[7 Oct] a history answer: the record’s status, amount and currency, and where its time stands, by the check that credits; never the parties, the description or external_id', () => {
    const stored = { query: { fromdate: 'x', todate: 'y', rows: 100 }, rowsReturned: 2, truncated: false, naming: [recordAt(gyStamp(at))] };
    const entry = timelineEntryOf(intent, { source: 'HISTORY', detail: '20402048536279', failure: null, createdAt: at, body: stored }, GY);
    expect(Object.keys(entry).sort()).toEqual([...MMG_CHECKOUT_TIMELINE_KEYS].sort());
    expect(entry).toEqual({
      at: at.toISOString(), source: 'HISTORY', resultCode: null, transactionStatus: 'completed', mmgTransactionId: '20402048536279',
      mmgTransactionReference: null, amount: '500', currency: 'GYD', windowCheck: 'INSIDE', failure: null,
    });
    expect(JSON.stringify(entry)).not.toMatch(/6000002|P-CREDIT|P-CAT|P-EXTERNAL|EMerchant/);
  });

  it('[Sol, DS663 · 7 Oct] a history record whose time is more than two minutes after the first reply naming it shows AFTER_REPLY, as judge() holds it', () => {
    const entry = timelineEntryOf(intent, {
      source: 'HISTORY', detail: '20402048536279', failure: null, createdAt: at,
      body: { truncated: false, naming: [recordAt(gyStamp(new Date(at.getTime() + 2 * 60_000 + 1)))] },
    }, GY);
    expect(entry.windowCheck).toBe('AFTER_REPLY');
  });

  it('[7 Oct] a history answer with no record, two records, or none readable says so, and shows no record’s values', () => {
    const entryOf = (failure: string | null, body: unknown) => timelineEntryOf(intent, { source: 'HISTORY', detail: '20402048536279', failure, createdAt: at, body }, GY);
    expect(entryOf('HISTORY_NOT_FOUND', { truncated: false, naming: [] })).toMatchObject({ windowCheck: 'NOT_IN_HISTORY', failure: 'HISTORY_NOT_FOUND', transactionStatus: null, amount: null });
    expect(entryOf(null, { truncated: false, naming: [recordAt(gyStamp(at)), recordAt(gyStamp(at))] })).toMatchObject({ windowCheck: 'AMBIGUOUS', transactionStatus: null, amount: null, currency: null });
    expect(entryOf('HISTORY_FAILED', { query: {}, error: 'MMG history HTTP 503' })).toMatchObject({ windowCheck: 'UNAVAILABLE', failure: 'HISTORY_FAILED', amount: null });
    expect(entryOf(null, { truncated: 'no', naming: [recordAt(gyStamp(at))] })).toMatchObject({ windowCheck: 'UNAVAILABLE', amount: null });
    // An answer about no readable transaction claims no window.
    expect(timelineEntryOf(intent, { source: 'HISTORY', detail: 'not an id!', failure: null, createdAt: at, body: { truncated: false, naming: [recordAt(gyStamp(at))] } }, GY))
      .toMatchObject({ mmgTransactionId: null, windowCheck: null });
  });

  it('a lookup MMG could not answer carries its failure and nothing invented', () => {
    const entry = timelineEntryOf(intent, { source: 'LOOKUP', detail: '20402048536279', failure: 'LOOKUP_NOT_FOUND', createdAt: at, body: null }, GY);
    expect(entry).toMatchObject({ failure: 'LOOKUP_NOT_FOUND', transactionStatus: null, amount: null, currency: null, windowCheck: null, mmgTransactionReference: null });
  });

  it('a value that is not shaped like what it claims to be is dropped, not shown', () => {
    const entry = timelineEntryOf(intent, {
      source: 'LOOKUP', detail: 'not an id!', failure: null, createdAt: at,
      body: { transactionStatus: 'x'.repeat(200), amount: { nested: true }, currency: 'GYDX', transactionReference: 'has space' },
    }, GY);
    expect(entry).toMatchObject({ mmgTransactionId: null, transactionStatus: null, amount: null, currency: null, mmgTransactionReference: null });
  });
});

describe("MMG's transaction id reaches the partner only once CONFIRMED", () => {
  const base = { merchantTransactionId: '175933829900012345', mmgTransactionId: '20402048536279' };
  it.each(['OPEN', 'CONFIRMING', 'NOT_PAID', 'EXPIRED', 'HELD'])('%s: the Swift reference, never an MMG id', (status) => {
    expect(partnerReceiptIds({ ...base, status })).toEqual({ swiftReference: base.merchantTransactionId, mmgTransactionId: null });
  });
  it('CONFIRMED: both', () => {
    expect(partnerReceiptIds({ ...base, status: 'CONFIRMED' })).toEqual({ swiftReference: base.merchantTransactionId, mmgTransactionId: '20402048536279' });
  });
});
