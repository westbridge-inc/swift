import { mmgDisabled } from '../../providers/mmg/mmg-provider';
import { weeklyFeeCardLive } from '../../utils/card-rail';

// ---------------------------------------------------------------------------
// [PROD-PATH] THE rule for "the weekly fee is paused" (coordinator ruling of
// 6 Oct 2026, applying the owner's 5 Oct "MMG off: bill the current week
// only; weeks Swift could not take payment are not back-billed"):
//
//   while a partner has NO live way to pay — MMG switched off and no live
//   card rail (agent cash and admin top-ups are hidden) — their fee is
//   PAUSED, for EVERY billing method, cash included: no charge, no failure,
//   no dunning, no PAST_DUE or grace lapse, no suspension, no churn.
//
// It is decided by the SERVER's own switches only: the MMG driver and the
// card-rail switches. Nothing a partner can set enters it — not their billing
// method, not whether they have a card on file (removing a card never pauses
// a fee), not anything their app sends. So it is the same answer for every
// partner on this server, and a partner can neither cause nor dodge it.
//
// The card rail counts as a live way to pay only when a partner can open it
// (weeklyFeeCardLive: v2 on, not killed). With it live, a partner without a
// card can add one, so nobody is paused, MMG on or off.
// ---------------------------------------------------------------------------

export function noLivePayPath(env: Record<string, string | undefined> = process.env): boolean {
  return mmgDisabled(env) && !weeklyFeeCardLive(env);
}
