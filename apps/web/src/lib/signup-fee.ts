// ---------------------------------------------------------------------------
// [COORD ruling 22 Oct 2026 · row 628] The weekly fee at partner sign-up, on the website.
//
// A store, rider or taxi driver sees the weekly fee BEFORE the button that signs them up: the
// server's amount for THEIR business type or vehicle (GET /auth/pricing — the numbers signup
// and billing use; never one written here), then the server's own words — what it covers,
// when it starts (only after approval: nothing is paid at sign-up), how it is paid (MMG's
// checkout page in the app) and the 14-day rule for price changes — and an unticked
// "I understand the weekly fee". The API records the tick in the consent ledger with the
// amount, and refuses an amount that is not its quote right now (WEEKLY_FEE_CHANGED).
// ---------------------------------------------------------------------------
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';

/** The server's fee words and the tick (the API anchors the consent row to exactly these). */
export interface FeeTerms {
  version: string;
  items: { heading: string; text: string }[];
  tick: string;
}

/** The parts of the public price list the sign-up form reads. */
export interface SignupPricing {
  currencyCode: string;
  currencySymbol: string;
  movers?: { vehicleType: string; rate: number }[];
  vendors?: { service: number; catalogue: { minItems: number; rate: number }[] };
  /** Absent from an API older than the tick: then there is nothing to tick and nothing is sent. */
  feeTerms?: FeeTerms;
}

/** What sign-up sends for the tick: the words' version and the fee on screen. */
export interface WeeklyFeeAck {
  version: string;
  amount: number;
  currencyCode: string;
}

/** What the sign-up button may do: `ask` names what is missing (the button waits); with no ask it
 *  may submit, sending `ack` when the server asked for the tick. */
export type FeeState = { ask: string; ack?: undefined } | { ask: null; ack?: WeeklyFeeAck };

/** Who is being priced: a business by its type, a rider or driver by the vehicle. */
export type FeeChoice = { role: 'VENDOR'; vendorType: string } | { role: 'MOVER'; vehicleType: string };

export const FEE_ASK = {
  loading: 'Loading your weekly fee…',
  error: 'Couldn’t load your weekly fee — check your connection and try again.',
  missing: 'No weekly fee is set for this choice yet.',
  invalid: 'Couldn’t load the weekly fee terms — try again later.',
  tick: 'Tick “I understand the weekly fee” to continue.',
} as const;

/** Beside a catalogue store's amount when the price list has more steps (the phone's price card says the same). */
/** [RETIER PR-A · owner 30 Oct 2026] A store signs up before it has a catalogue: the fee is born when Swift approves it,
 *  on its own catalogue's step, ticked by its owner first. [R27] The weekly re-tier is OFF: nothing moves it after. */
export const FEE_LADDER = 'This is the starting rate. If your store has more items by the time Swift approves it (counting items taken off sale or removed in the last 7 days), its weekly fee is the rate for its size: you see that exact fee and tick it before anything is charged. After that, the rate does not change as your catalogue grows.';

/** True when this choice starts on a catalogue step the price list goes beyond. */
export function feeSteps(pricing: SignupPricing, choice: FeeChoice): boolean {
  return choice.role === 'VENDOR' && choice.vendorType !== 'SERVICE' && (pricing.vendors?.catalogue?.length ?? 0) > 1;
}

/** The server's refusals of the tick: the form reads the price again when it sees one. */
export const FEE_TICK_ERRORS: readonly string[] = ['WEEKLY_FEE_ACK_REQUIRED', 'WEEKLY_FEE_CHANGED', 'WEEKLY_FEE_TERMS_CHANGED'];

/** The price list read fresh for this form — never a cached page's figure. */
export async function fetchSignupPricing(): Promise<SignupPricing> {
  const res = await fetch(`${BROWSER_API_ORIGIN}/api/v1/auth/pricing`, { cache: 'no-store' });
  const body = res.ok ? await res.json() : null;
  if (!body?.data) throw new Error(FEE_ASK.error);
  return body.data as SignupPricing;
}

const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** The weekly fee quoted for this choice (a new store starts on the first catalogue step), or null. */
export function feeQuote(pricing: SignupPricing, choice: FeeChoice): number | null {
  if (choice.role === 'MOVER') {
    const rate = pricing.movers?.find((q) => q.vehicleType === choice.vehicleType)?.rate;
    return isRate(rate) ? rate : null;
  }
  if (choice.vendorType === 'SERVICE') return isRate(pricing.vendors?.service) ? pricing.vendors!.service : null;
  const first = pricing.vendors?.catalogue?.[0];
  return first && first.minItems === 0 && isRate(first.rate) ? first.rate : null;
}

/** The server's words, null when it serves none (an older API), or 'invalid' when what it serves is not them. */
export function feeTermsOf(pricing: SignupPricing): FeeTerms | null | 'invalid' {
  const t = pricing.feeTerms;
  if (t === undefined) return null;
  const ok = !!t && nonEmpty(t.version) && nonEmpty(t.tick) && Array.isArray(t.items) && t.items.length > 0
    && t.items.every((i) => !!i && nonEmpty(i.heading) && nonEmpty(i.text));
  return ok ? t : 'invalid';
}
