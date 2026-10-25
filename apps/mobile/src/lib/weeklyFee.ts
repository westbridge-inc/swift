// MMG-CHECKOUT-API ca425ee7, plus the receipt references of section 5. Kept identical across the two independently built apps.
export type FeeFamily = 'vendor' | 'rider' | 'driver';
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
export const feeMoney = (n: number) => `GY$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export function feeDate(value?: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guyana' }) : '';
}
export function liveMmg(sub?: FeeSubscription | null) {
  return sub?.payActions?.find((a): a is Extract<PayAction, { state: 'live' }> => a.id === 'MMG_CHECKOUT' && a.state === 'live');
}
/** [FEE-STATUS · owner 25 Oct 2026] Where the weekly fee stands. A store read "Nothing due right now: your next
 *  bill is 13 Oct 2026" and "Active" on 25 October. The API now words it (GET /{family}/subscription feeStatus);
 *  for an API from before that, the same rules run here on the row, minus the holds only the server can see
 *  (a checkout being checked still reads as checking). A date that has passed is never a next bill or an "until". */
export type FeeStatusState = 'TRIAL' | 'PAID' | 'COVERED' | 'DUE' | 'CHECKING' | 'FEE_PAUSED' | 'SUSPENDED' | 'INACTIVE' | 'STOPPED' | 'CLOSED' | 'UNKNOWN';
export interface FeeStatus { state: FeeStatusState; headline: string; detail: string | null; date: string | null }
export function feeStatusOf(sub: FeeSubscription, now = Date.now()): FeeStatus {
  const sent = sub.feeStatus;
  if (sent && typeof sent.headline === 'string' && sent.headline) return sent;
  const word = (state: FeeStatusState, headline: string, detail: string | null = null, date: string | null = null): FeeStatus => ({ state, headline, detail, date });
  const at = (value?: string | null) => (value ? Date.parse(value) : NaN);
  const raw = sub.amountDueGyd;
  const amountDue = raw != null && raw !== '' ? Number(raw) : NaN;
  const status = String(sub.status ?? '').toUpperCase();
  const next = feeDate(sub.nextBillingDate);
  const due = !(at(sub.nextBillingDate) > now);
  if (status === 'CANCELLED') return word('CLOSED', 'Subscription closed');
  const c = sub.latestMmgCheckout;
  if (c && (c.status === 'HELD' || c.status === 'CONFIRMING')) {
    return word('CHECKING', `Checking your payment of ${feeMoney(c.amountGyd)}${feeDate(c.createdAt) ? ` (began ${feeDate(c.createdAt)})` : ''}`, "Don't pay again while we check.", c.createdAt);
  }
  if (status === 'SUSPENDED' || status === 'CHURNED') {
    const owed = amountDue > 0 ? amountDue : Number(sub.weeklyFeeGyd ?? 0);
    return word(status === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE', status === 'SUSPENDED' ? 'Account suspended' : 'Account inactive',
      `${owed > 0 ? feeMoney(owed) : 'The weekly fee'} due ${due && next ? `since ${next}` : 'now'}. Pay it to start receiving work again.`);
  }
  if (status === 'PAUSED' || (sub.autoRenew === false && due)) return word('STOPPED', 'Weekly billing stopped', 'You receive no work while it is stopped. Resume weekly billing to start again.');
  const trialEnd = at(sub.trialEndDate) > now ? sub.trialEndDate : !due ? sub.nextBillingDate : null;
  if ((sub.isTrialActive === true || status === 'TRIAL') && trialEnd) return word('TRIAL', `Free trial until ${feeDate(trialEnd)}`, null, trialEnd);
  const behind = status === 'PAST_DUE' || sub.isInGracePeriod === true;
  if (!due && !behind) return word('PAID', `Paid until ${next}`, sub.autoRenew === false ? `Weekly billing is stopped: you receive no work after ${next}.` : null, sub.nextBillingDate ?? null);
  if (!Number.isFinite(amountDue)) return word('UNKNOWN', 'Amount due unavailable.');
  if (!behind && amountDue <= 0) return word('COVERED', next ? `Nothing to pay for the week from ${next}` : 'Nothing to pay right now');
  const grace = at(sub.gracePeriodEnd) > now ? ` Pay by ${feeDate(sub.gracePeriodEnd)} to keep receiving work.` : '';
  return word('DUE', due && next ? `Payment due since ${next}` : 'Payment due now', `${amountDue > 0 ? `${feeMoney(amountDue)} to pay.` : ''}${grace}`.trim() || null, due ? sub.nextBillingDate ?? null : null);
}
/** The short word for a pill beside the fee, and its tone. Never the code, never "Active" on a week that is due. */
export function feeStatusPill(state: FeeStatusState): { label: string; tone: 'success' | 'warning' | 'error' | 'brand' | 'neutral' } {
  return ({
    TRIAL: { label: 'Free trial', tone: 'brand' }, PAID: { label: 'Paid', tone: 'success' }, COVERED: { label: 'Paid', tone: 'success' },
    DUE: { label: 'Payment due', tone: 'warning' }, CHECKING: { label: 'Checking payment', tone: 'warning' }, FEE_PAUSED: { label: 'Fee paused', tone: 'neutral' },
    SUSPENDED: { label: 'Suspended', tone: 'error' }, INACTIVE: { label: 'Inactive', tone: 'error' }, STOPPED: { label: 'Billing stopped', tone: 'neutral' },
    CLOSED: { label: 'Closed', tone: 'neutral' }, UNKNOWN: { label: 'Status unavailable', tone: 'neutral' },
  } as const)[state] ?? { label: 'Status unavailable', tone: 'neutral' };
}
export function subscriptionWords(status: string): string {
  return ({ TRIAL: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Weekly fee overdue', SUSPENDED: 'Account suspended', CHURNED: 'Account inactive', PAUSED: 'Weekly billing paused', CANCELLED: 'Subscription closed' } as Record<string, string>)[status] ?? 'Status unavailable';
}
export function checkoutWords(c: CheckoutStatus, returned = false): string {
  switch (c.status) {
    case 'OPEN': return returned ? 'Waiting for MMG…' : 'Finish paying on the MMG page.';
    case 'CONFIRMING': return "Confirming your payment with MMG. Don't pay again.";
    case 'CONFIRMED': return `Paid: ${feeMoney(c.amountGyd)} received${feeDate(c.confirmedAt) ? ` on ${feeDate(c.confirmedAt)}` : ''}.`;
    case 'NOT_PAID': return "MMG didn't complete this payment. You can try again.";
    case 'EXPIRED': return 'This checkout expired. If you paid, it will be credited once MMG confirms it.';
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
        this.emit({ blocked: started.status === 'CONFIRMING' || started.status === 'HELD' });
      }
      if (this.active) { this.emit({ returned: true }); this.follow(started.ref, true); }
    } catch (e) {
      if (!this.active) return;
      const f = this.failure(e);
      if (f.status && f.status < 500 && f.status !== 429) this.retryKey = undefined;
      if (f.code === 'CHECKOUT_CONFIRMING') {
        this.emit({ blocked: true, error: "We're confirming your last payment, don't pay again." });
        if (f.details?.ref) this.follow(f.details.ref, true);
      } else if (f.status === 403 || f.code === 'PAY_ACTION_OFF') {
        this.emit({ blocked: true }); this.transport.refresh();
      } else {
        this.emit({ error: f.code === 'PAY_AHEAD_LIMIT' ? 'Your next weekly fee is already paid. Swift takes the weekly fee one week at a time: you can pay again once that week has started.' : f.code === 'MMG_CHECKOUT_UNAVAILABLE' || f.status === 429 ? 'Try again in a minute.' : 'Could not open MMG. Try again.' });
        if (f.code === 'SUBSCRIPTION_NOT_FOUND') this.transport.refresh();
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
      let status: CheckoutState | undefined;
      try {
        const c = await this.transport.read(ref);
        if (!this.active || generation !== this.generation) return;
        status = c.status;
        this.emit({ checkout: c, returned, error: '', blocked: status === 'CONFIRMING' || status === 'HELD' });
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
    this.emit({ checkout: latest, blocked: latest.status === 'CONFIRMING' || latest.status === 'HELD' });
  }
  focus(latest?: CheckoutStatus | null, ref?: string) {
    const target = ref ?? latest?.ref ?? this.followingRef;
    if (target) this.follow(target, true);
  }
}
