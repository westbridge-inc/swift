/**
 * [E02 · refund rail 1/8] The MMG refund law, proved WITHOUT a database.
 *
 * The law is the one place that says how a store's MMG refund obligation may
 * move, how its money adds up and how long the store has. Nothing calls it yet;
 * refund rail 2 and 3 build the locked commands on it. So this suite pins it
 * before anything leans on it:
 *   1. every (state, event) pair, against a truth table written out here by
 *      hand, and the row each accepted move writes;
 *   2. the classifications the migration repeats in SQL (the send CHECK, the
 *      cap trigger) read back from the migration text, so the two cannot drift;
 *   3. the deadline: copied at creation, set once when missed, never moved by
 *      a later policy change;
 *   4. the money: Prisma.Decimal to the cent, the cap, the remainder, the exact
 *      send, and a fee that never enters the arithmetic;
 *   5. the policy: 72 h and 2 misses by default, clamped, fail-safe.
 *
 * The triggers themselves, on real PostgreSQL, are proved in
 * mmg-refund-rail-db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, MmgRefundKind, MmgRefundStatus } from '@prisma/client';
import {
  MMG_REFUND_CAPPED_STATUSES,
  MMG_REFUND_DEADLINE_HOURS,
  MMG_REFUND_DEADLINE_HOURS_KEY,
  MMG_REFUND_EVENTS,
  MMG_REFUND_EVIDENCED_STATUSES,
  MMG_REFUND_MISS_LIMIT,
  MMG_REFUND_MISS_LIMIT_KEY,
  MMG_REFUND_OPEN_STATUSES,
  MMG_REFUND_SEND_STATUSES,
  MMG_REFUND_STATUSES,
  assertMmgRefundAmount,
  assertWithinAttested,
  decideMmgRefundObligation,
  isMmgRefundEvidenced,
  mmgRefundCapped,
  mmgRefundCauseKey,
  mmgRefundDeadline,
  mmgRefundEdge,
  mmgRefundMissLimitReached,
  mmgRefundMissedOrders,
  mmgRefundOwed,
  mmgRefundPolicy,
  mmgRefundRemainder,
  mmgSubstituteRefund,
  openMmgRefundObligation,
  resolveMmgRefundPolicy,
  sendMatchesOwed,
  type MmgRefundCommand,
  type MmgRefundEvent,
  type MmgRefundObligationFacts,
  type MmgRefundPolicy,
} from '../modules/order/mmg-refund-law';

const D = (v: string) => new Prisma.Decimal(v);
const HOUR = 3_600_000;
const T0 = new Date('2026-09-25T10:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const POLICY: MmgRefundPolicy = { deadlineHours: 72, missLimit: 2 };

const MIGRATION = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260925000100_mmg_refund_rail/migration.sql'),
  'utf8',
);

function facts(status: MmgRefundStatus, over: Partial<MmgRefundObligationFacts> = {}): MmgRefundObligationFacts {
  const carries = status === 'SENT' || status === 'CONFIRMED' || status === 'DISPUTED' || status === 'SETTLED';
  return {
    id: 'ob-1',
    status,
    amount: D('1500.00'),
    deadlineHours: 72,
    dueAt: at(72),
    missedAt: null,
    sendId: carries ? 'send-1' : null,
    revision: 4,
    ...over,
  };
}

function command(event: MmgRefundEvent): MmgRefundCommand {
  switch (event) {
    case 'SEND': return { event, sendId: 'send-9' };
    case 'DEADLINE_PASSED': return { event };
    case 'CUSTOMER_RECEIVED': return { event, actorId: 'customer-1' };
    case 'CUSTOMER_NOT_RECEIVED': return { event, actorId: 'customer-1' };
    case 'SUPPORT_RECEIVED': return { event, actorId: 'admin-1', note: 'Customer statement shows the transfer' };
    case 'SUPPORT_NOT_RECEIVED': return { event, actorId: 'admin-1', note: 'No such transfer on the statement', policy: POLICY };
    case 'VOID': return { event, actorId: 'admin-1', note: 'Duplicate obligation, approved by two admins' };
  }
}

function refusal(fn: () => unknown): { statusCode?: number; code?: string } {
  try {
    fn();
  } catch (err) {
    return err as { statusCode?: number; code?: string };
  }
  throw new Error('expected a refusal');
}

// The plan's transitions, written out by hand — NOT derived from the law under test.
const TRUTH: Record<MmgRefundStatus, Partial<Record<MmgRefundEvent, MmgRefundStatus>>> = {
  OWED: { SEND: 'SENT', DEADLINE_PASSED: 'OWED', VOID: 'VOIDED' },
  SENT: { CUSTOMER_RECEIVED: 'CONFIRMED', CUSTOMER_NOT_RECEIVED: 'DISPUTED', VOID: 'VOIDED' },
  CONFIRMED: {},
  DISPUTED: { SUPPORT_RECEIVED: 'SETTLED', SUPPORT_NOT_RECEIVED: 'OWED', VOID: 'VOIDED' },
  SETTLED: {},
  VOIDED: {},
};

describe('[E02] the states and events are the schema, all of them', () => {
  it('the law classifies exactly the MmgRefundStatus enum — no state forgotten, none invented', () => {
    expect([...MMG_REFUND_STATUSES].sort()).toEqual(Object.values(MmgRefundStatus).sort());
    expect(Object.keys(TRUTH).sort()).toEqual([...MMG_REFUND_STATUSES].sort());
  });

  it('every event of the plan is an event of the law', () => {
    expect([...MMG_REFUND_EVENTS].sort()).toEqual(
      ['CUSTOMER_NOT_RECEIVED', 'CUSTOMER_RECEIVED', 'DEADLINE_PASSED', 'SEND', 'SUPPORT_NOT_RECEIVED', 'SUPPORT_RECEIVED', 'VOID'],
    );
  });

  it('the kinds are the plan’s four; RETURN is reserved, not built', () => {
    expect(Object.values(MmgRefundKind).sort()).toEqual(['CANCELLATION', 'LINE_REMOVED', 'SUBSTITUTE_CHEAPER', 'SUBSTITUTE_REJECTED']);
  });
});

describe('[E02] every (state, event) pair has exactly the plan’s answer', () => {
  const pairs = MMG_REFUND_STATUSES.flatMap((s) => MMG_REFUND_EVENTS.map((e) => [s, e] as const));

  it('covers all 42 pairs', () => {
    expect(pairs).toHaveLength(6 * 7);
  });

  it.each(pairs)('%s + %s', (from, event) => {
    const expected = TRUTH[from][event] ?? null;
    expect(mmgRefundEdge(from, event)).toBe(expected);

    // Past the deadline, so a DEADLINE_PASSED that is allowed actually moves.
    const now = at(80);
    if (event === 'DEADLINE_PASSED') {
      const decision = decideMmgRefundObligation(facts(from), command(event), now);
      if (expected === null) {
        expect(decision).toEqual({ kind: 'UNCHANGED' }); // the sweeper's question never throws
      } else {
        expect(decision).toMatchObject({ kind: 'MOVE', from, to: expected, expectedRevision: 4 });
      }
      return;
    }
    if (expected === null) {
      expect(refusal(() => decideMmgRefundObligation(facts(from), command(event), now)))
        .toMatchObject({ statusCode: 409, code: 'MMG_REFUND_TRANSITION_REFUSED' });
      return;
    }
    const decision = decideMmgRefundObligation(facts(from), command(event), now);
    expect(decision).toMatchObject({ kind: 'MOVE', from, to: expected, expectedRevision: 4 });
    if (decision.kind !== 'MOVE') throw new Error('unreachable');
    expect(decision.data.status).toBe(expected);
    expect(decision.data.revision).toBe(5); // every move advances the generation
  });

  it('the final states refuse everything: CONFIRMED, SETTLED and VOIDED never move again', () => {
    for (const final of ['CONFIRMED', 'SETTLED', 'VOIDED'] as const) {
      expect(MMG_REFUND_EVENTS.map((e) => mmgRefundEdge(final, e)).filter((to) => to !== null)).toEqual([]);
    }
  });
});

describe('[E02] the rows the accepted moves write', () => {
  it('SEND names the send and nothing else', () => {
    const d = decideMmgRefundObligation(facts('OWED'), { event: 'SEND', sendId: 'send-9' }, T0);
    expect(d).toEqual({ kind: 'MOVE', from: 'OWED', to: 'SENT', expectedRevision: 4, data: { sendId: 'send-9', status: 'SENT', revision: 5 } });
  });

  it('a late send keeps its miss: sending after the deadline does not erase that it was missed', () => {
    const d = decideMmgRefundObligation(facts('OWED', { missedAt: at(73) }), { event: 'SEND', sendId: 'send-9' }, at(90));
    if (d.kind !== 'MOVE') throw new Error('expected a move');
    expect('missedAt' in d.data).toBe(false);
  });

  it('the customer’s yes closes it as theirs; the customer’s no only disputes it', () => {
    const yes = decideMmgRefundObligation(facts('SENT'), { event: 'CUSTOMER_RECEIVED', actorId: 'customer-1' }, T0);
    expect(yes).toMatchObject({ to: 'CONFIRMED', data: { resolvedAt: T0, resolvedById: 'customer-1' } });
    const no = decideMmgRefundObligation(facts('SENT'), { event: 'CUSTOMER_NOT_RECEIVED', actorId: 'customer-1' }, T0);
    expect(no).toEqual({ kind: 'MOVE', from: 'SENT', to: 'DISPUTED', expectedRevision: 4, data: { status: 'DISPUTED', revision: 5 } });
  });

  it('support finding it arrived settles it, with who and why', () => {
    const d = decideMmgRefundObligation(facts('DISPUTED'), command('SUPPORT_RECEIVED'), T0);
    expect(d).toMatchObject({ to: 'SETTLED', data: { resolvedAt: T0, resolvedById: 'admin-1', resolutionNote: 'Customer statement shows the transfer' } });
  });

  it('support finding it did NOT arrive reopens it: send spent, a new deadline from TODAY’s policy, and it counts as a miss', () => {
    const today: MmgRefundPolicy = { deadlineHours: 48, missLimit: 2 };
    const d = decideMmgRefundObligation(
      facts('DISPUTED', { deadlineHours: 72, dueAt: at(72) }),
      { event: 'SUPPORT_NOT_RECEIVED', actorId: 'admin-1', note: 'No transfer', policy: today },
      at(100),
    );
    expect(d).toEqual({
      kind: 'MOVE', from: 'DISPUTED', to: 'OWED', expectedRevision: 4,
      data: { sendId: null, deadlineHours: 48, dueAt: at(148), missedAt: at(100), resolutionNote: 'No transfer', status: 'OWED', revision: 5 },
    });
  });

  it('a reopened obligation keeps an earlier miss, and countAsMiss:false adds none', () => {
    const earlier = decideMmgRefundObligation(
      facts('DISPUTED', { missedAt: at(73) }),
      { event: 'SUPPORT_NOT_RECEIVED', actorId: 'a', note: 'n', policy: POLICY },
      at(100),
    );
    expect(earlier).toMatchObject({ data: { missedAt: at(73) } });
    const spared = decideMmgRefundObligation(
      facts('DISPUTED'),
      { event: 'SUPPORT_NOT_RECEIVED', actorId: 'a', note: 'n', policy: POLICY, countAsMiss: false },
      at(100),
    );
    expect(spared).toMatchObject({ data: { missedAt: null } });
  });

  it('a void drops the send (the CHECK allows none on VOIDED) and records who and why', () => {
    for (const from of ['OWED', 'SENT', 'DISPUTED'] as const) {
      const d = decideMmgRefundObligation(facts(from), command('VOID'), T0);
      expect(d).toMatchObject({ to: 'VOIDED', data: { sendId: null, resolvedAt: T0, resolvedById: 'admin-1', resolutionNote: 'Duplicate obligation, approved by two admins' } });
    }
  });

  it('a refusal names where the obligation stands and the generation it was read at', () => {
    const err = refusal(() => decideMmgRefundObligation(facts('CONFIRMED'), command('VOID'), T0)) as { details?: unknown; message?: string };
    expect(err).toMatchObject({ details: { status: 'CONFIRMED', event: 'VOID', revision: 4 } });
    expect(err.message).toMatch(/confirmed received by the customer/);
  });
});

describe('[E02] the deadline: copied at creation, missed once, never moved by a later policy', () => {
  const input = {
    kind: 'CANCELLATION' as const, tenantId: 'swift-default', orderId: 'order-1', vendorId: 'vendor-1', customerId: 'customer-1',
    amount: D('1500.00'), currencyCode: 'GYD', basis: 'ATTESTED_REMAINDER', createdById: 'store-owner-1',
  };

  it('a new obligation is OWED, at generation 0, with the policy’s hours copied onto it', () => {
    const row = openMmgRefundObligation(input, POLICY, T0);
    expect(row).toMatchObject({
      status: 'OWED', revision: 0, deadlineHours: 72, dueAt: at(72), causeKey: 'order:order-1:cancel', orderItemId: null,
      tenantId: 'swift-default', vendorId: 'vendor-1', customerId: 'customer-1', basis: 'ATTESTED_REMAINDER', createdById: 'store-owner-1',
    });
    expect((row.amount as Prisma.Decimal).equals(D('1500'))).toBe(true);
  });

  it('a policy changed AFTER creation does not move the deadline: the obligation answers to its own dueAt', () => {
    const row = openMmgRefundObligation(input, POLICY, T0);
    const o = facts('OWED', { deadlineHours: row.deadlineHours, dueAt: row.dueAt as Date });
    // The operator shortens the policy to 24 h; 25 h later the obligation is still inside ITS 72 h.
    expect(mmgRefundDeadline({ deadlineHours: 24, missLimit: 2 }, T0).dueAt).toEqual(at(24));
    expect(decideMmgRefundObligation(o, { event: 'DEADLINE_PASSED' }, at(25))).toEqual({ kind: 'UNCHANGED' });
    expect(decideMmgRefundObligation(o, { event: 'DEADLINE_PASSED' }, at(71.99))).toEqual({ kind: 'UNCHANGED' });
    expect(decideMmgRefundObligation(o, { event: 'DEADLINE_PASSED' }, at(72))).toMatchObject({ kind: 'MOVE', to: 'OWED', data: { missedAt: at(72) } });
  });

  it('a miss is recorded once: a second sweep past the deadline changes nothing', () => {
    const missed = facts('OWED', { missedAt: at(72) });
    expect(decideMmgRefundObligation(missed, { event: 'DEADLINE_PASSED' }, at(200))).toEqual({ kind: 'UNCHANGED' });
  });

  it('the clock runs only on what is owed: a sent, disputed or closed obligation is never marked late', () => {
    for (const s of ['SENT', 'CONFIRMED', 'DISPUTED', 'SETTLED', 'VOIDED'] as const) {
      expect(decideMmgRefundObligation(facts(s), { event: 'DEADLINE_PASSED' }, at(500))).toEqual({ kind: 'UNCHANGED' });
    }
  });

  it('one cause, one key — and the two ways a line comes off are ONE cause', () => {
    expect(mmgRefundCauseKey('CANCELLATION', 'order-1')).toBe('order:order-1:cancel');
    expect(mmgRefundCauseKey('LINE_REMOVED', 'line-7')).toBe('line:line-7:close');
    expect(mmgRefundCauseKey('SUBSTITUTE_REJECTED', 'line-7')).toBe(mmgRefundCauseKey('LINE_REMOVED', 'line-7'));
    expect(mmgRefundCauseKey('SUBSTITUTE_CHEAPER', 'line-7')).toBe('line:line-7:cheaper');
    expect(() => mmgRefundCauseKey('LINE_REMOVED', '')).toThrow();
    const line = openMmgRefundObligation({ ...input, kind: 'LINE_REMOVED', orderItemId: 'line-7', basis: 'SNAPSHOT' }, POLICY, T0);
    expect(line).toMatchObject({ causeKey: 'line:line-7:close', orderItemId: 'line-7' });
    expect(refusal(() => openMmgRefundObligation({ ...input, kind: 'LINE_REMOVED' }, POLICY, T0)))
      .toMatchObject({ statusCode: 400, code: 'MMG_REFUND_LINE_REQUIRED' });
  });
});

describe('[E02] the SQL says what the law says (read from the migration itself)', () => {
  it('the send CHECK names exactly the states the law says carry a send', () => {
    const check = /chk_mmg_refund_obligations_send_shape"\s+CHECK \(\("sendId" IS NOT NULL\) = \("status" IN \(([^)]*)\)\)\)/.exec(MIGRATION);
    expect(check, 'the CHECK is in the migration').not.toBeNull();
    const listed = check![1]!.split(',').map((s) => s.trim().replace(/'/g, '')).sort();
    expect(listed).toEqual([...MMG_REFUND_SEND_STATUSES].sort());
  });

  it('the cap trigger counts every state but VOIDED, as the law does', () => {
    expect(MIGRATION).toMatch(/WHERE r\."orderId" = order_id AND r\."status" <> 'VOIDED';/);
    expect([...MMG_REFUND_CAPPED_STATUSES].sort()).toEqual(MMG_REFUND_STATUSES.filter((s) => s !== 'VOIDED').sort());
  });

  it('the open states are the voidable ones, and only CONFIRMED and SETTLED may ever read "refunded"', () => {
    expect([...MMG_REFUND_OPEN_STATUSES].sort()).toEqual(MMG_REFUND_STATUSES.filter((s) => mmgRefundEdge(s, 'VOID') !== null).sort());
    expect([...MMG_REFUND_EVIDENCED_STATUSES].sort()).toEqual(['CONFIRMED', 'SETTLED']);
    expect(isMmgRefundEvidenced('SENT')).toBe(false);
    expect(isMmgRefundEvidenced('CONFIRMED')).toBe(true);
  });
});

describe('[E02] the money is Prisma.Decimal, to the cent', () => {
  const ob = (status: MmgRefundStatus, amount: string) => ({ status, amount: D(amount) });

  it('cents add exactly: 0.10 + 0.20 owed against 0.30 attested fits, and one cent more does not', () => {
    // As JS numbers this is 0.30000000000000004 > 0.3 — the float refusal this law must never make.
    const held = [ob('OWED', '0.10'), ob('SENT', '0.20')];
    expect(mmgRefundCapped(held).equals(D('0.30'))).toBe(true);
    expect(() => assertWithinAttested(D('0.60'), held, D('0.30'))).not.toThrow();
    expect(refusal(() => assertWithinAttested(D('0.60'), held, D('0.31'))))
      .toMatchObject({ statusCode: 409, code: 'MMG_REFUND_OVER_ATTESTED' });
    expect(mmgRefundRemainder(D('0.30'), held).isZero()).toBe(true);
  });

  it('the cap: exactly the attested amount fits, a cent over is refused, a voided obligation frees its share', () => {
    const held = [ob('OWED', '1000.00'), ob('VOIDED', '499.99')];
    expect(() => assertWithinAttested(D('1500.00'), held, D('500.00'))).not.toThrow();
    expect(refusal(() => assertWithinAttested(D('1500.00'), held, D('500.01')))).toMatchObject({ code: 'MMG_REFUND_OVER_ATTESTED' });
  });

  it('with nothing attested, nothing is refundable on this rail', () => {
    expect(refusal(() => assertWithinAttested(null, [], D('1.00')))).toMatchObject({ statusCode: 409, code: 'MMG_PAYMENT_NOT_ATTESTED' });
    expect(mmgRefundRemainder(null, []).isZero()).toBe(true);
  });

  it('a cancellation owes the attested remainder: attested less everything already held, never below zero', () => {
    const held = [ob('OWED', '300.00'), ob('CONFIRMED', '200.00'), ob('VOIDED', '999.00')];
    expect(mmgRefundRemainder(D('2300.00'), held).equals(D('1800.00'))).toBe(true);
    expect(mmgRefundRemainder(D('100.00'), held).isZero()).toBe(true);
  });

  it('a send must state exactly the OWED total it covers — a figure net of the MMG fee is not that figure', () => {
    const owedRows = [ob('OWED', '1200.00'), ob('OWED', '300.50'), ob('SENT', '999.00'), ob('VOIDED', '5.00')];
    expect(mmgRefundOwed(owedRows).equals(D('1500.50'))).toBe(true);
    expect(sendMatchesOwed(D('1500.5'), owedRows)).toBe(true);
    expect(sendMatchesOwed(D('1450.50'), owedRows)).toBe(false); // 1500.50 less a 50.00 fee: refused
    expect(sendMatchesOwed(D('1500.51'), owedRows)).toBe(false);
    expect(sendMatchesOwed(D('0'), [ob('SENT', '10.00')])).toBe(false); // nothing owed: nothing to send
  });

  it('an amount the rail can record is a Decimal above zero, to the cent, that fits the column', () => {
    expect(assertMmgRefundAmount(D('0.01')).equals(D('0.01'))).toBe(true);
    expect(assertMmgRefundAmount(D('9999999999.99')).toFixed(2)).toBe('9999999999.99');
    for (const bad of [D('0'), D('-1.00'), D('10.005'), D('10000000000.00'), D('NaN'), D('Infinity')]) {
      expect(refusal(() => assertMmgRefundAmount(bad)), bad.toString()).toMatchObject({ statusCode: 400, code: 'MMG_REFUND_AMOUNT_INVALID' });
    }
    // A JS number is not money here: refused rather than coerced.
    expect(refusal(() => assertMmgRefundAmount(1500 as never))).toMatchObject({ code: 'MMG_REFUND_AMOUNT_INVALID' });
  });

  it('a substitute: the same price owes nothing, a cheaper one owes the difference, a dearer one is named as such', () => {
    expect(mmgSubstituteRefund(D('850.00'), D('850'))).toEqual({ kind: 'SAME_PRICE' });
    const cheaper = mmgSubstituteRefund(D('850.00'), D('620.50'));
    expect(cheaper.kind).toBe('CHEAPER');
    expect(cheaper.kind === 'CHEAPER' && cheaper.refund.equals(D('229.50'))).toBe(true);
    const dearer = mmgSubstituteRefund(D('850.00'), D('900.00'));
    expect(dearer.kind === 'DEARER' && dearer.extra.equals(D('50'))).toBe(true);
  });
});

describe('[E02] misses are counted per order, after the last clear (owner decision (c))', () => {
  const miss = (orderId: string, hours: number | null) => ({ orderId, missedAt: hours === null ? null : at(hours) });

  it('two obligations missed on one order are ONE miss; an unmissed one is none', () => {
    expect(mmgRefundMissedOrders([miss('o1', 73), miss('o1', 74), miss('o2', null)], null)).toBe(1);
  });

  it('only misses strictly after the clear count', () => {
    const rows = [miss('o1', 10), miss('o2', 20), miss('o3', 30)];
    expect(mmgRefundMissedOrders(rows, null)).toBe(3);
    expect(mmgRefundMissedOrders(rows, at(20))).toBe(1);
  });

  it('the checkout holds at exactly the limit: 1 of 2 does not, 2 of 2 does', () => {
    expect(mmgRefundMissLimitReached(1, POLICY)).toBe(false);
    expect(mmgRefundMissLimitReached(2, POLICY)).toBe(true);
    expect(mmgRefundMissLimitReached(2, { ...POLICY, missLimit: 3 })).toBe(false);
  });
});

describe('[E02] the policy: 72 h and 2 misses, clamped, fail-safe', () => {
  const rows = (deadline: unknown, misses?: unknown) => [
    { key: MMG_REFUND_DEADLINE_HOURS_KEY, value: deadline },
    ...(misses === undefined ? [] : [{ key: MMG_REFUND_MISS_LIMIT_KEY, value: misses }]),
  ];

  it('no config: the owner’s defaults', () => {
    expect(resolveMmgRefundPolicy([])).toEqual({ policy: { deadlineHours: 72, missLimit: 2 }, notes: [] });
    expect(MMG_REFUND_DEADLINE_HOURS).toEqual({ fallback: 72, min: 24, max: 168 });
    expect(MMG_REFUND_MISS_LIMIT).toEqual({ fallback: 2, min: 1, max: 5 });
  });

  it('inside the range the operator’s value stands, bounds included', () => {
    expect(resolveMmgRefundPolicy(rows(24, 1)).policy).toEqual({ deadlineHours: 24, missLimit: 1 });
    expect(resolveMmgRefundPolicy(rows(168, 5)).policy).toEqual({ deadlineHours: 168, missLimit: 5 });
    expect(resolveMmgRefundPolicy(rows('96', '3')).policy).toEqual({ deadlineHours: 96, missLimit: 3 });
  });

  it('outside the range it is CLAMPED to the nearest bound, and says so', () => {
    const low = resolveMmgRefundPolicy(rows(12, 0));
    expect(low.policy).toEqual({ deadlineHours: 24, missLimit: 1 });
    expect(low.notes).toHaveLength(2);
    expect(resolveMmgRefundPolicy(rows(1000, 9)).policy).toEqual({ deadlineHours: 168, missLimit: 5 });
    expect(resolveMmgRefundPolicy(rows(-5)).policy.deadlineHours).toBe(24);
  });

  it('a value that is not a whole number is not a policy: the default stands', () => {
    for (const junk of [72.5, null, true, [], {}, '', 'abc', '1e3', '72h']) {
      const r = resolveMmgRefundPolicy(rows(junk, junk));
      expect(r.policy, JSON.stringify(junk)).toEqual({ deadlineHours: 72, missLimit: 2 });
      expect(r.notes, JSON.stringify(junk)).toHaveLength(2);
    }
  });

  it('mmgRefundPolicy reads both keys in one query and applies the clamps', async () => {
    const findMany = vi.fn().mockResolvedValue(rows(200, 3));
    await expect(mmgRefundPolicy({ platformConfig: { findMany } } as never)).resolves.toEqual({ deadlineHours: 168, missLimit: 3 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { key: { in: [MMG_REFUND_DEADLINE_HOURS_KEY, MMG_REFUND_MISS_LIMIT_KEY] } } });
  });

  it('a config read that fails leaves the defaults, never an obligation without a deadline', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(mmgRefundPolicy({ platformConfig: { findMany } } as never)).resolves.toEqual({ deadlineHours: 72, missLimit: 2 });
  });
});
