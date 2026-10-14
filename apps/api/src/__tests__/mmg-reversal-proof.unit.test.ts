import { describe, it, expect } from 'vitest';
import type { MmgLookupClient, MmgLookupDetail } from '../providers/mmg/mmg-provider';
import { decideAfterLookup, lookupProof, verdictOf, REVERSAL_PROOF_WINDOW_MS, REVERSAL_SENDING_STALE_MS, type ReversalProof } from '../modules/billing/mmg-reversal-proof';

// ---------------------------------------------------------------------------
// [MMG REVERSAL · owner #11] THE rule for what MMG's answers prove, shared by
// the reversal service and the owner's UAT runner. Only MMG's lookup proves a
// return — for exactly the amount and currency — and everything that is not
// proof, refusal-with-the-payment-standing, or "MMG is still working" is a
// person's to look at.
// ---------------------------------------------------------------------------

const found = (status: 'approved' | 'reversed' | 'pending' | 'declined', amountMinor: number | null = 210_000, currencyCode: string | null = 'GYD'):
  MmgLookupDetail => ({
  outcome: 'found', transactionId: 'x', status, statusText: status, amountMinor, currencyCode, creditParties: null, creditAccounts: null,
  createdAt: null, ledgerReference: null, echoedReferences: [], raw: {},
});
const client = (answers: Record<string, MmgLookupDetail>): MmgLookupClient => ({
  transactionLookupDetail: async (id) => answers[id] ?? { outcome: 'not_found' },
});
const row = (patch: Partial<{ providerReference: string | null; amount: number; currencyCode: string }> = {}) => ({
  mmgTransactionId: 'TX1', providerReference: null, amount: 2100, currencyCode: 'GYD', ...patch,
});

describe('[MMG REVERSAL] what MMG\'s lookup proves', () => {
  it('the original reported reversed, for exactly the amount and currency, is proof', async () => {
    expect(await lookupProof(client({ TX1: found('reversed') }), row())).toEqual({ proven: true, how: 'ORIGINAL_REVERSED' });
  });

  it('a reversed answer for another amount, another currency, or no amount is NOT proof', async () => {
    expect((await lookupProof(client({ TX1: found('reversed', 200_000) }), row())).proven).toBe(false);
    expect((await lookupProof(client({ TX1: found('reversed', 210_000, 'USD') }), row())).proven).toBe(false);
    expect((await lookupProof(client({ TX1: found('reversed', null) }), row())).proven).toBe(false);
    expect((await lookupProof(client({ TX1: found('reversed', 210_000, null) }), row())).proven).toBe(false);
  });

  it('the reversal MMG\'s own answer named, reported completed for the amount, is proof', async () => {
    const r = row({ providerReference: 'REV1' });
    expect(await lookupProof(client({ TX1: found('approved'), REV1: found('approved') }), r)).toEqual({ proven: true, how: 'REVERSAL_COMPLETED' });
    expect((await lookupProof(client({ TX1: found('approved'), REV1: found('approved', 100) }), r)).proven).toBe(false);
    expect((await lookupProof(client({ TX1: found('approved'), REV1: found('pending') }), r)).proven).toBe(false);
    // a "reference" that is the original itself proves nothing
    expect((await lookupProof(client({ TX1: found('approved') }), row({ providerReference: 'TX1' }))).proven).toBe(false);
  });

  it('[review S2-2] a reference MMG named that is the PAYMENT itself (its id in any spelling, or its ledger number) is never proof', async () => {
    // MMG's lookup reads ids in any spelling; the payment answers "successful" for the same amount.
    const anySpelling = (answers: Record<string, MmgLookupDetail>): MmgLookupClient => ({
      transactionLookupDetail: async (id) => answers[id.trim().toUpperCase()] ?? { outcome: 'not_found' },
    });
    const payment = found('approved');
    expect(await lookupProof(anySpelling({ TX1: payment }), row({ providerReference: ' tx1 ' })))
      .toEqual({ proven: false, standing: true, unreadable: false });
    const withLedger = { ...payment, ledgerReference: 'LEDGER7' } as MmgLookupDetail;
    expect(await lookupProof(anySpelling({ TX1: withLedger, LEDGER7: payment }), row({ providerReference: 'ledger7' })))
      .toEqual({ proven: false, standing: true, unreadable: false });
  });

  it('[review S3-2] a reversal MMG named that is still pending (or unreadable) is reported in flight', async () => {
    const r = row({ providerReference: 'REV1' });
    expect(await lookupProof(client({ TX1: found('approved'), REV1: found('pending') }), r))
      .toEqual({ proven: false, standing: true, unreadable: false, namedInFlight: true });
    expect(await lookupProof(client({ TX1: found('approved'), REV1: found('declined') }), r))
      .toEqual({ proven: false, standing: true, unreadable: false });
    // [DS1124 S3] A final answer for another amount is not a return of this payment, not "in flight".
    expect(await lookupProof(client({ TX1: found('approved'), REV1: found('approved', 100) }), r))
      .toEqual({ proven: false, standing: true, unreadable: false });
  });

  it('[security review: fail-open] while MMG cannot read the payment itself, nothing it named proves a return', async () => {
    const unreadable: MmgLookupClient = { transactionLookupDetail: async (id) => (id === 'TX1' ? { outcome: 'error', reason: 'timeout' } : found('approved')) };
    expect(await lookupProof(unreadable, row({ providerReference: 'REV1' }))).toEqual({ proven: false, standing: false, unreadable: true });
    // [DS1127 S2] "not found" is no better: the payment's own ledger number cannot be ruled out.
    const unknown: MmgLookupClient = { transactionLookupDetail: async (id) => (id === 'TX1' ? { outcome: 'not_found' } : found('approved')) };
    expect(await lookupProof(unknown, row({ providerReference: 'REV1' }))).toEqual({ proven: false, standing: false, unreadable: true });
  });

  it('[DS1124 S2] a reference MMG named that Swift has on record as a payment is neither proof nor in flight', async () => {
    const r = row({ providerReference: 'PAY2' });
    expect(await lookupProof(client({ TX1: found('approved'), PAY2: found('approved') }), r, async (ref) => ref === 'PAY2'))
      .toEqual({ proven: false, standing: true, unreadable: false, namedKnownPayment: true });
  });

  it('standing = MMG still shows the payment successful for the amount; unreadable = MMG does not know it', async () => {
    expect(await lookupProof(client({ TX1: found('approved') }), row())).toEqual({ proven: false, standing: true, unreadable: false });
    expect(await lookupProof(client({ TX1: found('approved', 1) }), row())).toEqual({ proven: false, standing: false, unreadable: false });
    expect(await lookupProof(client({}), row())).toEqual({ proven: false, standing: false, unreadable: true });
  });
});

describe('[MMG REVERSAL] what Swift records after the lookup', () => {
  const now = new Date('2026-10-13T20:00:00Z');
  const standing: ReversalProof = { proven: false, standing: true, unreadable: false };
  const unclear: ReversalProof = { proven: false, standing: false, unreadable: true };
  const open = (state: 'SENDING' | 'SENT' | 'HELD', providerStatus: string | null, ageMs = 0, providerReason: string | null = null) =>
    ({ state, providerStatus, providerReason, sentAt: new Date(now.getTime() - ageMs) });

  it('proof applies, whatever MMG answered before', () => {
    expect(decideAfterLookup({ proven: true, how: 'ORIGINAL_REVERSED' }, open('SENDING', 'error'), { now, afterAnswer: true })).toEqual({ action: 'apply', how: 'ORIGINAL_REVERSED' });
    expect(decideAfterLookup({ proven: true, how: 'REVERSAL_COMPLETED' }, open('HELD', 'declined', 0, 'REVERSAL_FAIL_DUPLICATE'), { now, afterAnswer: false })).toEqual({ action: 'apply', how: 'REVERSAL_COMPLETED' });
  });

  it('MMG refusing while the payment stands fails it; refusing as "already reversed" never does', () => {
    expect(decideAfterLookup(standing, open('SENT', 'declined'), { now, afterAnswer: true })).toEqual({ action: 'fail' });
    expect(decideAfterLookup(standing, open('SENT', 'declined', 0, 'REVERSAL_FAIL_DUPLICATE'), { now, afterAnswer: true }))
      .toEqual({ action: 'hold', heldReason: 'MMG_SAYS_ALREADY_REVERSED', lookupStatus: 'STANDING' });
    expect(decideAfterLookup(unclear, open('SENT', 'declined'), { now, afterAnswer: true }))
      .toEqual({ action: 'hold', heldReason: 'MMG_REFUSED_LOOKUP_UNCLEAR', lookupStatus: 'UNREADABLE' });
  });

  it('MMG accepted: wait inside its window, hold after it', () => {
    expect(decideAfterLookup(standing, open('SENT', 'pending', REVERSAL_PROOF_WINDOW_MS - 1), { now, afterAnswer: false })).toEqual({ action: 'wait', lookupStatus: 'STANDING' });
    expect(decideAfterLookup(standing, open('SENT', 'pending', REVERSAL_PROOF_WINDOW_MS), { now, afterAnswer: false }))
      .toEqual({ action: 'hold', heldReason: 'NOT_PROVEN_IN_TIME', lookupStatus: 'STANDING' });
  });

  it('no answer: held at once after its own request; a fresh claim is left to its request, a stale one held', () => {
    expect(decideAfterLookup(standing, open('SENDING', 'error'), { now, afterAnswer: true })).toEqual({ action: 'hold', heldReason: 'NO_ANSWER_FROM_MMG', lookupStatus: 'STANDING' });
    expect(decideAfterLookup(standing, open('SENDING', null, REVERSAL_SENDING_STALE_MS - 1), { now, afterAnswer: false })).toEqual({ action: 'leave' });
    expect(decideAfterLookup(standing, open('SENDING', null, REVERSAL_SENDING_STALE_MS), { now, afterAnswer: false }))
      .toEqual({ action: 'hold', heldReason: 'NO_ANSWER_FROM_MMG', lookupStatus: 'STANDING' });
  });

  it('the UAT verdict is the same rule in words', () => {
    expect(verdictOf({ proven: true, how: 'ORIGINAL_REVERSED' }, { status: 'reversed', transactionId: 'R' }, now).state).toMatch(/^REVERSED/);
    expect(verdictOf(standing, { status: 'declined', transactionId: 'TX1', reason: 'INVALID' }, now).state).toMatch(/^FAILED/);
    expect(verdictOf(standing, { status: 'pending', transactionId: 'R' }, now).state).toMatch(/^SENT/);
    expect(verdictOf(standing, { status: 'error', transactionId: '' }, now).state).toMatch(/^HELD/);
  });
});
