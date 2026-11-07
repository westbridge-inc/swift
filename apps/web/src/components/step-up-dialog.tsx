'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from './modal';
import { apiFetch } from '@/lib/auth';

const RESEND_COOLDOWN_S = 60;
const CODE_LEN = 6;

/**
 * [ALG-34 · CHAINS PR2] The website's "Confirm it's you" (the phone's StepUpSheet, its words): it texts a code to
 * the phone on this account when it opens, checks six digits, and hands back through onVerified so the page runs
 * its own call again. Every error line is the server's sentence (it owns the lock, the cooldown and the budget).
 */
export default function StepUpDialog({ onVerified, onClose }: { onVerified: () => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const send = async () => {
    setBusy('send');
    setMessage(null);
    try {
      const r = await apiFetch('/api/v1/auth/step-up', { method: 'POST', body: '{}' });
      if (!live.current) return;
      setSentTo((r?.data as { sentTo?: string } | undefined)?.sentTo ?? null);
      setCooldown(RESEND_COOLDOWN_S);
    } catch (e) {
      if (live.current) setMessage(e instanceof Error && e.message ? e.message : 'We couldn’t send the code. Try again in a moment.');
    } finally {
      if (live.current) setBusy(null);
    }
  };
  // Sends once when it opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void send(); }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const verify = async (value: string) => {
    if (value.length !== CODE_LEN || busy === 'verify') return;
    setBusy('verify');
    setMessage(null);
    try {
      await apiFetch('/api/v1/auth/step-up/verify', { method: 'POST', body: JSON.stringify({ code: value }) });
      if (!live.current) return;
      setCode('');
      onVerified();
    } catch (e) {
      if (live.current) setMessage(e instanceof Error && e.message ? e.message : 'That code is not right.');
    } finally {
      if (live.current) setBusy(null);
    }
  };

  return (
    <Modal labelledBy="step-up-title" onClose={onClose} className="sw-card mx-4 flex w-full max-w-sm flex-col gap-4 p-6">
      <h2 id="step-up-title" className="text-lg font-bold">Confirm it&apos;s you</h2>
      <p className="text-sm text-[var(--swift-muted)]">
        {sentTo
          ? `To confirm this account change, we texted a code to ${sentTo}.`
          : 'To confirm this account change, we’re texting a code to the phone on this account.'}
      </p>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Code
        <input
          data-modal-initial-focus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LEN}
          value={code}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, CODE_LEN);
            setCode(v);
            if (v.length === CODE_LEN) void verify(v);
          }}
          className="rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-lg tracking-widest"
        />
      </label>
      {message && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{message}</p>}
      <button type="button" className="sw-btn sw-btn-md" disabled={code.length !== CODE_LEN || busy === 'verify'} onClick={() => void verify(code)}>
        {busy === 'verify' ? 'Checking…' : 'Confirm'}
      </button>
      <button type="button" className="sw-chip justify-center" disabled={cooldown > 0 || busy === 'send'} onClick={() => void send()}>
        {cooldown > 0 ? `Resend in ${cooldown}s` : busy === 'send' ? 'Sending…' : 'Resend code'}
      </button>
      <button type="button" className="text-sm font-semibold text-[var(--swift-muted)]" onClick={onClose}>Cancel</button>
      <p className="text-center text-xs text-[var(--swift-muted)]">Swift will never ask you for this code.</p>
    </Modal>
  );
}
