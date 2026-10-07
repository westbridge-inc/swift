// CARD-CHECKOUT-API (the PT-2 contract): the card half of the one weekly-fee page.
// Kept identical across the two independently built apps (a census compares the bytes).
// No card number, security code or PIN ever passes through this code. The card is typed
// only on the hosted page the server opens; Swift shows a card as brand, last 4 and expiry.
export type CardFamily = 'vendor' | 'rider' | 'driver';
export type CardPurpose = 'ENROLL' | 'PAY_NOW';
export type CardStatus = 'ACTIVE' | 'REPLACED' | 'EXPIRED' | 'REVOKED';
export type CardSessionState = 'OPEN' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'HELD';
export interface CardView { id: string; brand: string; last4: string; expMonth: number; expYear: number; status: CardStatus }
/** The CARD entry of payActions, once the server says it is live and its shape is whole. */
export interface LiveCard {
  payNow: { amount: number; currencyCode: string };
  addCard: boolean;
  cardOnFile: CardView | null;
  testMode: boolean;
  testModeLabel: string;
}
export interface CardSessionStart {
  sessionId: string; purpose: CardPurpose; status: 'OPEN'; hostedUrl: string; expiresAt: string;
  amount?: number; currencyCode?: string; testMode: boolean; testModeLabel?: string;
}
export interface CardSessionView {
  sessionId: string; purpose: CardPurpose; status: CardSessionState; expiresAt: string;
  amount?: number; currencyCode?: string; card?: CardView; settlement?: 'advanced' | 'banked';
  subscriptionStatus?: string; testMode: boolean; testModeLabel?: string;
}
/** The weekly-charge consent the partner accepts on screen before adding a card. */
export const CARD_CONSENT_VERSION = 'card-on-file-v1';
export const CARD_RETURN = 'swift://pay/card/return';
export const CARD_TEST_LABEL = 'Test mode: no real card is charged.';
const STATUSES: readonly string[] = ['ACTIVE', 'REPLACED', 'EXPIRED', 'REVOKED'];
const SESSION_STATES: readonly string[] = ['OPEN', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'HELD'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
/** A card as the server described it, or null when any part is missing or malformed. */
export function cardOf(v: unknown): CardView | null {
  if (!record(v)) return null;
  const { id, brand, last4, expMonth, expYear, status } = v;
  if (!text(id) || !text(brand, 40) || typeof last4 !== 'string' || !/^\d{4}$/.test(last4)) return null;
  if (typeof expMonth !== 'number' || !Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) return null;
  if (typeof expYear !== 'number' || !Number.isInteger(expYear) || expYear < 2000 || expYear > 2199) return null;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  return { id, brand, last4, expMonth, expYear, status: status as CardStatus };
}
/** The card choice exists only when the server says CARD is live, with a whole price.
 *  Off, absent, unknown or malformed is hidden: never a disabled or teased button. */
export function liveCard(payActions: unknown): LiveCard | undefined {
  if (!Array.isArray(payActions)) return undefined;
  const action: unknown = payActions.find((a) => record(a) && a['id'] === 'CARD');
  if (!record(action) || action['state'] !== 'live') return undefined;
  const payNow = action['payNow'];
  if (!record(payNow)) return undefined;
  const amount = payNow['amount'];
  const currencyCode = payNow['currencyCode'];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) return undefined;
  const onFile = cardOf(action['cardOnFile']);
  const testMode = action['testMode'] === true;
  const label = action['testModeLabel'];
  return {
    payNow: { amount, currencyCode },
    addCard: action['addCard'] === true,
    cardOnFile: onFile?.status === 'ACTIVE' ? onFile : null,
    testMode,
    testModeLabel: testMode ? (text(label) ? label : CARD_TEST_LABEL) : '',
  };
}
export function cardMoney(amount: number, currencyCode: string): string {
  const grouped = amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return currencyCode === 'GYD' ? `GY$${grouped}` : `${currencyCode} ${grouped}`;
}
const BRANDS: Record<string, string> = { VISA: 'Visa', MASTERCARD: 'Mastercard', MC: 'Mastercard', SIMULATED: 'Test card' };
/** Only the brands Swift knows by name; anything else is just "Card". */
export function cardBrand(brand: string): string {
  return BRANDS[brand.toUpperCase().replace(/[^A-Z]/g, '')] ?? 'Card';
}
export const cardLabel = (c: CardView) => `${cardBrand(c.brand)} •••• ${c.last4}`;
/** What a screen reader says for cardLabel. */
export const cardSpoken = (c: CardView) => `${cardBrand(c.brand)} ending in ${c.last4}`;
export const cardExpiry = (c: CardView) => `Expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`;
export function cardSessionOf(v: unknown): CardSessionView | null {
  if (!record(v)) return null;
  const { sessionId, purpose, status, expiresAt, amount, currencyCode, settlement, subscriptionStatus, testModeLabel } = v;
  if (!text(sessionId) || (purpose !== 'ENROLL' && purpose !== 'PAY_NOW')) return null;
  if (typeof status !== 'string' || !SESSION_STATES.includes(status) || typeof expiresAt !== 'string') return null;
  const card = cardOf(v['card']);
  return {
    sessionId, purpose, status: status as CardSessionState, expiresAt,
    ...(typeof amount === 'number' && Number.isFinite(amount) ? { amount } : {}),
    ...(typeof currencyCode === 'string' && /^[A-Z]{3}$/.test(currencyCode) ? { currencyCode } : {}),
    ...(card ? { card } : {}),
    ...(settlement === 'advanced' || settlement === 'banked' ? { settlement } : {}),
    ...(typeof subscriptionStatus === 'string' ? { subscriptionStatus } : {}),
    testMode: v['testMode'] === true,
    ...(text(testModeLabel) ? { testModeLabel } : {}),
  };
}
/** The words for a session, from the server's status only. Never "paid" or "added" before SUCCEEDED. */
export function cardSessionWords(s: CardSessionView, returned = false): string {
  const enroll = s.purpose === 'ENROLL';
  switch (s.status) {
    case 'OPEN': return returned ? 'Checking with the bank…' : "Finish on the card page. If your bank asks you to confirm it's you (3-D Secure), do it there.";
    case 'UNKNOWN': return "Checking with the bank. Don't pay again.";
    case 'SUCCEEDED':
      if (enroll) return s.card ? `Card added: ${cardLabel(s.card)}.` : 'Card added.';
      if (s.settlement === 'banked') return 'Payment received and added to your balance.';
      return s.amount != null && s.currencyCode ? `Paid: ${cardMoney(s.amount, s.currencyCode)} received.` : 'Paid: payment received.';
    case 'FAILED': return enroll
      ? 'The card was not added: the bank declined it, or the card has expired.'
      : "The payment didn't go through: the bank declined it, or the card has expired. You can try again.";
    case 'EXPIRED': return enroll ? 'This card page expired. You can start again.' : 'This card page expired. If you paid, it will be credited once the bank confirms it.';
    case 'CANCELLED': return "The card page couldn't open. Try again in a moment.";
    case 'HELD': return enroll
      ? "We're checking this card by hand. Support will contact you."
      : "We're checking this payment by hand. Don't pay again. Support will contact you.";
  }
}
/** How a session's words are drawn. The words are the first signal; the tone is only the second. */
export function cardSessionTone(s: Pick<CardSessionView, 'status'>): 'success' | 'error' | 'waiting' | 'neutral' {
  if (s.status === 'SUCCEEDED') return 'success';
  if (s.status === 'FAILED' || s.status === 'CANCELLED') return 'error';
  if (s.status === 'OPEN' || s.status === 'UNKNOWN' || s.status === 'HELD') return 'waiting';
  return 'neutral';
}
/** Section 6's cadence: every 3 s for a minute, then every 15 s to 11 minutes. UNKNOWN, and
 *  EXPIRED after a Pay now, are not final for money and keep being asked. */
export function cardPollDelay(elapsed: number, s?: Pick<CardSessionView, 'status' | 'purpose'>): number | null {
  const state = s?.status;
  if (state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'HELD') return null;
  if (state === 'EXPIRED' && s?.purpose === 'ENROLL') return null;
  if (elapsed >= 660_000) return null;
  return elapsed < 60_000 ? 3_000 : 15_000;
}
/** A Pay now that may still take money: every pay button stays hidden until it settles. */
export function cardPaymentPending(s?: CardSessionView | null): boolean {
  return s?.purpose === 'PAY_NOW' && (s.status === 'OPEN' || s.status === 'UNKNOWN' || s.status === 'HELD');
}
/** The open card page can be shown again (the same session) until its window closes. */
export function cardPageReopenable(s: CardSessionView | null | undefined, now = Date.now()): boolean {
  return s?.status === 'OPEN' && Date.parse(s.expiresAt) > now;
}
/** What a removal answered: a charge already sent to the bank before it finishes, and is never repeated. */
export function cardRemovedWords(answer: unknown): string {
  return record(answer) && answer['paymentInProgress'] === true
    ? 'Card removed. A payment already on its way will finish. Nothing more will be charged to this card.'
    : 'Card removed. Nothing more will be charged to it.';
}
export interface CardFailure { status?: number; code?: string }
/** The last session this screen started: its id and its tap's key. Never its page address. */
export interface CardPointer { sessionId: string; purpose: CardPurpose; key: string }
export interface CardTransport {
  start(_purpose: CardPurpose, _key: string): Promise<CardSessionStart>;
  read(_sessionId: string): Promise<CardSessionView>;
  open(_url: string): Promise<unknown>;
  refresh(): void;
  save(_pointer: CardPointer | null): void;
  load(): CardPointer | null;
}
export interface CardCheckoutView {
  session: CardSessionView | null; returned: boolean; busy: CardPurpose | null; error: string;
  /** The server refused cards here: hide every card action until the subscription says otherwise. */
  off: boolean;
  /** An Add card was refused for want of the accepted consent: show it again. */
  consent: boolean;
}
const POLL_ERROR = 'Could not check your card payment. Refresh to try again.';
export const CARD_IDLE: CardCheckoutView = { session: null, returned: false, busy: null, error: '', off: false, consent: false };
function failureWords(f: CardFailure): string {
  if (f.code === 'CARD_SESSION_UNAVAILABLE' || f.status === 502) return "The card page couldn't open. Try again in a moment.";
  if (f.code === 'RATE_LIMITED' || f.status === 429) return 'Too many tries. Wait a minute and try again.';
  return "Couldn't open the card page. Try again.";
}
/** Owns one screen lifetime. A browser result, a return page or a push never becomes payment state:
 *  only the server's read of the session does. The server's error text is never shown as is. */
export class CardCheckoutSession {
  private active = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private retryKey: Partial<Record<CardPurpose, string>> = {};
  private pointer: CardPointer | null = null;
  private view: CardCheckoutView = CARD_IDLE;
  private transport: CardTransport;
  private key: () => string;
  private changed: (_view: CardCheckoutView) => void;
  private failure: (_error: unknown) => CardFailure;
  constructor(transport: CardTransport, key: () => string, changed: (_view: CardCheckoutView) => void, failure: (_error: unknown) => CardFailure) {
    this.transport = transport; this.key = key; this.changed = changed; this.failure = failure;
  }
  private emit(patch: Partial<CardCheckoutView>) { if (this.active) { this.view = { ...this.view, ...patch }; this.changed(this.view); } }
  activate() { this.active = true; }
  dispose() { this.active = false; this.generation++; clearTimeout(this.timer); }
  /** Follow the session this screen (or, on the web, this tab) started before the card page. */
  resume() {
    const p = this.pointer ?? this.transport.load();
    if (p) { this.pointer = p; this.follow(p.sessionId, true); }
  }
  focus() { this.resume(); }
  /** ENROLL is called only after the partner accepted the consent on screen. */
  async start(purpose: CardPurpose) {
    if (!this.active || this.view.busy || this.view.off) return;
    if (purpose === 'PAY_NOW' && cardPaymentPending(this.view.session)) return;
    this.emit({ busy: purpose, error: '', consent: false });
    const key = (this.retryKey[purpose] ??= this.key());
    try {
      const started = await this.transport.start(purpose, key);
      if (!this.active) return;
      delete this.retryKey[purpose];
      await this.openPage(started, key);
    } catch (e) {
      if (this.active) this.failed(e, purpose);
    } finally { this.emit({ busy: null }); }
  }
  /** "Continue on the card page": the same tap again, with its own key, so the server hands
   *  back the same open session and never opens a second one. */
  async reopen() {
    const p = this.pointer;
    if (!this.active || this.view.busy || this.view.off || !p || this.view.session?.sessionId !== p.sessionId || !cardPageReopenable(this.view.session)) return;
    this.emit({ busy: p.purpose, error: '' });
    try {
      const started = await this.transport.start(p.purpose, p.key);
      if (!this.active) return;
      await this.openPage(started, p.key);
    } catch (e) {
      if (this.active) this.failed(e, p.purpose);
    } finally { this.emit({ busy: null }); }
  }
  private async openPage(started: CardSessionStart, key: string) {
    const shown = cardSessionOf({ ...started, status: 'OPEN' });
    if (!shown) throw new Error('Unreadable card session');
    this.pointer = { sessionId: shown.sessionId, purpose: shown.purpose, key };
    this.transport.save(this.pointer);
    this.emit({ session: shown, returned: false });
    // The page's address is used here, once, and never kept. A card page is only ever https.
    const url = started.hostedUrl;
    if (typeof url === 'string' && (/^https:\/\//i.test(url) || started.testMode === true)) {
      try { await this.transport.open(url); } catch { /* Follow even when the browser cannot finish. */ }
    }
    if (this.active) { this.emit({ returned: true }); this.follow(shown.sessionId, true); }
  }
  private failed(e: unknown, purpose: CardPurpose) {
    const f = this.failure(e);
    if (f.status && f.status < 500 && f.status !== 429) delete this.retryKey[purpose];
    if (f.code === 'CARD_CONSENT_REQUIRED') { this.emit({ consent: true, error: 'Agree to the weekly card charge to add a card.' }); return; }
    if (f.code === 'CARD_RAIL_DISABLED' || f.status === 503) { this.emit({ off: true, error: 'Card payments are paused right now. Please use another way to pay.' }); this.transport.refresh(); return; }
    if (f.code === 'REVIEW_DEMO_NO_MONEY') { this.emit({ off: true, error: "This demo account can't make payments." }); return; }
    if (f.code === 'PAY_ACTION_OFF' || f.status === 403) { this.emit({ off: true }); this.transport.refresh(); return; }
    if (f.code === 'ADD_CARD_OFF') { this.emit({ error: "Saving a card isn't available. You can still pay now by card." }); this.transport.refresh(); return; }
    if (f.code === 'PAYMENT_CONFIRMING') { this.emit({ error: "We're checking a payment. Don't pay again." }); this.transport.refresh(); return; }
    if (f.code === 'MOVER_FEE_PRICE_CHANGED') { this.emit({ error: 'Your weekly fee changed. Check the new amount and try again.' }); this.transport.refresh(); return; }
    if (f.code === 'MOVER_FEE_REVIEW_REQUIRED') { this.emit({ error: 'Your weekly fee needs a check by our team first. Support will contact you.' }); this.transport.refresh(); return; }
    if (f.code === 'CARD_SESSION_OPEN') {
      this.emit({ error: 'A card page is already open. Finish it there, or wait until it expires.' });
      if (this.pointer?.purpose === purpose) this.follow(this.pointer.sessionId, true);
      return;
    }
    if (f.code === 'NOTHING_TO_PAY') { this.emit({ error: "There's nothing to pay right now." }); this.transport.refresh(); return; }
    if (f.code === 'SUBSCRIPTION_CLOSED' || f.code === 'SUBSCRIPTION_NOT_FOUND') { this.emit({ error: "Couldn't find a weekly fee to pay. Refresh to try again." }); this.transport.refresh(); return; }
    this.emit({ error: failureWords(f) });
  }
  follow(sessionId: string, returned = false) {
    if (!this.active) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const start = Date.now();
    const stale = () => !this.active || generation !== this.generation;
    const tick = async () => {
      if (stale()) return;
      let seen: CardSessionView | null = null;
      try {
        seen = cardSessionOf(await this.transport.read(sessionId));
        if (stale()) return;
        if (!seen || seen.sessionId !== sessionId) throw new Error('Unreadable card session');
        const final = cardPollDelay(0, seen) === null;
        // A start's error (an open page, a pause) stays until the session it is about settles.
        this.emit({ session: seen, returned, ...(final || this.view.error === POLL_ERROR ? { error: '' } : {}) });
        if (final) this.transport.refresh();
      } catch (e) {
        if (stale()) return;
        if (this.failure(e).status === 404) {
          // Unknown here, or not this partner's: nothing to follow, and nothing is shown.
          if (this.pointer?.sessionId === sessionId) { this.pointer = null; this.transport.save(null); }
          this.emit({ session: null, returned: false });
          return;
        }
        this.emit({ error: POLL_ERROR });
      }
      if (stale()) return;
      const delay = cardPollDelay(Date.now() - start, seen ?? undefined);
      if (delay !== null) this.timer = setTimeout(tick, delay);
    };
    void tick();
  }
}
