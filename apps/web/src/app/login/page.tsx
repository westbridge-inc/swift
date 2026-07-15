'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { sendOtp, verifyPartnerLogin } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('+592');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSend() {
    setError(null);
    setBusy(true);
    try {
      await sendOtp(phone.trim());
      setStep('code');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setError(null);
    setBusy(true);
    try {
      const { home } = await verifyPartnerLogin(phone.trim(), code.trim());
      router.replace(home);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--swift-subtle)] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-black/5 bg-white p-8 shadow-sm">
        <Link href="/" className="text-xl font-extrabold tracking-tight">
          <span className="text-[var(--swift-red)]">Swift</span> <span className="font-semibold">Partners</span>
        </Link>
        <p className="mt-2 mb-6 text-sm text-[var(--swift-muted)]">
          {step === 'phone'
            ? 'Businesses and earners — sign in with the phone number on your Swift account.'
            : `Enter the code sent to ${phone}.`}
        </p>

        {step === 'phone' ? (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-[var(--swift-muted)]">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="+592 600 2000"
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2.5 text-sm focus:border-[var(--swift-red)] focus:outline-none"
              />
            </div>
            <button
              onClick={handleSend}
              disabled={busy || phone.trim().length < 6}
              className="w-full rounded-lg bg-[var(--swift-red)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-[var(--swift-muted)]">Verification code</label>
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                placeholder="000000"
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2.5 text-sm tracking-widest focus:border-[var(--swift-red)] focus:outline-none"
              />
            </div>
            <button
              onClick={handleVerify}
              disabled={busy || code.trim().length < 4}
              className="w-full rounded-lg bg-[var(--swift-red)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              onClick={() => { setStep('phone'); setCode(''); setError(null); }}
              className="w-full text-center text-xs text-[var(--swift-muted)] hover:text-[var(--swift-ink)]"
            >
              Use a different number
            </button>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-[var(--swift-red)]">{error}</p>}

        <p className="mt-6 border-t border-black/5 pt-4 text-xs text-[var(--swift-muted)]">
          New to Swift? <Link href="/for-vendors" className="font-semibold text-[var(--swift-red)]">Put your business on Swift</Link> or{' '}
          <Link href="/for-drivers" className="font-semibold text-[var(--swift-red)]">drive &amp; deliver</Link> — sign-up starts in the app.
        </p>
      </div>
    </div>
  );
}
