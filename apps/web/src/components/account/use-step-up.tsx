'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiRequestError, apiFetch, captureSessionGuard, subscribeSession } from '@/lib/auth';
import { buttonClass, fieldClass, secondaryClass } from './account-frame';

export class StepUpDismissed extends Error {}
type Pending = { check: () => void; retry: () => void; dismiss: () => void };
const needsProof = (error: unknown) => error instanceof ApiRequestError && error.status === 403 && error.code === 'STEP_UP_REQUIRED';

export function useStepUp() {
  const [pending, setPending] = useState<Pending | null>(null);
  const active = useRef<Pending | null>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const set = (next: Pending | null) => { active.current = next; if (mounted.current) setPending(next); };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeSession(() => { try { active.current?.check(); } catch { active.current?.dismiss(); } });
    return () => { unsubscribe(); mounted.current = false; active.current?.dismiss(); };
  }, []);

  const withStepUp = useCallback(async <R,>(operation: () => Promise<R>): Promise<R> => {
    if (busy.current || !mounted.current) throw new StepUpDismissed();
    const check = captureSessionGuard(); busy.current = true;
    try {
      try { return await operation(); }
      catch (error) {
        if (!needsProof(error)) throw error;
        check(); if (!mounted.current) throw new StepUpDismissed();
        return await new Promise<R>((resolve, reject) => {
          const request: Pending = { check,
            retry: () => {
              if (active.current !== request || !mounted.current) return;
              set(null);
              try { check(); operation().then(resolve, reject); } catch (failure) { reject(failure); }
            },
            dismiss: () => { if (active.current === request) set(null); reject(new StepUpDismissed()); },
          };
          set(request);
        });
      }
    } finally { busy.current = false; }
  }, []);
  return { withStepUp, dialog: pending ? <Confirmation request={pending} /> : null };
}

const allowedErrors = new Set(['INVALID_CODE', 'STEP_UP_LOCKED', 'RATE_LIMITED', 'SMS_SEND_FAILED', 'COUNTRY_NOT_ACTIVE']);
function messageFor(error: unknown) {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && allowedErrors.has(error.code ?? '')
    ? error.message : 'Could not confirm right now. Please try again.';
}
function Confirmation({ request }: { request: Pending }) {
  const id = useId(); const control = useRef<HTMLButtonElement>(null); const input = useRef<HTMLInputElement>(null);
  const live = useRef(true); const sending = useRef(false);
  const [busy, setBusy] = useState(false); const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState(''); const [error, setError] = useState<string | null>(null);
  useEffect(() => { live.current = true; control.current?.focus(); return () => { live.current = false; }; }, []);
  useEffect(() => { if (sentTo) input.current?.focus(); }, [sentTo]);
  async function run(verify: boolean) {
    if (sending.current || !live.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      request.check();
      const response = await apiFetch(verify ? '/api/v1/auth/step-up/verify' : '/api/v1/auth/step-up', {
        method: 'POST', cache: 'no-store', body: JSON.stringify(verify ? { code } : {}),
      }, { redirectOnExpired: false });
      if (!live.current) return;
      request.check();
      if (verify) request.retry();
      else { setSentTo(response.data.sentTo); setCode(''); }
    } catch (failure) { if (live.current) setError(messageFor(failure)); }
    finally { sending.current = false; if (live.current) setBusy(false); }
  }
  return <div role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} className="sw-card space-y-3 p-5"
    onKeyDown={(event) => { if (event.key === 'Escape') request.dismiss(); }}>
    <h2 id={`${id}-title`} className="font-bold">Confirm it’s you</h2>
    <p id={`${id}-body`}>Confirm the code sent to your account’s phone before changing your email address.</p>
    {sentTo && <>
      <p role="status">Code sent to {sentTo}.</p>
      <label className="block space-y-1"><span>Confirmation code</span><input ref={input} className={fieldClass} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(event) => { if (event.key === 'Enter' && /^\d{6}$/.test(code)) { event.preventDefault(); void run(true); } }} /></label>
      <button type="button" className={buttonClass} disabled={busy || !/^\d{6}$/.test(code)} onClick={() => void run(true)}>{busy ? 'Confirming…' : 'Confirm and save'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button ref={control} type="button" className={secondaryClass} disabled={busy} onClick={() => void run(false)}>{sentTo ? 'Send another code' : 'Send confirmation code'}</button>
    <button type="button" className={secondaryClass} onClick={request.dismiss}>Cancel confirmation</button>
  </div>;
}
