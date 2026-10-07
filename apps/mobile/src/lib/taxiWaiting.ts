import { money } from './money';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · owner ruling 1 Oct 2026] The phone's half of the
// waiting charge (CONTRACT.md Rev 2 §8): a charge per FULL block of waiting,
// counted by the SERVER from the driver's arrival — at the pickup and at each
// stop — and paid in cash on top of the route fare.
//
// The rule for this module is the contract's: show what the server sends and
// never make up a value. With no `waiting` object there is nothing to show (the
// screens are exactly today's), the money shown is always the server's figure,
// and only the clock ticks on the phone, from the server's own `nextChargeAt`.
// ---------------------------------------------------------------------------

export interface WaitingTerms {
  chargePerBlock: number;
  blockMinutes: number;
  currencyCode: string;
  text?: string;
}

export interface WaitingLive extends WaitingTerms {
  pickupWaitMinutes: number | null;
  waitingMinutes: number;
  waitingCharge: number;
  running: boolean;
  nextChargeAt: string | null;
}

export interface FareBreakdown {
  routeFare: number;
  waitingMinutes: number;
  waitingCharge: number;
  total: number;
  currencyCode: string;
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const positive = (v: unknown): v is number => count(v) && v > 0;

function termsOf(raw: unknown): WaitingTerms | null {
  const w = raw as Record<string, unknown> | null | undefined;
  if (!w || typeof w !== 'object') return null;
  if (!count(w['chargePerBlock']) || !positive(w['blockMinutes'])) return null;
  return {
    chargePerBlock: w['chargePerBlock'],
    blockMinutes: w['blockMinutes'],
    currencyCode: typeof w['currencyCode'] === 'string' ? w['currencyCode'] : 'GYD',
    ...(typeof w['text'] === 'string' && w['text'].trim() ? { text: w['text'].trim() } : {}),
  };
}

/**
 * The line shown beside the fare before booking (§8.2): the server's own
 * sentence, from the estimate (or the capability read) it rode on. A server
 * that sends terms without the sentence gets the same sentence built from its
 * numbers; no terms — or broken ones — show nothing.
 */
export function waitingDisclosure(source: unknown): string | null {
  const terms = termsOf((source as { waiting?: unknown } | null | undefined)?.waiting);
  if (!terms) return null;
  return terms.text ?? `Waiting: ${money(terms.chargePerBlock)} per ${terms.blockMinutes} minutes after your driver arrives`;
}

/** The live wait on a ride (§8.3), present from the driver's arrival on. */
export function liveWaiting(ride: unknown): WaitingLive | null {
  const raw = (ride as { waiting?: unknown } | null | undefined)?.waiting as Record<string, unknown> | null | undefined;
  const terms = termsOf(raw);
  if (!terms || !raw) return null;
  if (!count(raw['waitingMinutes']) || !count(raw['waitingCharge']) || typeof raw['running'] !== 'boolean') return null;
  return {
    ...terms,
    pickupWaitMinutes: count(raw['pickupWaitMinutes']) ? raw['pickupWaitMinutes'] : null,
    waitingMinutes: raw['waitingMinutes'],
    waitingCharge: raw['waitingCharge'],
    running: raw['running'],
    nextChargeAt: typeof raw['nextChargeAt'] === 'string' ? raw['nextChargeAt'] : null,
  };
}

export interface WaitingView {
  /** Minutes waited so far, ticking locally while a wait runs. */
  minutes: number;
  /** The server's charge so far — never a predicted one. */
  charge: number;
  running: boolean;
  /** Seconds until the next block lands, while a wait runs; null otherwise. */
  nextChargeInSeconds: number | null;
  chargePerBlock: number;
  blockMinutes: number;
  currencyCode: string;
}

/**
 * The wait as the screen shows it at `now`. While a wait runs, the seconds
 * waited are read back from `nextChargeAt` — the instant the summed wait
 * reaches the next full block — so the timer ticks on the phone between the
 * server's answers. It never shows fewer minutes than the server did (a phone
 * clock that runs behind), and the charge is always the server's: past
 * `nextChargeAt` the clock keeps going, but the next block is shown only when
 * the server says it landed (the next poll or socket refetch).
 */
export function waitingView(w: WaitingLive, now: number): WaitingView {
  const base = {
    minutes: w.waitingMinutes,
    charge: w.waitingCharge,
    running: w.running,
    nextChargeInSeconds: null as number | null,
    chargePerBlock: w.chargePerBlock,
    blockMinutes: w.blockMinutes,
    currencyCode: w.currencyCode,
  };
  const nextAt = w.nextChargeAt ? Date.parse(w.nextChargeAt) : Number.NaN;
  if (!w.running || !Number.isFinite(nextAt) || w.chargePerBlock <= 0) return base;
  const blockSeconds = w.blockMinutes * 60;
  const blocksSoFar = Math.floor(w.waitingCharge / w.chargePerBlock + 1e-9);
  const remaining = (nextAt - now) / 1000;
  const waitedSeconds = (blocksSoFar + 1) * blockSeconds - remaining;
  return {
    ...base,
    minutes: Math.max(w.waitingMinutes, Math.floor(waitedSeconds / 60)),
    nextChargeInSeconds: remaining > 0 ? Math.ceil(Math.min(remaining, blockSeconds)) : null,
  };
}

/** A stop's own wait (§8.3: arrival → departure, or → now while there). */
export function stopWaitMinutes(stop: unknown): number | null {
  const v = (stop as { waitMinutes?: unknown } | null | undefined)?.waitMinutes;
  return count(v) ? v : null;
}

/** m:ss for a countdown. */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The finished ride's breakdown (§8.4): on `GET /rides/:id`, or inside the
 *  DELIVERED socket's `fare` object. Anything malformed is no breakdown, and
 *  the receipt stays today's. */
export function fareBreakdownOf(source: unknown): FareBreakdown | null {
  const s = source as { fareBreakdown?: unknown; fare?: { fareBreakdown?: unknown } | null } | null | undefined;
  const raw = (s?.fareBreakdown ?? s?.fare?.fareBreakdown) as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const { routeFare, waitingMinutes, waitingCharge, total } = raw;
  if (!count(routeFare) || !count(waitingMinutes) || !count(waitingCharge) || !count(total)) return null;
  return { routeFare, waitingMinutes, waitingCharge, total, currencyCode: typeof raw['currencyCode'] === 'string' ? raw['currencyCode'] : 'GYD' };
}
