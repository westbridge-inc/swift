// [ENTERPRISE E1b · owner 29 Oct 2026] "Pay all my branches" (MMG-CHECKOUT-API.md section 12): the weekly fee of every
// branch that has one due, in ONE MMG checkout. Byte-identical in apps/web (src/lib/chain-fee.ts) and apps/mobile
// (src/lib/chain-fee.ts): the phone's census checks it. The server decides everything: which branches are due, each
// amount, the total, and whether a payment happened. The client shows its answers and sends back only the list the
// owner was shown, which the server compares (it never takes an amount from it). Nothing is ever called paid before
// the server says CONFIRMED, which it says only after MMG's own records confirm the payment.
import { feeDate, feeMoney } from './fee-status';

export type ChainBranchState = 'DUE' | 'TRIAL' | 'NOTHING_DUE' | 'PAYMENT_CONFIRMING' | 'NOT_PAYABLE';
export type ChainCheckoutState = 'OPEN' | 'CONFIRMING' | 'CONFIRMED' | 'NOT_PAID' | 'EXPIRED' | 'HELD';
export interface ChainBranchFee {
  vendorId: string; branchName: string; subscriptionId: string | null; subscriptionStatus: string | null;
  state: ChainBranchState;
  /** DUE only: exactly what that branch's own Pay button would charge now. */
  amountGyd: number | null;
}
export interface ChainCheckoutBranch { vendorId: string; branchName: string; subscriptionId: string; amountGyd: number }
export interface ChainCheckout {
  ref: string; status: ChainCheckoutState; amountGyd: number; currencyCode: 'GYD';
  createdAt: string; expiresAt: string; confirmedAt: string | null;
  /** Ours, the reference MMG was sent; what support finds the payment by. */
  swiftReference?: string;
  /** MMG's transaction, sent only once CONFIRMED. */
  mmgTransactionId?: string | null;
  branches: ChainCheckoutBranch[];
}
/** GET /vendor/subscription/chain-fees */
export interface ChainFees { branches: ChainBranchFee[]; totalGyd: number; currencyCode: 'GYD'; payable: boolean; recentCheckouts: ChainCheckout[] }
export interface ChainCheckoutStart { ref: string; status: ChainCheckoutState; checkoutUrl: string | null; amountGyd: number; currencyCode: 'GYD'; expiresAt: string; branches?: ChainCheckoutBranch[] }
/** The body of POST /vendor/subscription/chain-fees/mmg-checkout: the list the owner was shown, as the server sent it. */
export interface ChainConfirmed { branches: Array<{ subscriptionId: string; amountGyd: number }>; totalGyd: number }

export const CHAIN_FEE_PATH = '/vendor/subscription/chain-fees';

export const CHAIN_COPY = {
  title: 'Pay all my branches',
  entry: 'One MMG payment for every branch with a weekly fee due.',
  intro: 'Pay the weekly fee of every branch that has one due, in one MMG payment.',
  optional: 'This is optional. Each branch can still pay its own fee on its own Weekly fee page.',
  notCharged: 'A branch with nothing due, or with a payment being confirmed, is not in this payment and is not charged.',
  confirmFirst: 'Nothing is marked paid until MMG confirms the payment. Then each branch gets its own receipt.',
  paused: "While this payment is being confirmed, its branches can't be paid on their own, so no fee is paid twice.",
  ownerOnly: 'Only the business owner can pay all branches at once.',
  nothingDue: 'No branch has a weekly fee to pay with MMG right now.',
  notHere: "Paying all branches with MMG isn't available for this account right now.",
  recent: 'Your pay-all payments',
  noRecent: 'No pay-all payments yet.',
} as const;

/** What one branch's row says. A branch that is not DUE is never charged by a pay-all payment. */
export function chainBranchWords(b: ChainBranchFee): string {
  switch (b.state) {
    case 'DUE': return typeof b.amountGyd === 'number' ? feeMoney(b.amountGyd) : 'Due';
    case 'TRIAL': return 'Not charged: in its free trial';
    case 'NOTHING_DUE': return 'Not charged: nothing due right now';
    case 'PAYMENT_CONFIRMING': return 'Not charged: a payment for it is being confirmed';
    default: return 'Not charged here: its own Weekly fee page shows where it stands';
  }
}

/** The DUE branches, exactly as the server priced them. */
export function dueBranches(fees?: ChainFees | null): Array<ChainBranchFee & { subscriptionId: string; amountGyd: number }> {
  return (fees?.branches ?? []).filter((b): b is ChainBranchFee & { subscriptionId: string; amountGyd: number } =>
    b.state === 'DUE' && typeof b.subscriptionId === 'string' && !!b.subscriptionId && typeof b.amountGyd === 'number' && b.amountGyd > 0);
}

/** The list to confirm: the server's own figures sent back unchanged (never a sum made here). Null when nothing can be paid. */
export function chainConfirmed(fees?: ChainFees | null): ChainConfirmed | null {
  const due = dueBranches(fees);
  if (!fees?.payable || due.length === 0 || !(fees.totalGyd > 0)) return null;
  return { branches: due.map((b) => ({ subscriptionId: b.subscriptionId, amountGyd: b.amountGyd })), totalGyd: fees.totalGyd };
}

export const branchCount = (n: number) => (n === 1 ? '1 branch' : `${n} branches`);

/** A checkout that is not settled yet: its branches are paused and no new payment is offered. */
export const chainUnsettled = (c?: ChainCheckout | null) => !!c && (c.status === 'OPEN' || c.status === 'CONFIRMING' || c.status === 'HELD' || c.status === 'EXPIRED');

export function chainCheckoutWords(c: ChainCheckout, returned = false): string {
  if (c.status === 'OPEN' && Date.parse(c.expiresAt) <= Date.now()) return chainCheckoutWords({ ...c, status: 'EXPIRED' }, returned);
  switch (c.status) {
    case 'OPEN': return returned ? 'Waiting for MMG…' : 'Finish paying on the MMG page.';
    case 'CONFIRMING': return "Confirming your payment with MMG. Don't pay again.";
    case 'CONFIRMED': return `Paid: ${feeMoney(c.amountGyd)} received${feeDate(c.confirmedAt) ? ` on ${feeDate(c.confirmedAt)}` : ''} for ${branchCount(c.branches?.length ?? 0)}.`;
    case 'NOT_PAID': return "MMG didn't complete this payment. You can try again.";
    case 'EXPIRED': return "This checkout expired. Don't pay again. Swift support will check this payment.";
    case 'HELD': return "We're checking this payment by hand. Don't pay again. Support will contact you.";
  }
}

/** The references a partner can quote to support: ours always, MMG's only once CONFIRMED. */
export function chainCheckoutReferences(c: ChainCheckout): Array<{ label: string; value: string }> {
  return [
    ...(c.swiftReference ? [{ label: 'Swift reference', value: c.swiftReference }] : []),
    ...(c.status === 'CONFIRMED' && c.mmgTransactionId ? [{ label: 'MMG transaction ID', value: c.mmgTransactionId }] : []),
  ];
}

/** Each branch a checkout pays and its share, as the server recorded it. */
export const chainShares = (c: ChainCheckout) => (c.branches ?? []).map((b) => `${b.branchName}: ${feeMoney(b.amountGyd)}`);

/** The same polling rule as one branch's checkout (section 5): 3 s for a minute, then 15 s for ten, then stop. */
export function chainPollDelay(elapsed: number, state?: ChainCheckoutState): number | null {
  if (state === 'CONFIRMED' || state === 'NOT_PAID' || state === 'HELD' || elapsed >= 660_000) return null;
  return elapsed < 60_000 ? 3_000 : 15_000;
}

export interface ChainFailure { status?: number; code?: string; details?: { ref?: string }; dismissed?: boolean }
export interface ChainTransport {
  start(_key: string, _confirmed: ChainConfirmed): Promise<ChainCheckoutStart>;
  read(_ref: string): Promise<ChainCheckout>;
  open(_url: string): Promise<unknown>;
  /** Re-read the list (GET chain-fees). */
  refresh(): void;
}
export interface ChainView { checkout: ChainCheckout | null; returned: boolean; busy: boolean; error: string; blocked: boolean }

/** Owns one screen lifetime of the pay-all checkout. Browser replies and push payloads never become ledger state. */
export class ChainCheckoutSession {
  private active = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private retry: { list: string; key: string } | undefined;
  private followingRef: string | undefined;
  private view: ChainView = { checkout: null, returned: false, busy: false, error: '', blocked: false };
  private transport: ChainTransport;
  private key: () => string;
  private changed: (_view: ChainView) => void;
  private failure: (_error: unknown) => ChainFailure;
  constructor(transport: ChainTransport, key: () => string, changed: (_view: ChainView) => void, failure: (_error: unknown) => ChainFailure) {
    this.transport = transport; this.key = key; this.changed = changed; this.failure = failure;
  }
  private emit(patch: Partial<ChainView>) { if (this.active) { this.view = { ...this.view, ...patch }; this.changed(this.view); } }
  activate() { this.active = true; }
  dispose() { this.active = false; this.generation++; clearTimeout(this.timer); }
  async pay(confirmed: ChainConfirmed | null) {
    if (!confirmed || !this.active || this.view.busy || this.view.blocked) return;
    this.generation++; clearTimeout(this.timer);
    this.emit({ busy: true, error: '', checkout: null, returned: false });
    // One key per tap on one list: a retry of the same tap reuses it; another list is another request.
    const list = JSON.stringify(confirmed);
    if (this.retry?.list !== list) this.retry = { list, key: this.key() };
    try {
      const started = await this.transport.start(this.retry.key, confirmed);
      if (!this.active) return;
      this.retry = undefined;
      // Only the opaque reference survives the browser call. Never cache its URL.
      this.followingRef = started.ref;
      if (started.status === 'OPEN' && started.checkoutUrl !== null) {
        try { await this.transport.open(started.checkoutUrl); } catch { /* Poll even when the browser cannot finish. */ }
      } else {
        this.emit({ blocked: started.status === 'CONFIRMING' || started.status === 'HELD' || started.status === 'EXPIRED' });
      }
      if (this.active) { this.emit({ returned: true }); this.follow(started.ref, true); }
    } catch (e) {
      if (!this.active) return;
      const f = this.failure(e);
      // "Confirm it's you" closed without a code: nothing happened, and nothing is said.
      if (f.dismissed) return;
      if (f.status && f.status < 500 && f.status !== 429) this.retry = undefined;
      if (f.code === 'CHECKOUT_CONFIRMING') {
        this.emit({ blocked: true, error: "We're confirming your last payment, don't pay again." });
        if (f.details?.ref) this.follow(f.details.ref, true);
      } else if (f.code === 'PAYMENT_CONFIRMING') {
        this.emit({ error: "A payment for one of these branches is being confirmed. Check the list again. If you already paid, don't pay again." });
        this.transport.refresh();
      } else if (f.code === 'PAYMENT_QUOTE_CHANGED') {
        this.emit({ error: 'The weekly fees changed. Check the list again, then pay.' });
        this.transport.refresh();
        if (f.details?.ref) this.follow(f.details.ref, true);
      } else if (f.code === 'NOTHING_DUE') {
        this.emit({ error: CHAIN_COPY.nothingDue }); this.transport.refresh();
      } else if (f.status === 403 || f.code === 'PAY_ACTION_OFF') {
        this.emit({ blocked: true }); this.transport.refresh();
      } else {
        this.emit({ error: f.code === 'MMG_CHECKOUT_UNAVAILABLE' || f.status === 429 ? 'Try again in a minute.' : 'Could not open MMG. Try again.' });
      }
    } finally { this.emit({ busy: false }); }
  }
  follow(ref: string, returned = false) {
    if (!this.active) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.followingRef = ref;
    const start = Date.now();
    const tick = async () => {
      if (!this.active || generation !== this.generation) return;
      let status: ChainCheckoutState | undefined;
      try {
        const c = await this.transport.read(ref);
        if (!this.active || generation !== this.generation) return;
        status = c.status;
        this.emit({ checkout: c, returned, error: '', blocked: status === 'CONFIRMING' || status === 'HELD' || status === 'EXPIRED' });
        if (chainPollDelay(0, status) === null) this.transport.refresh();
      } catch { if (this.active && generation === this.generation) this.emit({ error: 'Could not check your payment. Refresh to try again.' }); }
      if (!this.active || generation !== this.generation) return;
      const delay = chainPollDelay(Date.now() - start, status);
      if (delay !== null) this.timer = setTimeout(tick, delay);
    };
    void tick();
  }
  /** A refreshed list is server evidence: the checkout being followed (or the newest) as the server now has it. */
  reconcile(recent: ChainCheckout[] = []) {
    const latest = this.followingRef ? recent.find((c) => c.ref === this.followingRef) : recent[0];
    if (!latest) return;
    if (chainPollDelay(0, latest.status) === null) { this.generation++; clearTimeout(this.timer); }
    this.emit({ checkout: latest, blocked: latest.status === 'CONFIRMING' || latest.status === 'HELD' || latest.status === 'EXPIRED' });
  }
  focus(latest?: ChainCheckout | null, ref?: string) {
    const target = ref ?? latest?.ref ?? this.followingRef;
    if (target) this.follow(target, true);
  }
}
