'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendOtp, verifyOtpLogin } from '@/lib/api';

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
      await verifyOtpLogin(phone.trim(), code.trim());
      router.replace('/dashboard');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mc-page flex items-center justify-center" style={{ margin: 0, minHeight: '100dvh' }}>
      <div className="mc-card w-full max-w-sm p-8" style={{ boxShadow: '0 18px 48px rgb(33 26 26 / 10%)' }}>
        <h1 className="mc-numbers mb-1 text-2xl font-semibold" style={{ letterSpacing: '-0.02em' }}>
          <span className="text-[var(--mc-accent)]">Swift</span> Mission Control
        </h1>
        <p className="mc-muted mb-6">
          {step === 'phone' ? 'Sign in with your admin phone number.' : `Enter the code sent to ${phone}.`}
        </p>

        {step === 'phone' ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="login-phone" className="text-xs font-semibold">Phone</label>
              <input
                id="login-phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="+592 600 1000"
                className="mc-input mt-1"
              />
            </div>
            <button
              onClick={handleSend}
              disabled={busy || phone.trim().length < 6}
              className="mc-btn mc-btn-primary w-full"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label htmlFor="login-code" className="text-xs font-semibold">Verification code</label>
              <input
                id="login-code"
                type="text"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                placeholder="000000"
                autoFocus
                className="mc-input mc-numbers mt-1 text-center tracking-[0.3em]"
              />
            </div>
            <button
              onClick={handleVerify}
              disabled={busy || code.trim().length < 4}
              className="mc-btn mc-btn-primary w-full"
            >
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              onClick={() => {
                setStep('phone');
                setCode('');
                setError(null);
              }}
              className="mc-btn mc-btn-quiet w-full"
            >
              ← Use a different number
            </button>
          </div>
        )}

        {error && <p role="alert" className="mc-alert mt-4">{error}</p>}
      </div>
    </div>
  );
}
