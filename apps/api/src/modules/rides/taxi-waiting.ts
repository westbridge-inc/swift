import { Prisma, type OrderStatus, type PrismaClient, type TaxiStopStatus } from '@prisma/client';
import { isTaxiStopOpen, TAXI_STOP_PARENT_STATUS } from '../order/order-status';
import type { TaxiStopProgress } from './taxi-stops-read';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · owner ruling 1 Oct 2026] THE one place the waiting
// charge is decided (CONTRACT.md Rev 2 §8).
//
// The rule: a charge per FULL block of waiting (500 GYD per 10 minutes by
// default; TAXI_RATES.waitingChargePerBlock / waitingBlockMinutes). The waits
// are the pickup (the driver's arrival → the trip start) and each intermediate
// stop (its arrival → its departure, or its skip: the car waited either way).
// They are summed on the server's own timestamps, then
//   waitingMinutes = floor(totalSeconds / 60)
//   waitingCharge  = floor(totalSeconds / (blockMinutes × 60)) × chargePerBlock.
// Waiting at the final destination is never counted. A wait whose end reads
// before its start (clock skew) counts 0, never less.
//
// The terms are frozen on the ride at booking (taxi_ride_waiting), so the
// passenger pays what was disclosed; the charge is frozen ONCE, inside the
// completion transaction, and added to the order's totalAmount there. A ride
// that ends any other way (no-show, refused, cancelled) is never charged: the
// freeze happens on the way to DELIVERED and nowhere else.
//
// The switch: TAXI_WAITING_CHARGE, off unless exactly "1". Off, nothing new is
// written, shown or charged, and every payload is today's, byte for byte. A
// ride booked while it was off carries no terms and is never charged.
// ---------------------------------------------------------------------------

/** The declared defaults: a market whose TAXI_RATES names no waiting terms waits on these. */
export const TAXI_WAITING_DEFAULTS = { chargePerBlock: 500, blockMinutes: 10 } as const;

/** TAXI_WAITING_CHARGE: on only when exactly "1" (surrounding blanks ignored). */
export function taxiWaitingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['TAXI_WAITING_CHARGE'] ?? '').trim() === '1';
}

/** The terms a passenger is shown before booking and charged on after it. */
export interface TaxiWaitingTerms {
  chargePerBlock: number;
  blockMinutes: number;
  currencyCode: string;
}

/** The terms of a market, from its validated TAXI_RATES payload. */
export function waitingTermsFromRates(
  rates: { waitingChargePerBlock?: number; waitingBlockMinutes?: number },
  currencyCode: string,
): TaxiWaitingTerms {
  return {
    chargePerBlock: rates.waitingChargePerBlock ?? TAXI_WAITING_DEFAULTS.chargePerBlock,
    blockMinutes: rates.waitingBlockMinutes ?? TAXI_WAITING_DEFAULTS.blockMinutes,
    currencyCode,
  };
}

const wholeUnits = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** The sentence shown beside the fare: "Waiting: 500 per 10 minutes after your driver arrives". */
export function waitingTermsText(terms: TaxiWaitingTerms): string {
  const block = terms.blockMinutes === 1 ? 'minute' : `${terms.blockMinutes} minutes`;
  return `Waiting: ${wholeUnits.format(terms.chargePerBlock)} per ${block} after your driver arrives`;
}

/** §8.2: the disclosure block on the estimate, the capability read and the request answer. */
export interface TaxiWaitingDisclosure extends TaxiWaitingTerms {
  text: string;
}
export function waitingDisclosure(terms: TaxiWaitingTerms): TaxiWaitingDisclosure {
  return {
    chargePerBlock: terms.chargePerBlock,
    blockMinutes: terms.blockMinutes,
    currencyCode: terms.currencyCode,
    text: waitingTermsText(terms),
  };
}

// ---------------------------------------------------------------------------
// The clock: pure, on the server's timestamps.
// ---------------------------------------------------------------------------

export interface TaxiWaitStopClock {
  sequence: number;
  status: TaxiStopStatus;
  arrivedAt: Date | null;
  departedAt: Date | null;
  skippedAt: Date | null;
}

export interface TaxiWaitClock {
  status: OrderStatus;
  /** The driver's arrival at the pickup (Order.driverArrivedAt). */
  driverArrivedAt: Date | null;
  /** The trip start (Order.pickedUpAt). */
  pickedUpAt: Date | null;
  stops: readonly TaxiWaitStopClock[];
}

/** One wait: how long, and whether it is still running now. */
export interface TaxiWaitSpan {
  ms: number;
  running: boolean;
}

export interface TaxiWaitTally {
  /** The pickup wait; null before the driver arrived (or after a release). */
  pickup: TaxiWaitSpan | null;
  /** Each stop's wait by sequence; null before its arrival. */
  stops: Map<number, TaxiWaitSpan | null>;
  totalSeconds: number;
  waitingMinutes: number;
  blocks: number;
  waitingCharge: number;
  /** How many waits are running now (0 or 1 on any real ride). */
  running: number;
  /** When the next block lands if the running wait continues; null when none runs. */
  nextChargeAt: Date | null;
}

/** From → to, never negative: an end that reads before its start is 0. */
const span = (from: Date, to: Date): number => Math.max(0, to.getTime() - from.getTime());

/**
 * The waits of one ride and their charge.
 *
 * `live` counts a wait still running up to `now` (the active-ride payloads);
 * `final` counts closed waits only (the completion freeze). At completion
 * every wait is closed (the trip started; the stop guard refuses a stop still
 * open), so `final` is exactly what the live payload showed the driver before
 * the tap, whatever the clock says now.
 */
export function tallyTaxiWaiting(clock: TaxiWaitClock, terms: TaxiWaitingTerms, now: Date, mode: 'live' | 'final'): TaxiWaitTally {
  const live = mode === 'live';
  let pickup: TaxiWaitSpan | null = null;
  if (clock.driverArrivedAt) {
    if (clock.pickedUpAt) pickup = { ms: span(clock.driverArrivedAt, clock.pickedUpAt), running: false };
    else if (clock.status === 'DRIVER_ARRIVED') pickup = live ? { ms: span(clock.driverArrivedAt, now), running: true } : { ms: 0, running: false };
  }
  const stops = new Map<number, TaxiWaitSpan | null>();
  for (const stop of clock.stops) {
    if (!stop.arrivedAt) { stops.set(stop.sequence, null); continue; }
    const end = stop.departedAt ?? stop.skippedAt;
    if (end) stops.set(stop.sequence, { ms: span(stop.arrivedAt, end), running: false });
    else if (live && isTaxiStopOpen(stop.status) && clock.status === TAXI_STOP_PARENT_STATUS) stops.set(stop.sequence, { ms: span(stop.arrivedAt, now), running: true });
    else stops.set(stop.sequence, { ms: 0, running: false });
  }
  const waits = [pickup, ...stops.values()].filter((w): w is TaxiWaitSpan => w !== null);
  const totalMs = waits.reduce((sum, w) => sum + w.ms, 0);
  const totalSeconds = Math.floor(totalMs / 1000);
  const blockSeconds = terms.blockMinutes * 60;
  const blocks = Math.floor(totalSeconds / blockSeconds);
  const running = waits.filter((w) => w.running).length;
  // The summed wait reaches the next full block at (blocks + 1) × block; with
  // `running` clocks advancing together it gets there `running` times faster.
  const nextChargeAt = running > 0
    ? new Date(now.getTime() + Math.ceil(((blocks + 1) * blockSeconds * 1000 - totalMs) / running))
    : null;
  return {
    pickup,
    stops,
    totalSeconds,
    waitingMinutes: Math.floor(totalSeconds / 60),
    blocks,
    waitingCharge: blocks * terms.chargePerBlock,
    running,
    nextChargeAt,
  };
}

const minutesOf = (w: TaxiWaitSpan | null | undefined): number | null => (w ? Math.floor(w.ms / 60_000) : null);

/** §8.3: the live object on the rider's and the driver's active ride. */
export interface TaxiWaitingLive extends TaxiWaitingTerms {
  pickupWaitMinutes: number | null;
  waitingMinutes: number;
  waitingCharge: number;
  running: boolean;
  nextChargeAt: string | null;
}
export function liveWaitingPayload(terms: TaxiWaitingTerms, tally: TaxiWaitTally): TaxiWaitingLive {
  return {
    chargePerBlock: terms.chargePerBlock,
    blockMinutes: terms.blockMinutes,
    currencyCode: terms.currencyCode,
    pickupWaitMinutes: minutesOf(tally.pickup),
    waitingMinutes: tally.waitingMinutes,
    waitingCharge: tally.waitingCharge,
    running: tally.running > 0,
    nextChargeAt: tally.nextChargeAt ? tally.nextChargeAt.toISOString() : null,
  };
}

/** §8.4: the finished ride's fare, itemised. */
export interface TaxiFareBreakdown {
  routeFare: number;
  waitingMinutes: number;
  waitingCharge: number;
  total: number;
  currencyCode: string;
}

// ---------------------------------------------------------------------------
// The database seam: the terms row, the freeze and the reads.
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | PrismaClient;

const WAITING_ROW_SELECT = {
  chargePerBlock: true,
  blockMinutes: true,
  currencyCode: true,
  waitingSeconds: true,
  waitingMinutes: true,
  waitingCharge: true,
  frozenAt: true,
} as const satisfies Prisma.TaxiRideWaitingSelect;
type WaitingRow = Prisma.TaxiRideWaitingGetPayload<{ select: typeof WAITING_ROW_SELECT }>;

const termsOfRow = (row: WaitingRow): TaxiWaitingTerms => ({
  chargePerBlock: Number(row.chargePerBlock),
  blockMinutes: row.blockMinutes,
  currencyCode: row.currencyCode,
});

const STOP_CLOCK_SELECT = { sequence: true, status: true, arrivedAt: true, departedAt: true, skippedAt: true } as const;

/** The terms row written with the ride, inside its creation, while the switch is on. */
export function waitingTermsCreate(tenantId: string, terms: TaxiWaitingTerms, termsVersion: number | null) {
  return {
    tenantId,
    chargePerBlock: terms.chargePerBlock,
    blockMinutes: terms.blockMinutes,
    currencyCode: terms.currencyCode,
    termsVersion,
  };
}

export interface FrozenTaxiWaiting {
  waitingSeconds: number;
  waitingMinutes: number;
  waitingCharge: number;
}

/**
 * THE closing seam's half of the waiting charge. Called by the canonical
 * transition on its locked order row, on the way to DELIVERED, inside its
 * transaction: computes the closed waits once and freezes them on the ride's
 * terms row (only while that row is not yet frozen: the database refuses a
 * second freeze, and so does this compare-and-set). Answers what was frozen,
 * or null when there is nothing to charge on (switch off, no terms row, a
 * row already frozen); the caller adds the charge to the order's total in the
 * same commit, so a rolled-back completion leaves nothing frozen and nothing
 * added.
 */
export async function freezeTaxiWaiting(
  tx: Prisma.TransactionClient,
  source: { id: string; status: OrderStatus; driverArrivedAt: Date | null; pickedUpAt: Date | null },
  now: Date,
  env: Record<string, string | undefined> = process.env,
): Promise<FrozenTaxiWaiting | null> {
  if (!taxiWaitingEnabled(env)) return null;
  const row = await tx.taxiRideWaiting.findUnique({ where: { orderId: source.id }, select: WAITING_ROW_SELECT });
  if (!row || row.frozenAt) return null;
  const stops = await tx.taxiTripStop.findMany({ where: { orderId: source.id }, select: STOP_CLOCK_SELECT });
  const tally = tallyTaxiWaiting(
    { status: source.status, driverArrivedAt: source.driverArrivedAt, pickedUpAt: source.pickedUpAt, stops },
    termsOfRow(row),
    now,
    'final',
  );
  const frozen: FrozenTaxiWaiting = { waitingSeconds: tally.totalSeconds, waitingMinutes: tally.waitingMinutes, waitingCharge: tally.waitingCharge };
  const written = await tx.taxiRideWaiting.updateMany({
    where: { orderId: source.id, frozenAt: null },
    data: { ...frozen, frozenAt: now },
  });
  return written.count === 1 ? frozen : null;
}

/** The charge frozen on a ride (0 when none was): what the driver's fare earning adds. */
export async function frozenWaitingCharge(db: Db, orderId: string): Promise<number> {
  const row = await db.taxiRideWaiting.findUnique({ where: { orderId }, select: { waitingCharge: true } });
  return row?.waitingCharge == null ? 0 : Number(row.waitingCharge);
}

/** The breakdown of a ride whose charge was frozen; null for any other ride. */
export function fareBreakdownOf(
  order: { taxiFareTotal: Prisma.Decimal | number | null; totalAmount: Prisma.Decimal | number; currencyCode: string },
  row: Pick<WaitingRow, 'waitingMinutes' | 'waitingCharge' | 'frozenAt'> | null,
): TaxiFareBreakdown | null {
  if (!row?.frozenAt || row.waitingMinutes == null || row.waitingCharge == null) return null;
  const waitingCharge = Number(row.waitingCharge);
  const routeFare = order.taxiFareTotal != null ? Number(order.taxiFareTotal) : Number(order.totalAmount) - waitingCharge;
  return { routeFare, waitingMinutes: row.waitingMinutes, waitingCharge, total: routeFare + waitingCharge, currencyCode: order.currencyCode };
}

/** A finished ride's frozen breakdown, read: the receipt line, the socket's fare, the admin page. */
export async function readFareBreakdown(
  db: Db,
  order: { id: string; taxiFareTotal: Prisma.Decimal | number | null; totalAmount: Prisma.Decimal | number; currencyCode: string },
): Promise<TaxiFareBreakdown | null> {
  const row = await db.taxiRideWaiting.findUnique({ where: { orderId: order.id }, select: WAITING_ROW_SELECT });
  return fareBreakdownOf(order, row);
}

/** The statuses whose ride shows its live wait: at the pickup, and on the trip. */
const isLiveWaitStatus = (status: OrderStatus): boolean => status === 'DRIVER_ARRIVED' || status === TAXI_STOP_PARENT_STATUS;

export type StopWithWait = TaxiStopProgress & { waitMinutes: number | null };

export interface TaxiWaitingDecoration {
  /** The ride's stops, each with its own wait (only when the live wait is shown). */
  stops?: StopWithWait[];
  /** §8.3, from the driver's arrival on. */
  waiting?: TaxiWaitingLive;
  /** §8.4, once the charge is frozen. */
  fareBreakdown?: TaxiFareBreakdown;
}

/**
 * What the waiting charge adds to a ride's read (the passenger's /rides/active
 * and /rides/:id, the driver's /driver/rides/active). Empty — and no query —
 * for every ride while the switch is off, unless the ride is finished with a
 * charge frozen on it (a receipt keeps what was collected). A live ride gains
 * `waiting` (and `waitMinutes` on each stop) from the driver's arrival on; a
 * finished one, its `fareBreakdown`.
 */
export async function decorateRideWaiting(
  db: Db,
  ride: {
    id: string; status: OrderStatus; driverArrivedAt: Date | null; pickedUpAt: Date | null;
    taxiFareTotal: Prisma.Decimal | number | null; totalAmount: Prisma.Decimal | number; currencyCode: string;
  },
  itineraryStops: readonly TaxiStopProgress[] | null,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<TaxiWaitingDecoration> {
  const live = isLiveWaitStatus(ride.status);
  const finished = ride.status === 'DELIVERED' || ride.status === 'COMPLETED';
  if (!finished && !(live && taxiWaitingEnabled(env))) return {};
  const row = await db.taxiRideWaiting.findUnique({ where: { orderId: ride.id }, select: WAITING_ROW_SELECT });
  if (!row) return {};
  if (finished) {
    const breakdown = fareBreakdownOf(ride, row);
    return breakdown ? { fareBreakdown: breakdown } : {};
  }
  const terms = termsOfRow(row);
  const tally = tallyTaxiWaiting(
    { status: ride.status, driverArrivedAt: ride.driverArrivedAt, pickedUpAt: ride.pickedUpAt, stops: itineraryStops ?? [] },
    terms,
    now,
    'live',
  );
  return {
    ...(itineraryStops ? { stops: itineraryStops.map((s) => ({ ...s, waitMinutes: minutesOf(tally.stops.get(s.sequence)) })) } : {}),
    waiting: liveWaitingPayload(terms, tally),
  };
}
