import { describe, it, expect } from 'vitest';
import {
  remedyFor, attachable, ageOf, outcomeOf, formatSan,
  contactProblem, railHealth, gyd, REMEDY_COPY,
  type UnmatchedPayment, type CashKpis,
} from './cashRail';

// ---------------------------------------------------------------------------
// [SAN spec Part 4] The agent-cash rail.
//
// A partner pays their weekly fee in CASH at an MMG agent, quoting their SAN.
// Money that cannot be resolved is recorded as UNMATCHED — never rejected,
// because rejecting it would mean a partner paid and Swift holds no record of
// the money at all.
//
// Every row in that queue is a person who paid and is being treated as unpaid.
// It had no screen: nothing could be attached, and the queue could only grow.
// ---------------------------------------------------------------------------

const ROW = (over: Partial<UnmatchedPayment> = {}): UnmatchedPayment => ({
  id: 'p1',
  channel: 'MMG_AGENT_WEBHOOK',
  sanRaw: '80123456',
  amount: 2500,
  currencyCode: 'GYD',
  paidAt: '2026-09-04T09:00:00.000Z',
  createdAt: '2026-09-04T09:00:00.000Z',
  mmgTxnId: 'MMG-1',
  agentRef: 'AG-7',
  payerMsisdn: '+5926005555',
  failureCode: 'SAN_UNKNOWN',
  diagnosis: 'valid checksum but nobody holds it (mis-key that beat the odds)',
  hoursOld: 2,
  breachesSla: false,
  ...over,
});

describe('what to DO with money that reached nobody', () => {
  it('a valid SAN nobody holds is attachable — somebody meant to pay', () => {
    expect(remedyFor(ROW({ failureCode: 'SAN_UNKNOWN' }))).toBe('attach');
    expect(attachable(ROW({ failureCode: 'SAN_UNKNOWN' }))).toBe(true);
  });

  it('a failed checksum is NOT attachable — it cannot belong to anyone', () => {
    // "Plausible" is not a standard for moving money. Attaching a
    // failed-checksum payment to whichever account looks close credits the
    // wrong partner, leaves the right one unpaid, and leaves an audit trail
    // saying an admin did it deliberately.
    for (const code of ['SAN_CHECKSUM_FAILED', 'SAN_MALFORMED'] as const) {
      expect(remedyFor(ROW({ failureCode: code })), code).toBe('refund');
      expect(attachable(ROW({ failureCode: code })), code).toBe(false);
    }
  });

  it('a closed account is refunded, never credited', () => {
    for (const code of ['TOMBSTONED', 'ACCOUNT_CLOSED'] as const) {
      expect(remedyFor(ROW({ failureCode: code })), code).toBe('refund');
      expect(attachable(ROW({ failureCode: code })), code).toBe(false);
    }
  });

  it('an unrecognised code is investigated, not guessed', () => {
    expect(remedyFor(ROW({ failureCode: 'SOMETHING_NEW' }))).toBe('investigate');
    expect(remedyFor(ROW({ failureCode: null }))).toBe('investigate');
    expect(attachable(ROW({ failureCode: null }))).toBe(false);
  });

  it('decides from the CODE, never the prose', () => {
    // The diagnosis is written for a human and will be reworded. A remedy that
    // reads it would silently reroute money the day someone improves a
    // sentence — so a row whose prose says "typo" and whose code says
    // SAN_UNKNOWN is still attachable.
    const misleading = ROW({ failureCode: 'SAN_UNKNOWN', diagnosis: 'typo at the counter — cannot belong to anyone' });
    expect(remedyFor(misleading)).toBe('attach');
    const other = ROW({ failureCode: 'SAN_CHECKSUM_FAILED', diagnosis: 'nobody holds it' });
    expect(remedyFor(other)).toBe('refund');
  });

  it('every remedy says what to do, not what happened', () => {
    for (const [k, copy] of Object.entries(REMEDY_COPY)) {
      expect(copy.length, k).toBeGreaterThan(30);
    }
  });
});

describe('a 202 is not a failure', () => {
  it('reads APPROVAL_REQUIRED as queued, and keeps the approval id', () => {
    // Attaching, refund-flagging, importing and confirming a deposit are all
    // C4 — a second admin decides them. Rendering the 202 as an error makes
    // the operator retry, and each retry queues ANOTHER approval, so a
    // colleague arrives to a queue of duplicates for one payment.
    const o = outcomeOf(202, {
      success: false,
      error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'ap1' } },
    });
    expect(o.kind).toBe('queued');
    expect(o.approvalId).toBe('ap1');
    expect(o.message).toMatch(/nothing has moved/i);
  });

  it('a real success is done, and a real error is an error', () => {
    expect(outcomeOf(200, { success: true, data: {} }).kind).toBe('done');
    const bad = outcomeOf(409, { success: false, error: { code: 'NOT_UNMATCHED', message: 'Already matched.' } });
    expect(bad.kind).toBe('error');
    expect(bad.message).toBe('Already matched.');
  });

  it('a 202 that is NOT an approval is not silently treated as queued', () => {
    // Only APPROVAL_REQUIRED means "a colleague will finish this". Any other
    // 202 is an accepted-but-unknown state, and calling it queued would tell
    // the operator a second admin is coming when nobody is.
    expect(outcomeOf(202, { success: true }).kind).toBe('done');
    expect(outcomeOf(202, { success: false, error: { code: 'SOMETHING_ELSE', message: 'x' } }).kind).toBe('error');
  });

  it('an error with no message still says something useful', () => {
    expect(outcomeOf(500, {}).message).toMatch(/HTTP 500/);
  });
});

describe('the queue reads at a glance', () => {
  it('ages a row against the server SLA, with a warning before it', () => {
    expect(ageOf(ROW({ hoursOld: 2, breachesSla: false }))).toBe('fresh');
    expect(ageOf(ROW({ hoursOld: 13, breachesSla: false }))).toBe('aging');
    expect(ageOf(ROW({ hoursOld: 30, breachesSla: true }))).toBe('breached');
  });

  it('trusts the server for the breach, not its own arithmetic', () => {
    // Two clocks disagreeing about an SLA is how a queue reports green while
    // the server pages someone.
    expect(ageOf(ROW({ hoursOld: 1, breachesSla: true }))).toBe('breached');
  });

  it('groups a SAN for reading without changing it', () => {
    expect(formatSan('80123456')).toBe('8012 3456');
    expect(formatSan('8012 3456')).toBe('8012 3456');
  });

  it('writes GYD the way Guyana writes it', () => {
    expect(gyd(2500)).toBe('$2,500');
  });
});

describe('collections', () => {
  it('a promise without a date is not a promise', () => {
    // It is a way to end a call. Nothing can check whether it was kept.
    expect(contactProblem('PROMISED', '')).toMatch(/date/i);
    expect(contactProblem('PROMISED', '2026-09-08')).toBeNull();
    expect(contactProblem('NO_ANSWER', '')).toBeNull();
    expect(contactProblem('', '')).toMatch(/what happened/i);
  });
});

describe('is the rail healthy', () => {
  const K = (over: Partial<CashKpis> = {}): CashKpis => ({
    windowDays: 30,
    channelMix: [],
    unmatched: { depth: 0, oldestHours: 0 },
    collections: { contacts: 0, promises: 0, promisesKept: 0, promiseKeptRate: null },
    subscriptionStates: [],
    ...over,
  });

  it('measures money that reached nobody, not money collected', () => {
    // Total collected rises while the rail rots. Unmatched depth is money
    // already paid that reached no account, and its age is how long someone
    // has been treated as unpaid despite paying.
    expect(railHealth(K()).state).toBe('ok');
    expect(railHealth(K({ unmatched: { depth: 3, oldestHours: 6 } })).state).toBe('watch');
    expect(railHealth(K({ unmatched: { depth: 1, oldestHours: 49 } })).state).toBe('bad');
  });

  it('says it in days once it has been more than one', () => {
    expect(railHealth(K({ unmatched: { depth: 1, oldestHours: 49 } })).line).toContain('2 days');
    expect(railHealth(K({ unmatched: { depth: 2, oldestHours: 6 } })).line).toContain('6h');
  });

  it('one payment is singular', () => {
    expect(railHealth(K({ unmatched: { depth: 1, oldestHours: 3 } })).line).toContain('1 payment reached');
  });
});

describe('how apiFetch actually delivers a 202', () => {
  it('reads the THROWN approval as queued, not as a failure', async () => {
    // apiFetch throws whenever the body carries success:false — which a 202
    // APPROVAL_REQUIRED does. So the queued case arrives as an Error, and a
    // page handling only the throw would show a money action as broken at the
    // exact moment it worked.
    const { outcomeOfThrown } = await import('./cashRail');
    const thrown = Object.assign(new Error('A second admin must approve this before it happens.'), {
      status: 202, code: 'APPROVAL_REQUIRED', details: { approvalId: 'ap9' },
    });
    const o = outcomeOfThrown(thrown);
    expect(o.kind).toBe('queued');
    expect(o.approvalId).toBe('ap9');
  });

  it('a genuine failure stays a failure, with the server\'s own words', async () => {
    const { outcomeOfThrown } = await import('./cashRail');
    const thrown = Object.assign(new Error('Already matched.'), { status: 409, code: 'NOT_UNMATCHED' });
    expect(outcomeOfThrown(thrown)).toEqual({ kind: 'error', message: 'Already matched.' });
  });

  it('a 202 with a DIFFERENT code is not treated as queued', async () => {
    const { outcomeOfThrown } = await import('./cashRail');
    const thrown = Object.assign(new Error('Accepted, pending something else.'), { status: 202, code: 'OTHER' });
    expect(outcomeOfThrown(thrown).kind).toBe('error');
  });
});
