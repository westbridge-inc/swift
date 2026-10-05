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
import { judge } from '../modules/billing/mmg-checkout.service';
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
const answerAt = (created: unknown) => lookupDetailFrom({
  transactionStatus: 'successful', amount: '500', currency: 'GYD', creationDate: created, transactionReference: '20402048601581',
  creditParty: [{ key: 'accountid', value: '0000000' }],
}, '20402048536279');

describe('the window support sees is the window judge() decides with', () => {
  const success = { txnId: '20402048536279' };
  const GY = 'GUYANA_WALL_CLOCK' as const;
  const at = (ms: number) => new Date(ms);
  const replied = at(opened.getTime() + 60_000);
  const lastCountingReply = at(intent.expiresAt.getTime() + 2 * 60_000);
  /** [name, MMG's creationDate, the first reply naming the transaction, the window support shows, judge()'s verdict or hold reason] */
  const cases: Array<[string, unknown, Date | null, 'INSIDE' | 'OUTSIDE' | 'AFTER_REPLY' | 'UNREADABLE', string]> = [
    ['three minutes before it opened', gyStamp(at(opened.getTime() - 3 * 60_000)), replied, 'OUTSIDE', 'OUTSIDE_CHECKOUT_WINDOW'],
    ['one minute before it opened (inside the tolerance)', gyStamp(at(opened.getTime() - 60_000)), replied, 'INSIDE', 'CONFIRM'],
    ['a minute after it opened, as the reply came', gyStamp(replied), replied, 'INSIDE', 'CONFIRM'],
    // [Sol, DS663] The after-reply bound decides first, exactly as judge() does: two minutes, no more.
    ['exactly two minutes after the first reply', gyStamp(at(replied.getTime() + 2 * 60_000)), replied, 'INSIDE', 'CONFIRM'],
    ['two minutes and one millisecond after the first reply, inside the window', gyStamp(at(replied.getTime() + 2 * 60_000 + 1)), replied, 'AFTER_REPLY', 'CREATION_AFTER_REPLY'],
    ['inside the window, half an hour after the first reply', gyStamp(at(intent.expiresAt.getTime() - 60_000)), replied, 'AFTER_REPLY', 'CREATION_AFTER_REPLY'],
    ['one minute after it closed, the reply as late as one still counts', gyStamp(at(intent.expiresAt.getTime() + 60_000)), lastCountingReply, 'INSIDE', 'CONFIRM'],
    ['three minutes after it closed, the reply as late as one still counts', gyStamp(at(intent.expiresAt.getTime() + 3 * 60_000)), lastCountingReply, 'OUTSIDE', 'OUTSIDE_CHECKOUT_WINDOW'],
    // Hours out: MMG's stamps do not match the zone.
    ['a UTC stamp read as Guyana time, four hours late', replied.toISOString(), replied, 'AFTER_REPLY', 'CREATION_AFTER_REPLY'],
    ['no reply ever named the transaction', gyStamp(replied), null, 'AFTER_REPLY', 'CREATION_AFTER_REPLY'],
    ['an unreadable stamp', '1 Oct 2026', replied, 'UNREADABLE', 'CREATION_DATE_UNREADABLE'],
    ['no stamp', undefined, replied, 'UNREADABLE', 'CREATION_DATE_UNREADABLE'],
  ];
  it.each(cases)('%s', (_name, created, firstReplyAt, window, decided) => {
    const detail = answerAt(created);
    const verdict = judge(intent, '20402048536279', detail, ['0000000'], [], success, { zone: GY, firstReplyAt });
    expect(verdict.verdict === 'CONFIRM' ? 'CONFIRM' : verdict.verdict === 'HOLD' ? verdict.reason : verdict.verdict).toBe(decided);
    expect(windowCheckOf(intent, detail.createdAt, { zone: GY, firstReplyAt })).toBe(window);
    // Support says INSIDE exactly when the creation time lets the payment be credited.
    expect(window === 'INSIDE').toBe(decided === 'CONFIRM');
  });

  it('read in the zone the server is configured with; with none, support cannot read it either', () => {
    const inTime = at(opened.getTime() + 60_000);
    expect(windowCheckOf(intent, inTime.toISOString(), { zone: 'UTC', firstReplyAt: inTime })).toBe('INSIDE');
    expect(windowCheckOf(intent, gyStamp(inTime), { zone: 'UTC', firstReplyAt: inTime })).toBe('OUTSIDE');
    expect(windowCheckOf(intent, '2026-10-01T15:39:19.000-04:00', { zone: 'UTC', firstReplyAt: inTime })).toBe('INSIDE');
    // Even a stamp with an explicit offset: judge() verifies nothing without a configured zone, so support claims nothing.
    for (const stamp of [gyStamp(inTime), inTime.toISOString(), '2026-10-01T15:39:19.000-04:00']) {
      expect(windowCheckOf(intent, stamp, { zone: null, firstReplyAt: inTime })).toBe('UNREADABLE');
    }
    // judge() holds every payment then (CREATION_ZONE_UNVERIFIED).
    expect(judge(intent, '20402048536279', answerAt(gyStamp(inTime)), ['0000000'], [], success, { zone: null, firstReplyAt: inTime }))
      .toMatchObject({ verdict: 'HOLD', reason: 'CREATION_ZONE_UNVERIFIED' });
  });
});

describe('a timeline entry says only what the allowlist names', () => {
  const at = new Date(opened.getTime() + 60_000);
  it('a reply: its ResultCode, the transaction it named, whether it came in time — never its message or HTML', () => {
    const entry = timelineEntryOf(intent, {
      source: 'RETURN', detail: 'MMG_RESULT_0', failure: null, createdAt: at,
      body: { merchantTransactionId: intent.merchantTransactionId, transactionId: '20402048536279', ResultCode: '0', ResultMessage: 'Transaction Successful', htmlResponse: '<html><body><h1>Transaction Successful</h1></body></html>', token: '[redacted]' },
    }, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: at });
    expect(Object.keys(entry).sort()).toEqual([...MMG_CHECKOUT_TIMELINE_KEYS].sort());
    expect(entry).toMatchObject({ source: 'RETURN', resultCode: '0', mmgTransactionId: '20402048536279', windowCheck: 'INSIDE', transactionStatus: null, amount: null });
    expect(JSON.stringify(entry)).not.toMatch(/Successful|html|redacted|token/i);
  });

  it('a lookup: MMG status, amount, currency, ledger number and the creation window', () => {
    const entry = timelineEntryOf(intent, {
      source: 'LOOKUP', detail: '20402048536279', failure: null, createdAt: at,
      body: { transactionStatus: 'successful', amount: '500', currency: 'GYD', creationDate: gyStamp(at), transactionReference: '20402048601581', subType: 'subscriber_mpay', debitParty: [{ key: 'accountid', value: '6000002' }] },
    }, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: at });
    expect(entry).toMatchObject({
      source: 'LOOKUP', transactionStatus: 'successful', amount: '500', currency: 'GYD',
      mmgTransactionId: '20402048536279', mmgTransactionReference: '20402048601581', windowCheck: 'INSIDE', resultCode: null,
    });
    expect(JSON.stringify(entry)).not.toContain('6000002');
  });

  it('[Sol, DS663] a lookup whose MMG time is more than two minutes after the first reply naming it shows AFTER_REPLY, as judge() holds it', () => {
    const entry = timelineEntryOf(intent, {
      source: 'LOOKUP', detail: '20402048536279', failure: null, createdAt: at,
      body: { transactionStatus: 'successful', amount: '500', currency: 'GYD', creationDate: gyStamp(new Date(at.getTime() + 2 * 60_000 + 1)), transactionReference: '20402048601581' },
    }, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: at });
    expect(entry.windowCheck).toBe('AFTER_REPLY');
  });

  it('a lookup MMG could not answer carries its failure and nothing invented', () => {
    const entry = timelineEntryOf(intent, { source: 'LOOKUP', detail: '20402048536279', failure: 'LOOKUP_NOT_FOUND', createdAt: at, body: null }, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: at });
    expect(entry).toMatchObject({ failure: 'LOOKUP_NOT_FOUND', transactionStatus: null, amount: null, currency: null, windowCheck: null, mmgTransactionReference: null });
  });

  it('a value that is not shaped like what it claims to be is dropped, not shown', () => {
    const entry = timelineEntryOf(intent, {
      source: 'LOOKUP', detail: 'not an id!', failure: null, createdAt: at,
      body: { transactionStatus: 'x'.repeat(200), amount: { nested: true }, currency: 'GYDX', transactionReference: 'has space' },
    }, { zone: 'GUYANA_WALL_CLOCK', firstReplyAt: at });
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
