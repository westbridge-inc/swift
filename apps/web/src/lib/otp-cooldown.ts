import { useEffect, useState } from 'react';

/**
 * [SIGNUP-PHONE · owner 1 Nov 2026] A code asked for moments ago holds the next one back for a few seconds. That is
 * not an error: the send button counts down ("Send a new code in 35 s") and opens again by itself.
 */
export function useSendCooldown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until, now]);
  const secondsLeft = Math.max(0, Math.ceil((until - now) / 1000));
  const start = (seconds: number) => { const at = Date.now(); setNow(at); setUntil(at + seconds * 1000); };
  return { secondsLeft, start };
}

/** A refused send that only asks to wait: how long, and whether the code sent moments ago is already on its way. */
export function sendCooldownOf(error: unknown): { seconds: number; codeAlreadySent: boolean } | null {
  const e = error as { status?: unknown; retryAfterSeconds?: unknown; codeAlreadySent?: unknown } | null;
  if (!e || e.status !== 429 || typeof e.retryAfterSeconds !== 'number' || !(e.retryAfterSeconds > 0)) return null;
  return { seconds: Math.ceil(e.retryAfterSeconds), codeAlreadySent: e.codeAlreadySent === true };
}

export const sendLabel = (secondsLeft: number, idle: string) => (secondsLeft > 0 ? `Send a new code in ${secondsLeft} s` : idle);
