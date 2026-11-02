'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clearSession, restoreSession, sessionProbe } from '@/lib/auth';
import { signedInBefore } from '@/lib/session-hint';
import { endErasedSession, readDeletionReceipt } from '@/lib/account-deletion';
import { DELETION_KEPT } from '@/lib/account-deletion-words';

// ---------------------------------------------------------------------------
// [WEB-DELETE] "Your account is deleted". The server ended every session when it closed the account; this page
// asks the server first, the way the consoles do (lib/auth sessionProbe, then restoreSession: the access cookie lives
// fifteen minutes, the refresh cookie a month). Only when the refresh too says no session is left does it expire this
// browser's cookies. It says the account was deleted only with the server's receipt that the delete flow handed over
// in this tab: a bare link (?status=...) shows the neutral words. A browser still signed in was not deleted: it is
// told so, and nobody is ever signed out by opening a link to this page. [REVIEW-G/F #2304 S2]
// ---------------------------------------------------------------------------

/** The app's and the server's words for each receipt (apps/mobile PersonalDataScreen, account.service.ts). */
const RECEIPT_WORDS: Record<string, string> = {
  DELETED: 'Your account has been deleted.',
  PENDING_SAFETY_HOLD: 'Your account is closed. Limited safety evidence remains protected while the open case is resolved.',
  PENDING_DOCUMENT_ERASURE: 'Your account is closed. Some personal-data erasure is pending; no further sign-in is needed.',
  PENDING_ACCOUNT_ERASURE: 'Your account is closed. Personal-data erasure is pending and will be retried automatically; no further sign-in is needed.',
  PENDING_LEGAL_HOLD: 'Your account is closed. Documents required by a legal hold remain protected until the hold is released; other pending erasure will be retried automatically.',
};

type View = { phase: 'checking' } | { phase: 'unreachable' } | { phase: 'signed-in' } | { phase: 'done'; status: string | null; message: string | null };

export function DeletionReceiptView() {
  const [view, setView] = useState<View>({ phase: 'checking' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      let answer = await sessionProbe();
      // An expired access cookie is not "signed out": spend the refresh cookie once, as the consoles do.
      if (!answer.ok && !answer.unreachable) answer = await restoreSession();
      if (!live) return;
      if (answer.ok) { setView({ phase: 'signed-in' }); return; }
      // Not an answer about the session: nothing is cleared on a guess.
      if (answer.unreachable) { setView({ phase: 'unreachable' }); return; }
      const stashed = readDeletionReceipt();
      const status = stashed?.status ?? null;
      // [FLOW-QA2 NEW-3] Only a browser that holds Swift's cookies has any to expire: the delete flow in this tab (its
      // receipt) or a browser that signed in before. A visitor that never signed in sends nothing (the server would
      // refuse an empty sign-out with no cookie to read); the local sign-out still happens.
      if (stashed || signedInBefore()) await endErasedSession();
      else clearSession();
      if (live) setView({ phase: 'done', status: status && RECEIPT_WORDS[status] ? status : null, message: stashed?.message ?? null });
    })();
    return () => { live = false; };
  }, [attempt]);

  if (view.phase === 'checking') return <p role="status" className="text-[var(--swift-muted)]">Checking…</p>;
  if (view.phase === 'unreachable') {
    return (
      <>
        <h1 className="text-4xl font-extrabold tracking-tight">Your Swift account</h1>
        <p role="alert" className="mt-4 text-lg">Swift can’t be reached right now. Check your connection and try again.</p>
        <button type="button" className="sw-btn sw-btn-md mt-6" onClick={() => { setView({ phase: 'checking' }); setAttempt((n) => n + 1); }}>Try again</button>
      </>
    );
  }
  if (view.phase === 'signed-in') {
    return (
      <>
        <h1 className="text-4xl font-extrabold tracking-tight">Your account is still open</h1>
        <p className="mt-4 text-lg text-[var(--swift-muted)]">This browser is still signed in to a Swift account, so nothing was deleted here.</p>
        <p className="mt-6"><Link className="underline" href="/account/delete">How to delete your Swift account</Link></p>
      </>
    );
  }
  if (!view.status) {
    return (
      <>
        <h1 className="text-4xl font-extrabold tracking-tight">Your Swift account</h1>
        <p className="mt-4 text-lg text-[var(--swift-muted)]">This browser is not signed in to Swift. There is no account deletion to show here.</p>
        <p className="mt-6"><Link className="underline" href="/account/delete">How to delete your Swift account</Link></p>
      </>
    );
  }
  const deleted = view.status === 'DELETED' || view.status === 'PENDING_SAFETY_HOLD';
  return (
    <>
      <h1 className="text-4xl font-extrabold tracking-tight">{deleted ? 'Your account is deleted' : 'Your account is closed'}</h1>
      <p role="status" className="mt-4 text-lg">{view.message ?? RECEIPT_WORDS[view.status]}</p>
      <p className="mt-3 text-[var(--swift-muted)]">You are signed out of Swift in this browser and on every other device. Thank you for using Swift.</p>
      <h2 className="mt-10 text-2xl font-bold tracking-tight">What Swift keeps, and for how long</h2>
      <dl className="mt-4 space-y-4">
        {DELETION_KEPT.map((row) => (
          <div key={row.what}>
            <dt className="font-semibold text-[var(--swift-ink)]">{row.what}</dt>
            <dd className="mt-1 text-[var(--swift-muted)]">{row.why} {row.howLong}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-8 text-[var(--swift-muted)]">
        Questions about your data? Email <a className="underline" href="mailto:privacy@swiftgy.com">privacy@swiftgy.com</a>. The full detail
        is on <Link className="underline" href="/account/delete">how account deletion works</Link> and in our <Link className="underline" href="/legal/privacy">privacy policy</Link>.
      </p>
    </>
  );
}
