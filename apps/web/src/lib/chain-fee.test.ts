import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChainCheckoutSession, chainBranchWords, chainCheckoutReferences, chainCheckoutWords, chainConfirmed, chainUnsettled, dueBranches,
  type ChainCheckout, type ChainFees, type ChainTransport, type ChainView,
} from './chain-fee';

// ---------------------------------------------------------------------------
// [ENTERPRISE E1b · owner 29 Oct 2026] "Pay all my branches" (MMG-CHECKOUT-API.md section 12), the rules both apps
// share (src/lib/chain-fee.ts, byte-identical on the phone). The server prices every branch and the total; the client
// sends the list it was shown back unchanged, never a sum of its own. Synthetic branches only.
// ---------------------------------------------------------------------------

const fees = (over: Partial<ChainFees> = {}): ChainFees => ({
  branches: [
    { vendorId: 'v1', branchName: 'North', subscriptionId: 's1', subscriptionStatus: 'ACTIVE', state: 'DUE', amountGyd: 12000 },
    { vendorId: 'v2', branchName: 'Camp', subscriptionId: 's2', subscriptionStatus: 'PAST_DUE', state: 'DUE', amountGyd: 9000 },
    { vendorId: 'v3', branchName: 'East', subscriptionId: 's3', subscriptionStatus: 'ACTIVE', state: 'NOTHING_DUE', amountGyd: null },
    { vendorId: 'v4', branchName: 'West', subscriptionId: 's4', subscriptionStatus: 'TRIAL', state: 'TRIAL', amountGyd: null },
    { vendorId: 'v5', branchName: 'South', subscriptionId: 's5', subscriptionStatus: 'ACTIVE', state: 'PAYMENT_CONFIRMING', amountGyd: null },
    { vendorId: 'v6', branchName: 'Old', subscriptionId: 's6', subscriptionStatus: 'CHURNED', state: 'NOT_PAYABLE', amountGyd: null },
  ],
  totalGyd: 21000, currencyCode: 'GYD', payable: true, recentCheckouts: [], ...over,
});
const checkout = (status: ChainCheckout['status'], over: Partial<ChainCheckout> = {}): ChainCheckout => ({
  ref: 'chain-ref', status, amountGyd: 21000, currencyCode: 'GYD', createdAt: '2026-10-30T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  confirmedAt: status === 'CONFIRMED' ? '2026-10-30T12:05:00Z' : null, swiftReference: '123456789012345678', mmgTransactionId: status === 'CONFIRMED' ? 'MMG-9' : null,
  branches: [{ vendorId: 'v1', branchName: 'North', subscriptionId: 's1', amountGyd: 12000 }, { vendorId: 'v2', branchName: 'Camp', subscriptionId: 's2', amountGyd: 9000 }],
  ...over,
});

describe('[E1b] the pay-all list', () => {
  it('confirms exactly the DUE branches with the server\'s own amounts and total (never a sum made here)', () => {
    expect(chainConfirmed(fees())).toEqual({ branches: [{ subscriptionId: 's1', amountGyd: 12000 }, { subscriptionId: 's2', amountGyd: 9000 }], totalGyd: 21000 });
    // The total is the server's, as sent: a figure the client would have computed differently is still sent back unchanged.
    expect(chainConfirmed(fees({ totalGyd: 21500 }))?.totalGyd).toBe(21500);
  });

  it('offers nothing when the server says it is not payable, or when no branch is due', () => {
    expect(chainConfirmed(fees({ payable: false }))).toBeNull();
    expect(chainConfirmed(fees({ branches: fees().branches.filter((b) => b.state !== 'DUE'), totalGyd: 0 }))).toBeNull();
    expect(chainConfirmed(null)).toBeNull();
  });

  it('a branch that is not DUE is never in the payment, and its row says it is not charged', () => {
    expect(dueBranches(fees()).map((b) => b.subscriptionId)).toEqual(['s1', 's2']);
    // A malformed DUE row (no subscription or amount) is never sent.
    expect(dueBranches(fees({ branches: [{ vendorId: 'v9', branchName: 'X', subscriptionId: null, subscriptionStatus: null, state: 'DUE', amountGyd: 100 }] }))).toEqual([]);
    // Only the server's DUE state decides: a row in any other state is never sent, even one that carries an amount.
    for (const state of ['TRIAL', 'NOTHING_DUE', 'PAYMENT_CONFIRMING', 'NOT_PAYABLE'] as const) {
      const stray = fees({ branches: [{ vendorId: 'v7', branchName: 'Stray', subscriptionId: 's7', subscriptionStatus: 'ACTIVE', state, amountGyd: 5000 }], totalGyd: 5000 });
      expect(dueBranches(stray)).toEqual([]);
      expect(chainConfirmed(stray)).toBeNull();
    }
    for (const b of fees().branches.filter((x) => x.state !== 'DUE')) expect(chainBranchWords(b)).toMatch(/^Not charged/);
    expect(chainBranchWords(fees().branches[0]!)).toBe('GY$12,000');
  });

  it('says paid only once CONFIRMED, and shows MMG\'s transaction only then', () => {
    for (const s of ['OPEN', 'CONFIRMING', 'NOT_PAID', 'EXPIRED', 'HELD'] as const) {
      expect(chainCheckoutWords(checkout(s))).not.toMatch(/paid:/i);
      expect(chainCheckoutReferences(checkout(s, { mmgTransactionId: 'MMG-9' })).map((r) => r.label)).toEqual(['Swift reference']);
    }
    expect(chainCheckoutWords(checkout('CONFIRMED'))).toBe('Paid: GY$21,000 received on 30 Oct 2026 for 2 branches.');
    expect(chainCheckoutReferences(checkout('CONFIRMED'))).toEqual([{ label: 'Swift reference', value: '123456789012345678' }, { label: 'MMG transaction ID', value: 'MMG-9' }]);
    expect(chainCheckoutWords(checkout('OPEN', { expiresAt: '2020-01-01T00:00:00Z' }))).toContain('This checkout expired');
  });

  it('an open, confirming, held or expired checkout keeps Pay away (its branches are paused); a settled one does not', () => {
    for (const s of ['OPEN', 'CONFIRMING', 'HELD', 'EXPIRED'] as const) expect(chainUnsettled(checkout(s))).toBe(true);
    for (const s of ['CONFIRMED', 'NOT_PAID'] as const) expect(chainUnsettled(checkout(s))).toBe(false);
    expect(chainUnsettled(null)).toBe(false);
  });
});

describe('[E1b] the pay-all checkout session', () => {
  let views: ChainView[];
  let keys: number;
  const transport = (over: Partial<ChainTransport> = {}): ChainTransport & { start: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } => ({
    start: vi.fn(async () => ({ ref: 'chain-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/page', amountGyd: 21000, currencyCode: 'GYD', expiresAt: '2099-01-01T00:00:00Z' })),
    read: vi.fn(async () => checkout('OPEN')),
    open: vi.fn(async () => undefined),
    refresh: vi.fn(),
    ...over,
  }) as never;
  const failure = (e: unknown) => (e as { failure?: object }).failure ?? {};
  const session = (t: ChainTransport) => new ChainCheckoutSession(t, () => `key-${++keys}`, (v) => views.push(v), failure);
  const last = () => views[views.length - 1]!;
  beforeEach(() => { vi.useFakeTimers(); views = []; keys = 0; });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the confirmed list with one key, opens the MMG page, then follows the checkout until MMG settles it', async () => {
    const t = transport();
    const s = session(t);
    const list = chainConfirmed(fees())!;
    await s.pay(list);
    expect(t.start).toHaveBeenCalledWith('key-1', list);
    expect(t.open).toHaveBeenCalledWith('https://checkout.test/page');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.read).toHaveBeenCalledWith('chain-ref');
    expect(last().checkout?.status).toBe('OPEN');
    t.read.mockResolvedValue(checkout('CONFIRMED'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last().checkout?.status).toBe('CONFIRMED');
    expect(t.refresh).toHaveBeenCalled();
    const reads = t.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.read.mock.calls.length).toBe(reads); // stops at CONFIRMED
    s.dispose();
  });

  it('a handed-back checkout that already left OPEN never opens a page: it is followed', async () => {
    const t = transport({ start: vi.fn(async () => ({ ref: 'chain-ref', status: 'CONFIRMING' as const, checkoutUrl: null, amountGyd: 21000, currencyCode: 'GYD' as const, expiresAt: '2099-01-01T00:00:00Z' })) });
    t.read.mockResolvedValue(checkout('CONFIRMING'));
    const s = session(t);
    await s.pay(chainConfirmed(fees()));
    expect(t.open).not.toHaveBeenCalled();
    expect(last().blocked).toBe(true);
    s.dispose();
  });

  it('closing "Confirm it\'s you" does nothing and says nothing', async () => {
    const t = transport({ start: vi.fn(async () => { throw { failure: { dismissed: true } }; }) });
    const s = session(t);
    await s.pay(chainConfirmed(fees()));
    expect(last().error).toBe('');
    expect(last().busy).toBe(false);
    expect(t.open).not.toHaveBeenCalled();
    expect(t.refresh).not.toHaveBeenCalled();
    s.dispose();
  });

  it('changed fees: re-reads the list and asks to check it again; nothing is opened', async () => {
    const t = transport({ start: vi.fn(async () => { throw { failure: { status: 409, code: 'PAYMENT_QUOTE_CHANGED' } }; }) });
    const s = session(t);
    await s.pay(chainConfirmed(fees()));
    expect(last().error).toBe('The weekly fees changed. Check the list again, then pay.');
    expect(t.refresh).toHaveBeenCalled();
    expect(t.open).not.toHaveBeenCalled();
    expect(last().blocked).toBe(false);
    s.dispose();
  });

  it('a branch being confirmed: re-reads the list, keeps paying the rest possible, and says do not pay again', async () => {
    const t = transport({ start: vi.fn(async () => { throw { failure: { status: 409, code: 'PAYMENT_CONFIRMING' } }; }) });
    const s = session(t);
    await s.pay(chainConfirmed(fees()));
    expect(last().error).toContain("If you already paid, don't pay again.");
    expect(t.refresh).toHaveBeenCalled();
    expect(last().blocked).toBe(false);
    s.dispose();
  });

  it('an earlier pay-all being confirmed blocks Pay and is followed', async () => {
    const t = transport({ start: vi.fn(async () => { throw { failure: { status: 409, code: 'CHECKOUT_CONFIRMING', details: { ref: 'earlier' } } }; }) });
    t.read.mockResolvedValue(checkout('CONFIRMING', { ref: 'earlier' }));
    const s = session(t);
    await s.pay(chainConfirmed(fees()));
    expect(last().blocked).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.read).toHaveBeenCalledWith('earlier');
    s.dispose();
  });

  it('nothing due: says so and re-reads the list', async () => {
    const t = transport({ start: vi.fn(async () => { throw { failure: { status: 409, code: 'NOTHING_DUE' } }; }) });
    const s = session(t);
    await s.pay(chainConfirmed(fees()));
    expect(last().error).toBe('No branch has a weekly fee to pay with MMG right now.');
    expect(t.refresh).toHaveBeenCalled();
    s.dispose();
  });

  it('a retry of the same tap after a network failure reuses its key; another list is a new key', async () => {
    const start = vi.fn(async () => { throw { failure: {} }; });
    const t = transport({ start });
    const s = session(t);
    const list = chainConfirmed(fees())!;
    await s.pay(list);
    await s.pay(list);
    expect(start.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['key-1', 'key-1']);
    expect(last().error).toBe('Could not open MMG. Try again.');
    await s.pay({ ...list, branches: list.branches.slice(0, 1), totalGyd: 12000 });
    expect((start.mock.calls[2] as unknown[])[0]).toBe('key-2');
    s.dispose();
  });

  it('a refreshed list settles the followed checkout from server state (a late CONFIRMED stops the poll)', async () => {
    const t = transport();
    t.read.mockResolvedValue(checkout('EXPIRED'));
    const s = session(t);
    s.focus(checkout('EXPIRED'));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().blocked).toBe(true);
    s.reconcile([checkout('CONFIRMED')]);
    expect(last().checkout?.status).toBe('CONFIRMED');
    expect(last().blocked).toBe(false);
    const reads = t.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.read.mock.calls.length).toBe(reads);
    s.dispose();
  });
});
