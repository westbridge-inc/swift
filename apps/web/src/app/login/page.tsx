'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { sendOtp, verifyPartnerLogin } from '@/lib/auth';
import { verifyCustomerLogin } from '@/lib/customer';
import { clearStorefrontContinuation, readStorefrontContinuation, storefrontAuthReturn } from '@/lib/storefront-continuation';
import { useStorefrontAuthJourney } from '@/lib/use-storefront-auth-journey';
import { customerRoute } from '@/lib/customer-routes';
import { AuthError, AuthHeading, AuthPage, CodeBoxes, DIAL_CODE, PhoneField, fullPhone, phoneReady } from '@/components/auth-ui';

const CUSTOMER_ROUTES = ['/order', '/cart', '/checkout', '/orders', '/taxi', '/account', '/explore', '/courier', '/store', '/stores', '/selfie', '/market'];

/** [Q7b] The customer app's Home is `/` itself — the one customer address a
 *  prefix cannot name, since every path starts with a slash. */
function isCustomerReturn(next: string): boolean {
  const path = next.split(/[?#]/)[0] ?? '';
  return path === '/' || CUSTOMER_ROUTES.some((route) => path.startsWith(route));
}

/** "Keep browsing as a guest" goes back to the page that sent them here when a
 *  guest may open it (a store, Market), and to Home when it is private. */
function guestReturn(next: string): string {
  const path = next.split(/[?#]/)[0] ?? '';
  return next && customerRoute(path).public ? next : '/';
}

function LoginInner() {
  const router = useRouter();
  const continueJourney = useStorefrontAuthJourney();
  const params = useSearchParams();
  // Only ever honour a clean in-app path as the post-login redirect. Reject
  // absolute/protocol-relative URLs and any '..' traversal so ?next= can't be an
  // open redirect to a phishing site.
  const [pendingReturn, setPendingReturn] = useState('');
  const [next, setNext] = useState('');
  const [returnReady, setReturnReady] = useState(false);
  const requestedNext = params.get('next');
  useEffect(() => {
    let alive = true;
    const direct = storefrontAuthReturn(requestedNext);
    setReturnReady(false);
    setNext(direct);
    setPendingReturn(readStorefrontContinuation()?.returnPath ?? '');
    if (direct || requestedNext !== null) setReturnReady(true);
    else void import('@/lib/basket').then(module => {
      if (!alive) return;
      setNext(module.guestBasketReturn());
      setReturnReady(true);
    }, () => {
      if (alive) setError('Your browser basket could not load. Reopen the store and try signing in again.');
    });
    return () => { alive = false; };
  }, [requestedNext]);
  const isCustomer = isCustomerReturn(next);

  const [step, setStep] = useState<'phone' | 'code'>('phone');
  // [WEB-REDESIGN] The field holds the local number beside the +592 chip;
  // the server is sent the whole number, exactly as before.
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);

  async function handleSend() {
    if (busyNow.current || !returnReady) return;
    busyNow.current = true;
    setError(null); setBusy(true);
    try { await sendOtp(fullPhone(phone)); setStep('code'); }
    catch (e) { setError((e as Error).message); }
    finally { busyNow.current = false; setBusy(false); }
  }

  async function handleVerify() {
    if (busyNow.current || !returnReady) return;
    busyNow.current = true;
    setError(null); setBusy(true);
    try {
      if (isCustomer) {
        await verifyCustomerLogin(fullPhone(phone), code.trim());
        continueJourney();
        router.replace(next || '/');
      } else {
        const { home } = await verifyPartnerLogin(fullPhone(phone), code.trim());
        router.replace(next === '/weekly-fee' ? next : home);
      }
    } catch (e) { setError((e as Error).message); }
    finally { busyNow.current = false; setBusy(false); }
  }

  const shownPhone = fullPhone(phone).replace(/^\+592/, `${DIAL_CODE} `);
  return (
    <AuthPage onBrandClick={clearStorefrontContinuation}>
      <section aria-labelledby="login-title" className="flex flex-col gap-6">
        {step === 'phone' ? (
          <>
            <AuthHeading id="login-title" eyebrow={isCustomer ? 'Sign in or create an account' : 'Swift for businesses and earners'} title="What’s your number?">
              {isCustomer ? 'We’ll text a 6-digit code to confirm it’s you.' : 'Sign in with the phone number on your Swift account. We’ll text you a 6-digit code.'}
            </AuthHeading>
            <PhoneField id="login-phone" value={phone} onChange={setPhone} onEnter={() => void handleSend()} autoFocus />
            <button type="button" onClick={() => void handleSend()} disabled={busy || !returnReady || !phoneReady(phone)} className="sw-btn sw-btn-block">
              {busy ? 'Sending…' : 'Continue'}
            </button>
          </>
        ) : (
          <>
            <AuthHeading id="login-title" eyebrow="Verify" title="Enter the code">
              Sent to {shownPhone} ·{' '}
              <button type="button" onClick={() => { setStep('phone'); setCode(''); setError(null); }} className="sw-link cursor-pointer border-0 bg-transparent p-0 text-[13px] leading-[18px]">
                Change
              </button>
            </AuthHeading>
            <CodeBoxes id="login-code" value={code} onChange={setCode} onEnter={() => void handleVerify()} />
            <button type="button" onClick={() => void handleVerify()} disabled={busy || !returnReady || code.trim().length < 6} className="sw-btn sw-btn-block">
              {busy ? 'Signing in…' : 'Verify'}
            </button>
          </>
        )}

        {error ? <AuthError>{error}</AuthError> : null}

        {pendingReturn ? (
          <Link href={pendingReturn} onClick={clearStorefrontContinuation} className="sw-link-btn self-center py-2">Cancel and return to menu</Link>
        ) : isCustomer && step === 'phone' ? (
          <Link href={guestReturn(next)} className="sw-link-btn self-center py-2">Keep browsing as a guest</Link>
        ) : null}

        <p className="sw-caption border-t border-[var(--swift-border)] pt-5">
          New to Swift?{' '}
          <Link
            href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}
            onClick={continueJourney}
            className="sw-link"
          >
            Create an account
          </Link>{' '}
          — order, sell, or drive.
        </p>
      </section>
    </AuthPage>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<main className="grid min-h-dvh place-items-center bg-[var(--swift-canvas)] text-[var(--swift-muted)]">Loading…</main>}><LoginInner /></Suspense>;
}
