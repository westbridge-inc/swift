'use client';

import Link from 'next/link';
import { hasProviderProfile, restoreSession, sessionProbe } from '@/lib/auth';
import { SignOutButton } from '@/components/sign-out-button';
import { GUYANA_DIAL_CODE, guyanaLocal } from '@/lib/guyana-phone';
import { forgetSignedIn, markSignedIn, signedInBefore } from '@/lib/session-hint';
import { roleHome } from '@/lib/role-home';

/**
 * [SIGNUP-PHONE · owner 1 Nov 2026] Sign-in and sign-up recognise a session that is already there (GET /auth/me)
 * instead of asking for a code again: the person goes straight on, where sign-in itself would send them (a business
 * to its dashboard, a rider or driver to the portal, a self-employed pro to their weekly fee, a customer to Swift),
 * or back to the step they stopped at, or signs out first to use a different number.
 * Loaded on demand (signed-in-loader.ts), so neither page carries it up front.
 */
export type SignedIn = { phone: string; home: string; label: string };

/** Where sign-in sends this account (lib/auth verifyPartnerLogin, signup doVerify): roles first, then a pro profile. */
export async function homeFor(user: Record<string, unknown>): Promise<{ home: string; label: string }> {
  const { kind } = roleHome(user);
  if (kind === 'business') return { home: '/dashboard', label: 'Go to your dashboard' };
  if (kind === 'earner') {
    const movers = await import('@/lib/mover-api');
    // [REVIEW-G G1 · owner rule 3] An account that stopped after its name, before the vehicle step, has no rider or
    // driver profile yet: it goes back to that step (/signup?resume=mover), never to an empty portal.
    const [rider, driver] = await Promise.all([movers.getRiderProfile(), movers.getDriverProfile()]).catch(() => [undefined, undefined]);
    if (rider === null && driver === null) return { home: '/signup?resume=mover', label: 'Finish signing up' };
    // A rider or driver who stopped before the documents were in goes back to Documents.
    const docs = await movers.getVerificationStatus().catch(() => null);
    if (docs && !docs.roleVerified && Array.isArray(docs.missing) && docs.missing.length > 0) return { home: '/portal/documents', label: 'Go to your documents' };
    return { home: '/portal', label: 'Go to your portal' };
  }
  // [REVIEW-G G3] A self-employed pro holds no partner role: sign-in sends them to their weekly fee, and so does this.
  if (await hasProviderProfile()) return { home: '/portal/weekly-fee', label: 'Go to your weekly fee' };
  return { home: '/', label: 'Go to Swift' };
}

/** The session already in this browser, or null (signed out, or the server could not say). */
export async function probeSignedIn(): Promise<SignedIn | null> {
  // The access cookie lives fifteen minutes and the refresh cookie thirty days (both with a Max-Age, so they outlive a
  // browser restart). A person back after a quarter of an hour is still signed in, so the refresh is spent here, but
  // only in a browser that has signed in before (lib/session-hint): a guest's visit never spends one.
  let session = await sessionProbe();
  if (!session.ok && !session.unreachable && signedInBefore()) {
    session = await restoreSession();
    if (!session.ok && !session.unreachable) forgetSignedIn();
  }
  if (!session.ok || !session.user) return null;
  markSignedIn();
  const phone = typeof session.user['phone'] === 'string' ? session.user['phone'] : '';
  return { phone, ...(await homeFor(session.user)) };
}

export function SignedInAlready({ who, here, back, onSignedOut, titleId, className }: {
  who: SignedIn;
  here: string;
  /** Where the page was asked to return to (sign-in's `next`), with its own words; else the account's home. */
  back?: { href: string; label: string };
  onSignedOut: () => void;
  titleId: string;
  className?: string;
}) {
  const shown = who.phone.startsWith(GUYANA_DIAL_CODE) ? `${GUYANA_DIAL_CODE} ${guyanaLocal(who.phone)}` : who.phone;
  return (
    <div className={className ?? 'flex flex-col gap-3'} data-signed-in-already>
      <h1 id={titleId} className="sw-title">You’re signed in{shown ? ` as ${shown}` : ''}</h1>
      <p className="sw-caption">No new code needed: this browser is already signed in.</p>
      <Link href={back?.href ?? who.home} className="sw-btn sw-btn-block">{back?.label ?? who.label}</Link>
      <SignOutButton
        className="sw-link cursor-pointer self-center border-0 bg-transparent p-0"
        title="Use a different number?"
        body="This signs you out of Swift in this browser first, so you can continue with another number."
        redirectTo={here}
        onSignedOut={() => { forgetSignedIn(); onSignedOut(); }}
      >
        Use a different number
      </SignOutButton>
    </div>
  );
}
