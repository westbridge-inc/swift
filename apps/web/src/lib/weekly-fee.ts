// MMG-CHECKOUT-API ca425ee7, plus the receipt references of section 5 and the reopen route of section 3. Kept identical across the two independently built apps.
import { feeDate, feeMoney, feeStatusOf, type FeeStatus, type FeeStatusState } from './fee-status';
// [REVIEW-F S4-1 · FEE-STATUS] The fee status words live in ./fee-status (small, so the web's Orders home can use them).
export { feeDate, feeMoney, feeStatusOf };
export type { FeeStatus, FeeStatusState };
export type FeeFamily = 'vendor' | 'rider' | 'driver' | 'provider';
export type CheckoutState = 'OPEN' | 'CONFIRMING' | 'CONFIRMED' | 'NOT_PAID' | 'EXPIRED' | 'HELD';
export type PayAction = { id: 'MMG_CHECKOUT'; state: 'live'; amountGyd: number; currencyCode: 'GYD' } | { id: 'MMG_CHECKOUT' | 'CARD'; state: 'off' };
export interface CheckoutStatus {
  ref: string; status: CheckoutState; amountGyd: number; currencyCode: 'GYD';
  createdAt: string; expiresAt: string; confirmedAt: string | null; subscriptionStatus: string;
  /** Ours, the reference MMG was sent; what support finds the payment by. Absent from an older API. */
  swiftReference?: string;
  /** MMG's transaction, sent only once CONFIRMED. */
  mmgTransactionId?: string | null;
  /** [Owner 15 Oct 2026 · ruling #63] Who sold the weekly fee (Swift's operator), as the API states it. Absent from an older API. */
  seller?: { name: string; tradingAs?: string; registrationNo?: string; registeredAddress: string; phone?: string; email?: string };
}
export interface FeeSubscription {
  id?: string; status: string; amountDueGyd?: number | string; nextBillingDate?: string | null;
  currentPeriodEnd?: string | null; gracePeriodEnd?: string | null;
  reopenableMmgCheckout?: { ref: string; expiresAt: string } | null;
  weeklyFeeGyd?: number | string; isTrialActive?: boolean; trialEndDate?: string | null; isInGracePeriod?: boolean; autoRenew?: boolean;
  /** [FEE-STATUS] Where the fee stands, in the API's words (billing/fee-status.ts). Absent from an older API. */
  feeStatus?: FeeStatus | null;
  payActions?: PayAction[]; latestMmgCheckout?: CheckoutStatus | null; recentCheckouts?: CheckoutStatus[];
  /** [owner legal plan R12] The weekly-fee receipts, printed by the API (one source for every screen). */
  feeReceipts?: FeeReceipt[];
  /** The partner's newest card session of the last day (CARD-CHECKOUT-API section 4), read by the card lib only. */
  latestCardSession?: unknown;
}
export interface FeeReceipt { receiptNumber: string; lines: string[] }
export interface CheckoutStart { ref: string; status: CheckoutState; checkoutUrl: string | null; amountGyd: number; currencyCode: 'GYD'; expiresAt: string }
export function liveMmg(sub?: FeeSubscription | null) {
  return sub?.payActions?.find((a): a is Extract<PayAction, { state: 'live' }> => a.id === 'MMG_CHECKOUT' && a.state === 'live');
}
/** A Back tap the server refused, or answered with anything but that checkout's open page. */
export const REOPEN_REFUSED = "We couldn't reopen that MMG page. Its latest status is shown here.";
export function subscriptionWords(status: string): string {
  return ({ TRIAL: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Weekly fee overdue', SUSPENDED: 'Account suspended', CHURNED: 'Account inactive', PAUSED: 'Weekly billing paused', CANCELLED: 'Subscription closed' } as Record<string, string>)[status] ?? 'Status unavailable';
}
export function checkoutWords(c: CheckoutStatus, returned = false): string {
  if (c.status === 'OPEN' && Date.parse(c.expiresAt) <= Date.now()) return checkoutWords({ ...c, status: 'EXPIRED' }, returned);
  switch (c.status) {
    case 'OPEN': return returned ? 'Waiting for MMG…' : 'Finish paying on the MMG page.';
    case 'CONFIRMING': return "Confirming your payment with MMG. Don't pay again.";
    case 'CONFIRMED': return `Paid: ${feeMoney(c.amountGyd)} received${feeDate(c.confirmedAt) ? ` on ${feeDate(c.confirmedAt)}` : ''}.`;
    case 'NOT_PAID': return "MMG didn't complete this payment. You can try again.";
    case 'EXPIRED': return "This checkout expired. Don't pay again. Swift support will check this payment.";
    case 'HELD': return "We're checking this payment by hand. Don't pay again. Support will contact you.";
  }
}
/** The references a partner can quote to support: the Swift reference, and
 *  MMG's transaction ID only once the payment is CONFIRMED (a transaction MMG
 *  merely named is never shown as a receipt). */
export function checkoutReferences(c: CheckoutStatus): Array<{ label: string; value: string }> {
  return [
    ...(c.swiftReference ? [{ label: 'Swift reference', value: c.swiftReference }] : []),
    ...(c.status === 'CONFIRMED' && c.mmgTransactionId ? [{ label: 'MMG transaction ID', value: c.mmgTransactionId }] : []),
  ];
}
/** [Owner 15 Oct 2026 · ruling #63] The receipt's seller line, in the API's words; null when an older API sent none. */
export function checkoutSeller(c: CheckoutStatus): string | null {
  return c.seller
    ? `Sold by ${c.seller.name}${c.seller.registrationNo ? ` (registration no. ${c.seller.registrationNo})` : ''}, ${c.seller.registeredAddress}`
      + (c.seller.phone && c.seller.email ? `. Phone ${c.seller.phone}, email ${c.seller.email}` : '')
    : null;
}
export function pollDelay(elapsed: number, state?: CheckoutState): number | null {
  if (state === 'CONFIRMED' || state === 'NOT_PAID' || state === 'HELD' || elapsed >= 660_000) return null;
  return elapsed < 60_000 ? 3_000 : 15_000;
}
export interface FeeFailure { status?: number; code?: string; details?: { ref?: string } }
export interface FeeTransport {
  start(_key: string): Promise<CheckoutStart>;
  /** Back to MMG's page: the server may only hand back THIS checkout's open page. */
  reopen(_ref: string, _key: string): Promise<CheckoutStart>;
  read(_ref: string): Promise<CheckoutStatus>;
  open(_url: string): Promise<unknown>;
  refresh(): void;
}
export interface CheckoutView { checkout: CheckoutStatus | null; returned: boolean; busy: boolean; error: string; blocked: boolean }
/** Owns one screen lifetime. Browser replies and push payloads never become ledger state. */
export class FeeCheckoutSession {
  private active = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private retryKey: string | undefined;
  private followingRef: string | undefined;
  private view: CheckoutView = { checkout: null, returned: false, busy: false, error: '', blocked: false };
  private transport: FeeTransport;
  private key: () => string;
  private changed: (_view: CheckoutView) => void;
  private failure: (_error: unknown) => FeeFailure;
  constructor(transport: FeeTransport, key: () => string, changed: (_view: CheckoutView) => void, failure: (_error: unknown) => FeeFailure) {
    this.transport = transport; this.key = key; this.changed = changed; this.failure = failure;
  }
  private emit(patch: Partial<CheckoutView>) { if (this.active) { this.view = { ...this.view, ...patch }; this.changed(this.view); } }
  activate() { this.active = true; }
  dispose() { this.active = false; this.generation++; clearTimeout(this.timer); }
  async pay() {
    if (!this.active || this.view.busy || this.view.blocked) return;
    this.generation++; clearTimeout(this.timer);
    this.emit({ busy: true, error: '', checkout: null, returned: false });
    this.retryKey ??= this.key();
    try {
      const started = await this.transport.start(this.retryKey);
      if (!this.active) return;
      this.retryKey = undefined;
      // Only the opaque reference survives the browser call. Never cache its URL.
      this.followingRef = started.ref;
      // Replaying a tap can return a checkout that has already left OPEN.
      // Its page must never reopen; only its server reference is followed.
      if (started.status === 'OPEN' && started.checkoutUrl !== null) {
        try { await this.transport.open(started.checkoutUrl); } catch { /* Poll even when the browser cannot finish. */ }
      } else {
        this.emit({ blocked: started.status === 'CONFIRMING' || started.status === 'HELD' || started.status === 'EXPIRED' });
      }
      if (this.active) { this.emit({ returned: true }); this.follow(started.ref, true); }
    } catch (e) {
      if (!this.active) return;
      const f = this.failure(e);
      if (f.status && f.status < 500 && f.status !== 429) this.retryKey = undefined;
      if (f.code === 'CHECKOUT_CONFIRMING' || f.code === 'PAYMENT_CONFIRMING') {
        // PAYMENT_CONFIRMING also means billing is being prepared or reviewed: neutral words.
        this.emit({ blocked: true, error: f.code === 'CHECKOUT_CONFIRMING' ? "We're confirming your last payment, don't pay again." : "Paying is paused while Swift checks this fee. If you already paid, don't pay again." });
        if (f.details?.ref) this.follow(f.details.ref, true);
      } else if (f.status === 403 || f.code === 'PAY_ACTION_OFF') {
        this.emit({ blocked: true }); this.transport.refresh();
      } else {
        this.emit({ error: f.code === 'PAY_AHEAD_LIMIT' ? 'Your next weekly fee is already paid. Swift takes the weekly fee one week at a time: you can pay again once that week has started.' : f.code === 'MMG_CHECKOUT_UNAVAILABLE' || f.status === 429 ? 'Try again in a minute.' : 'Could not open MMG. Try again.' });
        if (f.code === 'SUBSCRIPTION_NOT_FOUND') this.transport.refresh();
      }
    } finally { this.emit({ busy: false }); }
  }
  /** Back to MMG's page for `ref` only. Never the start route: a stale tap can
   *  never start a new payment. A page is opened only when the answer names the
   *  same ref, OPEN, with a page; anything else opens nothing and refreshes. */
  async reopen(ref: string) {
    if (!this.active || this.view.busy || this.view.blocked) return;
    this.generation++; clearTimeout(this.timer);
    this.followingRef = ref;
    this.emit({ busy: true, error: '', returned: false });
    try {
      const started = await this.transport.reopen(ref, this.key());
      if (!this.active) return;
      if (started.ref === ref && started.status === 'OPEN' && started.checkoutUrl !== null) {
        try { await this.transport.open(started.checkoutUrl); } catch { /* Poll even when the browser cannot finish. */ }
        if (this.active) { this.emit({ returned: true }); this.follow(ref, true); }
        return;
      }
      // Another checkout, no page, or no longer OPEN: nothing is opened. The
      // refreshed subscription shows this checkout's own status (reconcile).
      this.emit({ error: REOPEN_REFUSED }); this.transport.refresh();
    } catch (e) {
      if (!this.active) return;
      const f = this.failure(e);
      const uncertain = f.status === undefined || f.status === 429 || f.status >= 500;
      this.emit({ error: uncertain ? 'Try again in a minute.' : REOPEN_REFUSED }); this.transport.refresh();
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
      let status: CheckoutState | undefined;
      try {
        const c = await this.transport.read(ref);
        if (!this.active || generation !== this.generation) return;
        status = c.status;
        this.emit({ checkout: c, returned, error: '', blocked: status === 'CONFIRMING' || status === 'HELD' || status === 'EXPIRED' });
        if (pollDelay(0, status) === null) this.transport.refresh();
      } catch { if (this.active && generation === this.generation) this.emit({ error: 'Could not check your payment. Refresh to try again.' }); }
      if (!this.active || generation !== this.generation) return;
      const delay = pollDelay(Date.now() - start, status);
      if (delay !== null) this.timer = setTimeout(tick, delay);
    };
    void tick();
  }
  /** A refreshed subscription is server evidence, even when its ref is unchanged. */
  reconcile(latest?: CheckoutStatus | null, recent: CheckoutStatus[] = []) {
    latest = this.followingRef ? [latest, ...recent].find((c) => c?.ref === this.followingRef) : latest;
    if (!latest) return;
    if (pollDelay(0, latest.status) === null) { this.generation++; clearTimeout(this.timer); }
    this.emit({ checkout: latest, blocked: latest.status === 'CONFIRMING' || latest.status === 'HELD' || latest.status === 'EXPIRED' });
  }
  focus(latest?: CheckoutStatus | null, ref?: string) {
    const target = ref ?? latest?.ref ?? this.followingRef;
    if (target) this.follow(target, true);
  }
}
