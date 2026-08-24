'use client';

import { Suspense, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { sendOtp, verifyPartnerLogin } from '@/lib/auth';
import { verifyCustomerLogin } from '@/lib/customer';
import { SwiftLogo } from '@/components/swift-logo';
import styles from '../auth-flow.module.css';

const CUSTOMER_ROUTES = ['/order', '/cart', '/orders', '/taxi', '/account', '/explore', '/courier', '/store', '/stores', '/selfie'];

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  // Only ever honour a clean in-app path as the post-login redirect. Reject
  // absolute/protocol-relative URLs and any '..' traversal so ?next= can't be an
  // open redirect to a phishing site.
  const rawNext = params.get('next') ?? '';
  const next = /^\/(?!\/)/.test(rawNext) && !rawNext.includes('..') && !rawNext.includes('\\') ? rawNext : '';
  const isCustomer = CUSTOMER_ROUTES.some((r) => next.startsWith(r));

  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false);

  async function handleSend() {
    if (busyNow.current) return;
    busyNow.current = true;
    setError(null); setBusy(true);
    try { await sendOtp(phone.trim()); setStep('code'); }
    catch (e) { setError((e as Error).message); }
    finally { busyNow.current = false; setBusy(false); }
  }

  async function handleVerify() {
    if (busyNow.current) return;
    busyNow.current = true;
    setError(null); setBusy(true);
    try {
      if (isCustomer) {
        await verifyCustomerLogin(phone.trim(), code.trim());
        router.replace(next || '/order');
      } else {
        const { home } = await verifyPartnerLogin(phone.trim(), code.trim());
        router.replace(home);
      }
    } catch (e) { setError((e as Error).message); }
    finally { busyNow.current = false; setBusy(false); }
  }

  return (
    <main className={styles.page}>
      <section className={`${styles.card} ${styles.cardNarrow}`} aria-labelledby="login-title">
        <Link href="/" aria-label="Swift home" className={styles.brandLink}><SwiftLogo /></Link>
        <h1 id="login-title" className={styles.heading}>Sign in to Swift</h1>
        <p className={styles.bodyCopy}>
          {step === 'code' ? `Enter the code sent to ${phone}.`
            : isCustomer ? 'Sign in with your phone number to order on Swift.'
            : 'Businesses and earners — sign in with the phone number on your Swift account.'}
        </p>

        {step === 'phone' ? (
          <div className={styles.stack}>
            <div className={styles.field}>
              <label htmlFor="login-phone" className={styles.label}>Phone number</label>
              <input id="login-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void handleSend()}
                placeholder="+592 600 0001" className={styles.input} />
            </div>
            <button type="button" onClick={() => void handleSend()} disabled={busy || phone.trim().length < 6}
              className={styles.primaryButton}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        ) : (
          <div className={styles.stack}>
            <div className={styles.field}>
              <label htmlFor="login-code" className={styles.label}>Verification code</label>
              <input id="login-code" type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void handleVerify()}
                placeholder="000000" className={`${styles.input} ${styles.codeInput}`} />
            </div>
            <button type="button" onClick={() => void handleVerify()} disabled={busy || code.trim().length < 4}
              className={styles.primaryButton}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" onClick={() => { setStep('phone'); setCode(''); setError(null); }} className={styles.textButton}>Use a different number</button>
          </div>
        )}

        {error ? <p className={styles.error} role="alert" aria-live="assertive">{error}</p> : null}

        <p className={styles.dividerCopy}>
          New to Swift?{' '}
          <Link
            href={next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}
            className={styles.inlineLink}
          >
            Create an account
          </Link>{' '}
          — order, sell, or drive.
        </p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<main className={styles.loading}>Loading…</main>}><LoginInner /></Suspense>;
}
