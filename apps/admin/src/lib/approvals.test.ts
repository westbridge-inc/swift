import { describe, it, expect } from 'vitest';
import {
  blockedBecause, decidable, minutesLeft, urgencyOf, describeAction,
  entityLabel, shortFingerprint, noteProblem, BLOCK_COPY,
  canApply, awaitsRequester, snapshotEntries,
  type ApprovalRow,
} from './approvals';

// ---------------------------------------------------------------------------
// [ADM-005] The second signature.
//
// 44 admin routes — 22 money (C4) and 22 platform (C5) — return 202
// APPROVAL_REQUIRED and write a PENDING row instead of acting. A second capable
// admin has to decide it. The queue had NO SCREEN, so every one of those 44
// could be asked for and none could be completed: the control was real and the
// counter-signature was unreachable.
//
// These grade the rules the queue applies before it calls the server. Getting
// one wrong turns a control into a rubber stamp, which is worse than having no
// control at all — so each is stated as the thing it prevents.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-04T12:00:00.000Z');
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();

const ROW = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: 'a1',
  action: 'PUT /billing/agent-payments/:id/refund-flag',
  cls: 'C4',
  capability: 'billing.agent_payment.refund_flag',
  entityId: 'cmtmg7szp000uonk57ozokwjb',
  fingerprint: 'f'.repeat(64),
  status: 'PENDING',
  requestedBy: 'admin-1',
  reason: 'Agent deposited twice for the same batch; the duplicate needs flagging.',
  approvedBy: null,
  decisionNote: null,
  decidedAt: null,
  appliedAt: null,
  expiresAt: at(120),
  createdAt: at(-10),
  isOwnRequest: false,
  ...over,
});

describe('who may sign', () => {
  it('refuses your own request first, and says why it is the point', () => {
    // Checked BEFORE expiry and status: it is not a timing problem the person
    // can retry past, it is the entire reason the control exists. Telling them
    // "expired" when the real answer is "you asked for this" sends them to
    // re-request instead of finding a colleague.
    const own = ROW({ isOwnRequest: true, expiresAt: at(-5), status: 'APPROVED' });
    expect(blockedBecause(own, NOW)).toBe('own-request');
    expect(BLOCK_COPY['own-request']).toMatch(/second person/i);
  });

  it('refuses an expired window, and an already-decided row', () => {
    expect(blockedBecause(ROW({ expiresAt: at(-1) }), NOW)).toBe('expired');
    expect(blockedBecause(ROW({ status: 'APPROVED' }), NOW)).toBe('already-decided');
    expect(blockedBecause(ROW({ status: 'APPLIED' }), NOW)).toBe('already-decided');
  });

  it('lets a live request from someone else through', () => {
    expect(blockedBecause(ROW(), NOW)).toBeNull();
    expect(decidable(ROW(), NOW)).toBe(true);
  });

  it('an approval expiring exactly now is closed, not open', () => {
    // A boundary that rounds the wrong way signs something the server will
    // refuse — and leaves the operator believing it went through.
    expect(blockedBecause(ROW({ expiresAt: NOW.toISOString() }), NOW)).toBe('expired');
  });
});

describe('the clock', () => {
  it('counts down, and goes negative after the window closes', () => {
    expect(minutesLeft(ROW({ expiresAt: at(45) }), NOW)).toBe(45);
    expect(minutesLeft(ROW({ expiresAt: at(-12) }), NOW)).toBe(-12);
  });

  it('marks a closing window, because an expiry costs the requester the whole ask', () => {
    expect(urgencyOf(ROW({ expiresAt: at(20) }), NOW)).toBe('soon');
    expect(urgencyOf(ROW({ expiresAt: at(90) }), NOW)).toBe('ok');
    expect(urgencyOf(ROW({ expiresAt: at(-1) }), NOW)).toBe('expired');
  });
});

describe('what the approver is actually reading', () => {
  it('turns a route template into a sentence', () => {
    // The stored action is precise and unreadable. Someone signing a money
    // decision should not have to parse an HTTP method to learn whether they
    // are forgiving a fee or publishing a price.
    expect(describeAction('PUT /billing/agent-payments/:id/refund-flag'))
      .toBe('Change: Billing → Agent Payments → Refund Flag');
    expect(describeAction('POST /billing/settlement-batches/:id/confirm-deposit'))
      .toBe('Create or run: Billing → Settlement Batches → Confirm Deposit');
    expect(describeAction('DELETE /zones/:id')).toBe('Delete: Zones');
    expect(describeAction('PUT /countries/:code/pricing/:kind')).toBe('Change: Countries → Pricing');
  });

  it('never leaks a raw id into the sentence', () => {
    // Route params are stripped: an approver reading "Change: Billing → Agent
    // Payments → cmtm…" learns nothing and loses the verb.
    const sentence = describeAction('PUT /users/:id/suspend');
    expect(sentence).toBe('Change: Users → Suspend');
    // No route PARAM survives — the colon in "Change:" is the verb, not an id.
    expect(sentence.split(': ')[1]).not.toMatch(/:/);
  });

  it('shortens ids and the fingerprint without hiding that they exist', () => {
    expect(entityLabel(ROW())).toContain('…');
    expect(entityLabel(ROW({ entityId: 'short' }))).toBe('short');
    expect(entityLabel(ROW({ entityId: null }))).toBeNull();
    expect(shortFingerprint('f'.repeat(64))).toBe(`${'f'.repeat(16)}…`);
  });
});

describe('the decision note', () => {
  it('requires a reason to APPROVE too — deciding is itself a classified action', () => {
    // POST /approvals/:id/decide is C3, and C3 requires a stated reason
    // (ADM-006). An earlier draft treated the note as optional on approval and
    // every button would have failed at the wire with 400 — found by running
    // it against the real API, not by reading the route.
    //
    // It is also the right rule. "Approved" with nothing attached tells whoever
    // reads the record later that a second admin clicked, not that they agreed.
    expect(noteProblem('', true)).toMatch(/why you agree/i);
    expect(noteProblem('Checked batch 44 against the deposit slip.', true)).toBeNull();
  });

  it('requires a reason to REFUSE', () => {
    // The requester sees only this. "No" with nothing attached means they ask
    // again identically, and a second person burns a second review on it.
    expect(noteProblem('', false)).toMatch(/why/i);
    expect(noteProblem('  no  ', false)).toMatch(/why/i);
    expect(noteProblem('Duplicate — batch 44 already settled on the 2nd.', false)).toBeNull();
  });

  it('holds the server bound so the request is not rejected at the wire', () => {
    expect(noteProblem('x'.repeat(501), true)).toMatch(/500/);
    expect(noteProblem('x'.repeat(500), true)).toBeNull();
  });

  it('holds the 12-character floor too — a 5-character note passed the screen and 400’d at the gate', () => {
    expect(noteProblem('I agree.', true)).toMatch(/why/i);
    expect(noteProblem('I agree, checked against the statement.', true)).toBeNull();
  });
});

describe('[DS110-13] the stored body is what the approver reads and apply replays', () => {
  it('turns the stored body into labelled fields, leaving the reason to its own place', () => {
    const entries = snapshotEntries(ROW({
      bodySnapshot: { params: { id: 'pay_1' }, body: { amount: 2500, subscriptionId: 'SUB-77', reason: 'kept elsewhere' } },
    }));
    expect(entries).toEqual([
      { label: 'Amount', value: '2500' },
      { label: 'Subscription Id', value: 'SUB-77' },
    ]);
  });

  it('returns nothing for a legacy row with no stored body', () => {
    expect(snapshotEntries(ROW())).toEqual([]);
    expect(snapshotEntries(ROW({ bodySnapshot: null }))).toEqual([]);
  });

  it('apply is allowed exactly when a body is on record and the window is still open', () => {
    const approved = { status: 'APPROVED' as const, bodySnapshot: { body: {} }, isOwnRequest: true };
    expect(canApply(ROW(approved), NOW)).toBe(true);
    expect(canApply(ROW({ ...approved, bodySnapshot: null }), NOW)).toBe(false);
    expect(canApply(ROW({ ...approved, expiresAt: at(-1) }), NOW)).toBe(false);
    expect(canApply(ROW({ status: 'PENDING', bodySnapshot: { body: {} }, isOwnRequest: true }), NOW)).toBe(false);
  });

  it('only the admin who asked may apply; anyone else sees it awaiting the requester', () => {
    const approved = { status: 'APPROVED' as const, bodySnapshot: { body: {} } };
    expect(canApply(ROW({ ...approved, isOwnRequest: false }), NOW)).toBe(false);
    expect(awaitsRequester(ROW({ ...approved, isOwnRequest: false }), NOW)).toBe(true);
    expect(awaitsRequester(ROW({ ...approved, isOwnRequest: true }), NOW)).toBe(false);
    // nothing to wait for when there is nothing to execute
    expect(awaitsRequester(ROW({ ...approved, isOwnRequest: false, bodySnapshot: null }), NOW)).toBe(false);
    expect(awaitsRequester(ROW({ ...approved, isOwnRequest: false, expiresAt: at(-1) }), NOW)).toBe(false);
  });
});
