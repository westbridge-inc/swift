'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { ApiRequestError, apiFetch } from '@/lib/auth';
import {
  CARD_CONSENT_VERSION, CARD_IDLE, CARD_TEST_LABEL, CardCheckoutSession, cardExpiry, cardLabel, cardMoney, cardPageReopenable, cardPaymentPending,
  cardRemovedWords, cardSessionTone, cardSessionWords, cardSpoken, type CardCheckoutView, type CardFamily, type CardPointer, type LiveCard,
} from '@/lib/card-fee';

// This tab's last card session: its id and its tap's key, never the page address. The
// checkout-attempt prefix is the one auth.ts clears on every sign-in, sign-out and account change.
const POINTER_PREFIX = 'swift_web_checkout_attempt:card-fee';
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function pointers(family: CardFamily, storeId: string | null) {
  const key = `${POINTER_PREFIX}:${family}:${storeId ?? 'none'}`;
  return {
    save(pointer: CardPointer | null) {
      try {
        if (pointer) window.sessionStorage.setItem(key, JSON.stringify(pointer));
        else window.sessionStorage.removeItem(key);
      } catch { /* Storage may be off: the session is still followed while this page is open. */ }
    },
    load(): CardPointer | null {
      try {
        const p = JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as Partial<CardPointer> | null;
        if (p && typeof p.sessionId === 'string' && ID.test(p.sessionId) && (p.purpose === 'ENROLL' || p.purpose === 'PAY_NOW') && typeof p.key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(p.key)) {
          return { sessionId: p.sessionId, purpose: p.purpose, key: p.key };
        }
      } catch { /* Unreadable: nothing to follow. */ }
      return null;
    },
  };
}

/** The words are the first signal; the tint is only the second. */
const TONE = {
  success: 'bg-[color-mix(in_srgb,var(--swift-success)_12%,white)]',
  error: 'bg-[color-mix(in_srgb,var(--swift-error)_10%,white)]',
  waiting: 'bg-[color-mix(in_srgb,var(--swift-warning)_14%,white)]',
  neutral: 'bg-[var(--swift-canvas)]',
} as const;

/**
 * "Pay by card" on the one weekly-fee page (CARD-CHECKOUT-API). Shown only when the server says
 * CARD is live, or while a card payment this tab started is still being answered. The card number
 * is typed only on the bank's hosted page, opened in this tab; this page has no card field at all.
 */
export function CardPay({ family, storeId, card, otherPaymentPending, refresh, onPaymentPending }: {
  family: CardFamily;
  storeId: string | null;
  card?: LiveCard;
  /** An MMG payment is being confirmed: no second payment is offered. */
  otherPaymentPending: boolean;
  refresh: () => void;
  onPaymentPending: (_pending: boolean) => void;
}) {
  const [view, setView] = useState<CardCheckoutView>(CARD_IDLE);
  const [consent, setConsent] = useState(false);
  const [removing, setRemoving] = useState<'ask' | 'busy' | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [removeNotice, setRemoveNotice] = useState('');
  const base = `/api/v1/${family}/subscription`;
  // The parent hears "a card payment may be taking money" in the same render as the words, never a frame later.
  const pendingRef = useRef(onPaymentPending); pendingRef.current = onPaymentPending;
  const session = useMemo(() => {
    const stored = pointers(family, storeId);
    return new CardCheckoutSession({
      start: (purpose, key) => apiFetch(`${base}/card-sessions`, {
        method: 'POST',
        body: JSON.stringify(purpose === 'ENROLL' ? { purpose, consentVersion: CARD_CONSENT_VERSION } : { purpose }),
        headers: { 'Idempotency-Key': key },
      }, { storeId }).then((r) => r.data),
      read: (sessionId) => apiFetch(`${base}/card-sessions/${encodeURIComponent(sessionId)}`, undefined, { storeId }).then((r) => r.data),
      open: async (url) => { window.location.assign(url); },
      refresh,
      save: stored.save,
      load: stored.load,
    }, () => crypto.randomUUID(), (v) => {
      setView(v);
      pendingRef.current(cardPaymentPending(v.session) || v.busy === 'PAY_NOW');
    }, (e) => (e instanceof ApiRequestError ? { status: e.status, code: e.code } : {}));
  }, [base, family, storeId, refresh]);
  useEffect(() => { session.activate(); session.resume(); return () => session.dispose(); }, [session]);
  useEffect(() => {
    const focus = () => session.focus();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [session]);
  const pending = cardPaymentPending(view.session) || view.busy === 'PAY_NOW';
  useEffect(() => { onPaymentPending(pending); }, [pending, onPaymentPending]);

  const live = card && !view.off ? card : undefined;
  if (!live && !view.session && !view.error && !removeNotice) return null;
  const onFile = live?.cardOnFile ?? null;
  const testLabel = live?.testMode ? live.testModeLabel : view.session?.testMode ? view.session.testModeLabel ?? CARD_TEST_LABEL : '';
  const enrolling = view.session?.purpose === 'ENROLL' && view.session.status === 'OPEN';
  const canPay = !!live && !pending && !otherPaymentPending && !view.busy;
  const remove = async () => {
    if (!onFile) return;
    setRemoving('busy'); setRemoveError(''); setRemoveNotice('');
    try {
      const answer = await apiFetch(`${base}/cards/${encodeURIComponent(onFile.id)}`, { method: 'DELETE' }, { storeId });
      setRemoving(null);
      setRemoveNotice(cardRemovedWords(answer?.data));
      refresh();
    } catch (e) {
      setRemoving(null);
      setRemoveError(e instanceof ApiRequestError && e.code === 'STEP_UP_REQUIRED'
        ? "To remove this card, confirm it's you in the Swift app: open Weekly fee there and remove it."
        : "Couldn't remove the card. Try again.");
    }
  };
  const button = 'inline-flex min-h-12 w-full items-center justify-center rounded-full px-6 py-3 font-bold disabled:opacity-50';
  return <section aria-labelledby="card-pay-title" className="flex flex-col gap-4 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--swift-red-50)] text-[var(--swift-red-600)]"><CreditCard className="h-5 w-5" /></span>
      <div className="min-w-0">
        <h3 id="card-pay-title" className="text-lg font-bold">{live ? 'Pay by card (Visa / Mastercard)' : 'Card payment'}</h3>
        {live && <p className="text-sm text-[var(--swift-muted)]">You type your card on the bank&apos;s secure card page. Swift never sees or keeps your card number.</p>}
      </div>
    </div>
    {testLabel && <p className="self-start rounded-full bg-[color-mix(in_srgb,var(--swift-warning)_14%,transparent)] px-3 py-1 text-xs font-bold uppercase tracking-wide text-[var(--swift-ink)]">{testLabel}</p>}
    {onFile && <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--swift-canvas)] p-4">
      <div className="min-w-0 flex-1">
        <p className="font-semibold"><span aria-hidden="true">{cardLabel(onFile)}</span><span className="sr-only">{cardSpoken(onFile)}</span></p>
        <p className="text-sm text-[var(--swift-muted)]">{cardExpiry(onFile)} · Charged for your weekly fee</p>
      </div>
      {removing === 'ask' ? <div role="group" aria-label="Remove this card?" className="flex flex-wrap gap-2">
        <p className="w-full text-sm">{cardLabel(onFile)} will not be charged again. Your weekly fee stays due until you pay it another way.</p>
        <button type="button" onClick={() => void remove()} className="min-h-11 rounded-full bg-[var(--swift-error)] px-4 text-sm font-bold text-white">Remove card</button>
        <button type="button" onClick={() => setRemoving(null)} className="min-h-11 rounded-full border border-black/10 bg-white px-4 text-sm font-semibold">Keep card</button>
      </div> : <button type="button" disabled={removing === 'busy'} onClick={() => setRemoving('ask')} className="min-h-11 rounded-full border border-black/10 bg-white px-4 text-sm font-semibold disabled:opacity-50">
        {removing === 'busy' ? 'Removing…' : 'Remove card'}
      </button>}
    </div>}
    {removeError && <p role="alert" className="text-sm font-semibold text-[var(--swift-error)]">{removeError}</p>}
    {removeNotice && <p role="status" className="rounded-xl bg-[var(--swift-canvas)] px-4 py-3 font-semibold">{removeNotice}</p>}
    {view.session && <p role="status" className={`rounded-xl px-4 py-3 font-semibold ${TONE[cardSessionTone(view.session)]}`}>{cardSessionWords(view.session, view.returned)}</p>}
    {view.error && <p role="alert" className="text-sm font-semibold text-[var(--swift-error)]">{view.error}</p>}
    {live && view.returned && cardPageReopenable(view.session) && <button type="button" disabled={!!view.busy} onClick={() => void session.reopen()} className={`${button} bg-[var(--swift-red-50)] text-[var(--swift-red-600)]`}>Continue on the card page</button>}
    {(canPay || view.busy === 'PAY_NOW') && live && <button type="button" disabled={!canPay} onClick={() => void session.start('PAY_NOW')} className={`${button} bg-[var(--swift-ink)] text-white`}>
      {view.busy === 'PAY_NOW' ? 'Opening the card page…' : `Pay ${cardMoney(live.payNow.amount, live.payNow.currencyCode)} by card`}
    </button>}
    {live?.addCard && !enrolling && !pending && !consent && !view.busy && <button type="button" onClick={() => setConsent(true)} className={`${button} border border-black/10 bg-white`}>
      {onFile ? 'Change card' : 'Use a card for the weekly fee'}
    </button>}
    {live?.addCard && (consent || view.consent) && <div role="group" aria-labelledby="card-consent-title" className="space-y-3 rounded-xl bg-[var(--swift-red-50)] p-4">
      <p id="card-consent-title" className="font-semibold">Charge this card each week?</p>
      <p className="text-sm">Swift will charge the card you add for your weekly fee each week, when it is due, until you remove it. Your bank may ask you to confirm a charge. You can remove the card here at any time.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={view.busy === 'ENROLL'} onClick={() => { setConsent(false); void session.start('ENROLL'); }} className="min-h-11 rounded-full bg-[var(--swift-red)] px-5 text-sm font-bold text-white disabled:opacity-50">Agree and add a card</button>
        <button type="button" onClick={() => setConsent(false)} className="min-h-11 rounded-full border border-black/10 bg-white px-5 text-sm font-semibold">Not now</button>
      </div>
    </div>}
  </section>;
}
