'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCustomerSession } from './customer-session';
import { addGuestLine, changeGuestQuantity, clearGuestBasket, guestCart, readGuestBasket, useGuestBasket } from '@/lib/basket';
import { uploadGuestBasket, type GuestMergeResult } from '@/lib/basket-merge';
import { getSessionPrincipal } from '@/lib/auth';
import { clearCart, money, readCheckoutAttempt } from '@/lib/customer';

/** Mounted once in the shell. Sign-in uploads the browser basket, but never
 * places an order. Conflicts keep both baskets intact for an explicit choice. */
export function GuestBasketSync() {
  const { status, scope } = useCustomerSession(); const queries = useQueryClient();
  const [scopedResult, setScopedResult] = useState<{ scope: string; result: Pick<GuestMergeResult, 'applied' | 'verdicts'> } | null>(null);
  const [scopedError, setScopedError] = useState<{ scope: string; message: string } | null>(null);
  const result = scopedResult?.scope === scope ? scopedResult.result : null;
  const error = scopedError?.scope === scope ? scopedError.message : null;
  const setError = useCallback((message: string | null) => setScopedError(message ? { scope, message } : null), [scope]);
  const [busy, setBusy] = useState(false); const mergeBusy = useRef(false);
  const currentScope = useRef(scope); currentScope.current = scope;
  const attempted = useRef<string | null>(null);
  const sync = useCallback(async () => {
    if (mergeBusy.current) return;
    mergeBusy.current = true;
    const commandScope = scope; const active = () => currentScope.current === commandScope;
    setBusy(true); setScopedError(null);
    try {
      const answer = await uploadGuestBasket(commandScope);
      if (!active()) return;
      setScopedResult(answer ? { scope: commandScope, result: { applied: answer.applied, verdicts: answer.verdicts } } : null);
      if (answer?.applied) await queries.invalidateQueries({ queryKey: ['customer', 'cart'] });
    } catch (e) {
      if (active()) setScopedError({ scope: commandScope, message: e instanceof Error ? e.message : 'Could not upload your basket. Retry it.' });
    } finally { mergeBusy.current = false; setBusy(false); }
  }, [scope, queries]);
  useEffect(() => {
    if (status !== 'signed-in') { attempted.current = null; setScopedResult(null); setScopedError(null); return; }
    if (busy || attempted.current === scope) return;
    if (readGuestBasket().lines.length) { attempted.current = scope; void sync(); }
  }, [status, scope, busy, sync]);
  if (!error && (!result || result.applied)) return null;
  const changedStore = result?.verdicts.some(v => v.status === 'DIFFERENT_STORE');
  const changedPrice = result?.verdicts.some(v => v.status === 'PRICE_CHANGED');
  const pricesKnown = result?.verdicts.filter(v => v.status === 'PRICE_CHANGED').every(v => typeof v.unitPrice === 'number' && Number.isSafeInteger(v.unitPrice) && v.unitPrice >= 0 && v.unitPrice <= 99999999) ?? false;
  return <section className="sw-card my-4 p-4" aria-label="Review your browser basket">
    <h2 className="font-semibold">Your basket needs a check</h2>
    <p role="alert" className="my-2">{error ?? (changedStore ? 'Your saved cart is from another store. Both baskets are unchanged.' : 'A price, choice or availability changed. Nothing from this basket was added.')}</p>
    {result ? <ul>{result.verdicts.filter(v => v.status !== 'READY').map(v => <li key={v.clientLineId}>{readGuestBasket().lines.find(l => l.clientLineId === v.clientLineId)?.name ?? 'Item'}: {v.status === 'PRICE_CHANGED' ? `now ${money(v.unitPrice)}` : v.status.replaceAll('_', ' ').toLowerCase()}</li>)}</ul> : null}
    <div className="mt-3 flex flex-wrap gap-3">
      <button className="sw-btn-primary" disabled={busy} onClick={() => void sync()}>Retry basket upload</button>
      {changedPrice ? <button className="sw-btn-secondary" disabled={busy || !pricesKnown} onClick={() => {
        const basket = readGuestBasket(); clearGuestBasket();
        for (const line of basket.lines) { const verdict = result?.verdicts.find(v => v.clientLineId === line.clientLineId); addGuestLine({ ...line, unitPrice: verdict?.unitPrice ?? line.unitPrice }); }
        void sync();
      }}>Accept current item prices</button> : null}
      {changedStore ? <>
        <button className="sw-btn-secondary" disabled={busy} onClick={() => { clearGuestBasket(); setScopedResult(null); }}>Keep saved cart</button>
        <button className="sw-btn-secondary" disabled={busy} onClick={() => { if (readCheckoutAttempt()) { setError('An earlier checkout still has an unresolved outcome. Check Orders before replacing this cart.'); return; } if (window.confirm('Replace the saved cart with this browser basket?')) void clearCart().then(sync).catch(e => setError(e.message)); }}>Replace saved cart</button>
      </> : null}
      <Link href="/cart" className="sw-btn-secondary">Review basket</Link>
    </div>
  </section>;
}
export function GuestCart() {
  const basket = useGuestBasket(); const cart = guestCart(basket); const router = useRouter();
  const { ensureSignedIn, scope } = useCustomerSession(); const queries = useQueryClient(); const [error, setError] = useState<string | null>(null);
  const subtotal = basket.lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0);
  const change = (id: string, quantity: number) => { try { changeGuestQuantity(id, quantity); } catch (e) { setError((e as Error).message); } };
  return <section className="py-6"><h1 className="sw-title">Your basket</h1>
    {!cart.items.length ? <p className="my-4">Your basket is empty. <Link href="/">Browse stores</Link></p> : <>
      <h2 className="my-4 font-semibold">{cart.vendor?.name}</h2>
      <ul className="sw-card divide-y divide-[var(--swift-border)]">{cart.items.map(l => <li className="flex items-center justify-between gap-3 p-4" key={l.id}>
        <div><p className="font-semibold">{l.name}</p><p>{money(l.customerPrice)} each</p></div>
        <div className="flex items-center gap-3"><button aria-label={`Decrease ${l.name}`} className="sw-icon-btn" onClick={() => change(l.id, l.quantity - 1)}>−</button><span>{l.quantity}</span><button aria-label={`Increase ${l.name}`} className="sw-icon-btn" onClick={() => change(l.id, l.quantity + 1)}>+</button></div>
      </li>)}</ul>
      <p className="my-4">Items estimate: {money(subtotal)}. Delivery and the final total are quoted by the server after sign-in.</p>
      <button className="sw-btn-primary" onClick={() => void ensureSignedIn().then(async ok => {
        // Back to this same page (the cart or the checkout) after the code.
        if (!ok) { router.push(`/login?next=${encodeURIComponent(window.location.pathname === '/checkout' ? '/checkout' : '/cart')}`); return; }
        try { const result = await uploadGuestBasket(getSessionPrincipal() ?? scope); if (result && !result.applied) { setError('Your basket changed. Check the items and retry the upload.'); return; }
          await queries.invalidateQueries({ queryKey: ['customer', 'cart'] }); router.refresh();
        } catch (e) { setError((e as Error).message); }
      })}>Place order</button>
    </>}{error ? <p role="alert">{error}</p> : null}
  </section>;
}
