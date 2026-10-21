'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { restoreSession, sessionProbe, type SessionAnswer } from '@/lib/auth';
import type { ShellPerson } from '@/components/customer-shell';

// ---------------------------------------------------------------------------
// [UI-SWEEP U23] The partner consoles' sign-in gate, one copy for the store
// dashboard and the earner office. Both used to send ANY failed check to the
// sign-in page: a server hiccup (5xx) or a dropped connection signed a working
// partner out of the screen they were using. Only the server saying "no
// session" goes to /login now. When Swift cannot be reached the gate says so
// and checks again on request; nothing is cleared.
// ---------------------------------------------------------------------------

/**
 * [REVIEW-F2 #1968 S3-1] The console's session check. The access cookie lives
 * 15 minutes and the refresh cookie 30 days, so "no session" from the probe may
 * only mean an expired access cookie: the refresh cookie is spent ONCE (the
 * customer shell does the same, (app)/layout) before the caller sends anyone to
 * sign in. A check that could not reach Swift is never a sign-out.
 */
export async function checkConsoleSession(): Promise<SessionAnswer> {
  const session = await sessionProbe();
  if (session.ok || session.unreachable) return session;
  return restoreSession();
}

export type ConsoleGate =
  | { phase: 'checking' }
  | { phase: 'unreachable'; retry: () => void }
  | { phase: 'ready'; person: ShellPerson };

export function useConsoleSession(): ConsoleGate {
  const router = useRouter();
  const [gate, setGate] = useState<{ phase: 'checking' } | { phase: 'unreachable' } | { phase: 'ready'; person: ShellPerson }>({ phase: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setGate({ phase: 'checking' }); setAttempt((n) => n + 1); }, []);

  // [W-01] The session is an HttpOnly cookie the page cannot read, so the gate
  // asks the SERVER whether one exists instead of inspecting localStorage.
  useEffect(() => {
    let cancelled = false;
    void checkConsoleSession().then((session) => {
      if (cancelled) return;
      if (session.ok) {
        const name = [session.user?.['firstName'], session.user?.['lastName']].filter((v) => typeof v === 'string').join(' ');
        setGate({ phase: 'ready', person: { name, phone: null } });
      } else if (session.unreachable) setGate({ phase: 'unreachable' });
      else router.replace('/login');
    });
    return () => { cancelled = true; };
  }, [router, attempt]);

  return gate.phase === 'unreachable' ? { phase: 'unreachable', retry } : gate;
}

/** What a partner sees when the check itself failed: never a sign-out, and a way to try again. */
export function ConsoleUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="sw-page sw-empty" role="alert">
      <p className="sw-heading">Swift can&apos;t be reached right now.</p>
      <p className="sw-caption text-[15px] leading-[22px]">
        We couldn&apos;t check your sign-in. This is not a sign-out: check your connection, then try again.
      </p>
      <button type="button" onClick={onRetry} className="sw-btn sw-btn-md mt-4">Try again</button>
    </div>
  );
}
