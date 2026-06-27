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
    <div className="min-h-screen flex items-center justify-center bg-[#0A0A0A] text-white p-4">
      <div className="w-full max-w-sm bg-[#1C1C1E] rounded-2xl border border-[#38383A] p-8">
        <h1 className="text-2xl font-bold mb-1">
          <span className="text-[#E8192C]">Swift</span> Admin
        </h1>
        <p className="text-[#8E8E93] text-sm mb-6">
          {step === 'phone' ? 'Sign in with your admin phone number.' : `Enter the code sent to ${phone}.`}
        </p>

        {step === 'phone' ? (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-[#8E8E93]">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="+592 600 1000"
                className="mt-1 w-full bg-[#2C2C2E] text-white px-3 py-2.5 rounded-lg text-sm border border-[#38383A] focus:border-[#E8192C] focus:outline-none"
              />
            </div>
            <button
              onClick={handleSend}
              disabled={busy || phone.trim().length < 6}
              className="w-full px-4 py-2.5 bg-[#E8192C] text-white rounded-lg text-sm font-medium hover:bg-[#E8192C]/80 disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-[#8E8E93]">Verification code</label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
                placeholder="000000"
                autoFocus
                className="mt-1 w-full bg-[#2C2C2E] text-white px-3 py-2.5 rounded-lg text-sm tracking-[0.3em] text-center border border-[#38383A] focus:border-[#E8192C] focus:outline-none"
              />
            </div>
            <button
              onClick={handleVerify}
              disabled={busy || code.trim().length < 4}
              className="w-full px-4 py-2.5 bg-[#E8192C] text-white rounded-lg text-sm font-medium hover:bg-[#E8192C]/80 disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              onClick={() => {
                setStep('phone');
                setCode('');
                setError(null);
              }}
              className="w-full text-xs text-[#8E8E93] hover:text-white"
            >
              ← Use a different number
            </button>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-[#E8192C]">{error}</p>}
      </div>
    </div>
  );
}
