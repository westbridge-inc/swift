'use client';

import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { apiFetch, BROWSER_CLIENT, hasProviderProfile } from './auth';

// [PORTAL-404 · FLOW-QA F29] The earner office asked GET /rider/profile, /driver/profile and /provider/subscription
// for every account, and the server answers 404 for a profile the person does not hold. The browser logs each 404
// itself, so a new rider saw /driver/profile errors on Earnings, History and Account, and everyone saw one for the
// provider fee on Weekly fee. GET /auth/me now says which profiles exist; the profile reads ask only for those.
//
// Absence is still the server's word, never a guess: a profile is skipped only when /auth/me answered and said "no".
// When it could not answer (a failure, or an API from before it said) the profile route is asked as before, so a
// failure still reaches the page as an error and never as "you have no profile".

/** Which of the signed-in person's own partner profiles exist, as GET /auth/me says (`data.profiles`). Null when the
 *  answer does not carry all three as yes/no (an API from before it said so): the caller then asks the profile route
 *  itself, as it always did. */
export type PartnerProfiles = { rider: boolean; driver: boolean; provider: boolean };
export function readPartnerProfiles(value: unknown): PartnerProfiles | null {
  const v = value as Partial<Record<keyof PartnerProfiles, unknown>> | null | undefined;
  if (!v || typeof v.rider !== 'boolean' || typeof v.driver !== 'boolean' || typeof v.provider !== 'boolean') return null;
  return { rider: v.rider, driver: v.driver, provider: v.provider };
}

/** Whether /auth/me says this person is a pro, or null when it could not say. A plain read with the session cookie, as
 *  lib/auth hasProviderProfile is: no refresh, no redirect. */
export async function providerFromMe(): Promise<boolean | null> {
  try {
    const me = await fetch(`${BROWSER_API_ORIGIN}/api/v1/auth/me`, { credentials: 'include', headers: { 'X-Swift-Client': BROWSER_CLIENT } });
    if (!me.ok) return null;
    return readPartnerProfiles((await me.json().catch(() => null))?.data?.profiles)?.provider ?? null;
  } catch {
    return null;
  }
}

/** Is this person a pro? /auth/me's answer (a 200, never a 404 the browser logs for someone who is not a pro); only
 *  when it could not say is the provider route asked (lib/auth hasProviderProfile, as before). Used by the pages that
 *  load it on demand (the header's account link, the signed-in card, the store's weekly-fee link). lib/auth itself is
 *  left as it was: every page carries it, and the home page sits at its size ceiling. */
export async function isProvider(): Promise<boolean> {
  return (await providerFromMe()) ?? hasProviderProfile();
}

let inFlight: Promise<PartnerProfiles | null> | null = null;

/** The person's partner profiles from /auth/me, or null when it did not say. Reads at the same moment share one
 *  request (a page asks for the rider and the driver profile together); nothing is kept after it answers, so a
 *  profile added a minute ago is never hidden by an old answer. */
export function partnerProfiles(): Promise<PartnerProfiles | null> {
  inFlight ??= apiFetch('/api/v1/auth/me')
    .then((body) => readPartnerProfiles((body as { data?: { profiles?: unknown } } | null)?.data?.profiles))
    .catch(() => null)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** `read()` unless /auth/me said this person holds no such profile: then null, the same "no profile" the route's
 *  404 or 403 meant, without asking. */
export async function unlessNotHeld<T>(kind: keyof PartnerProfiles, read: () => Promise<T | null>): Promise<T | null> {
  const known = await partnerProfiles();
  if (known && !known[kind]) return null;
  return read();
}
