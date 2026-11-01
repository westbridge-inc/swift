'use client';

import Link from 'next/link';
import { restoreSession, sessionProbe } from '@/lib/auth';
import { SignOutButton } from '@/components/sign-out-button';
import { GUYANA_DIAL_CODE, guyanaLocal } from '@/lib/guyana-phone';

/**
 * [SIGNUP-PHONE · owner 1 Nov 2026] Sign-in and sign-up recognise a session that is already there (GET /auth/me)
 * instead of asking for a code again: the person goes straight on, by their account's roles (a business to its
 * dashboard, a rider or driver to the portal, a customer to Swift), or signs out first to use a different number.
 * Loaded on demand (signed-in-loader.ts), so neither page carries it up front.
 */
export type SignedIn = { phone: string; home: string; place: string };

export function homeForRoles(user: Record<string, unknown>): { home: string; place: string } {
  const roles = Array.isArray(user['roles']) ? (user['roles'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  if (roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!user['vendorOwner']) return { home: '/dashboard', place: 'your dashboard' };
  if (roles.some((r) => ['MOVER', 'RIDER', 'DRIVER'].includes(r))) return { home: '/portal', place: 'your portal' };
  return { home: '/', place: 'Swift' };
}

/** The session already in this browser, or null (signed out, or the server could not say). */
export async function probeSignedIn(): Promise<SignedIn | null> {
  // The access cookie lives fifteen minutes and the refresh cookie thirty days (both with a Max-Age, so they outlive a
  // browser restart): a person back after a quarter of an hour is still signed in, so the refresh is spent here, on the
  // two pages that would otherwise ask them for a code again.
  let session = await sessionProbe();
  if (!session.ok && !session.unreachable) session = await restoreSession();
  if (!session.ok || !session.user) return null;
  const phone = typeof session.user['phone'] === 'string' ? session.user['phone'] : '';
  const home = homeForRoles(session.user);
  // A rider or driver who stopped before the documents were in goes back to Documents, not to the start. A business
  // with no store yet is sent on by its dashboard (to /signup?resume=business, the business step).
  if (home.home === '/portal') {
    const docs = await import('@/lib/mover-api').then((m) => m.getVerificationStatus()).catch(() => null);
    if (docs && !docs.roleVerified && Array.isArray(docs.missing) && docs.missing.length > 0) return { phone, home: '/portal/documents', place: 'your documents' };
  }
  return { phone, ...home };
}

export function SignedInAlready({ who, here, home, onSignedOut, titleId, className }: { who: SignedIn; here: string; home?: string; onSignedOut: () => void; titleId: string; className?: string }) {
  const shown = who.phone.startsWith(GUYANA_DIAL_CODE) ? `${GUYANA_DIAL_CODE} ${guyanaLocal(who.phone)}` : who.phone;
  return (
    <div className={className ?? 'flex flex-col gap-3'} data-signed-in-already>
      <h1 id={titleId} className="sw-title">You’re signed in{shown ? ` as ${shown}` : ''}</h1>
      <p className="sw-caption">No new code needed: this browser is already signed in.</p>
      <Link href={home ?? who.home} className="sw-btn sw-btn-block">Go to {who.place}</Link>
      <SignOutButton
        className="sw-link cursor-pointer self-center border-0 bg-transparent p-0"
        title="Use a different number?"
        body="This signs you out of Swift in this browser first, so you can continue with another number."
        redirectTo={here}
        onSignedOut={onSignedOut}
      >
        Use a different number
      </SignOutButton>
    </div>
  );
}
