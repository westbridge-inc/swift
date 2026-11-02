'use client';

import { apiFetch, readPartnerProfiles, type PartnerProfiles } from './auth';

// [PORTAL-404 · FLOW-QA F29] The earner office asked GET /rider/profile, /driver/profile and /provider/subscription
// for every account, and the server answers 404 for a profile the person does not hold. The browser logs each 404
// itself, so a new rider saw /driver/profile errors on Earnings, History and Account, and everyone saw one for the
// provider fee on Weekly fee. GET /auth/me now says which profiles exist; the profile reads ask only for those.
//
// Absence is still the server's word, never a guess: a profile is skipped only when /auth/me answered and said "no".
// When it could not answer (a failure, or an API from before it said) the profile route is asked as before, so a
// failure still reaches the page as an error and never as "you have no profile".

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
