import { catalogueStepsFor, type SubscriptionTiers } from '../country/country-config.service';

// ---------------------------------------------------------------------------
// [DEPT-PRICE · owner 29 Oct 2026] A CARD PRICE CUT reaches the stores already
// billed above it.
//
// The weekly re-tier (OFF until its 14-day notice ships, weekly-retier.ts) is
// the only other path that moves a store's fee, and it moves a store DOWN only
// after its catalogue has shrunk on two weekly passes. A lower card price is
// not a catalogue change: when the department-store fee went from 60,000 to
// 45,000, every store billed above the card's highest catalogue fee moves down
// to it — a decrease, so no 14-day notice is owed (GUARDRAILS §7 standing rule 2
// covers rises) — from its NEXT weekly fee:
//   - a weekly fee already charged keeps its amount (amount-due.ts
//     issuedChargeDue) and a paid week keeps its price: never retroactive;
//   - a payment in flight (an open or confirming MMG checkout, a confirmation
//     hold, a held late card approval, a reversal) leaves the store untouched
//     until it settles (payment-in-flight.ts, the predicate a chain deal uses):
//     its quote is never changed under a payment; the next hourly pass moves it;
//   - a negotiated rate (customRate, e.g. a chain deal) is never rewritten: only
//     the tier rate under it moves, so a deal is charged min(deal, tier);
//   - a service business is priced on its own flat rate, never on the
//     catalogue card, so it is not a catalogue store above the card.
// Each move is one transaction under the payer's lock: the new rate, its
// TIER_CHANGE billing event and an audit row together; the payer is told the
// fee went down after the commit (feeDecreaseCopy).
// ---------------------------------------------------------------------------

/** The highest weekly fee the market's catalogue card bills a store (the department step where it has one). */
export function catalogueCardTop(tiers: SubscriptionTiers): number {
  return Math.max(...catalogueStepsFor(tiers).map((step) => step.rate));
}
