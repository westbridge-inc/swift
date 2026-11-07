import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { guyanaWallClockParts } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// [STORE-HOURS · owner 6 Nov 2026] "The days in dashboard I mark it's closed,
// orders still come through, vs when I click close store it actually stops
// taking orders."
//
// A store's weekly hours (OperatingHours: one row per day, Sunday = 0, a day
// marked closed, or open and close times as typed) were shown to customers but
// never enforced: only the manual switch (Vendor.isCurrentlyOpen) stopped
// orders. This is the ONE rule for "orderable now", read by checkout (the
// authority) and by every list that shows or sorts by "open now", so a store a
// list calls open is a store the checkout takes:
//
//   open now = the manual switch is on
//              AND (no hours are set
//                   OR the Guyana time now is inside today's hours,
//                      or inside last night's hours that run past midnight)
//
// Never written back: the switch in the database is the store's own, and the
// hours are applied when read. Times the store typed that cannot be read
// ("8ish") do not close the store (the switch decides that day): a typo must
// not silently stop a store's orders. A day marked closed always closes it.
// The App Review fiction (Vendor.isSynthetic) keeps today's behaviour so a
// reviewer in any time zone can order.
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

export type HoursRow = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

export const HOURS_SELECT = { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true } as const;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CLOCK = /^(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|a|p)?$/i;

/** A typed time ("08:00", "8:30", "8pm", "20.15", "24:00"): minutes after midnight, and whether it said am/pm. */
function clockReading(text: string | null | undefined): { minutes: number; meridiem: boolean; leadingZero: boolean } | null {
  const m = CLOCK.exec((text ?? '').trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  const meridiem = m[3]?.[0]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hour > 24 || (hour === 24 && minute > 0)) {
    return null;
  }
  return { minutes: hour * 60 + minute, meridiem: Boolean(meridiem), leadingZero: /^0\d$/.test(m[1]!) };
}

/** Minutes after midnight for a typed time; null when it cannot be read. */
export function clockMinutes(text: string | null | undefined): number | null {
  return clockReading(text)?.minutes ?? null;
}

type DayWindow = 'CLOSED' | 'ALL_DAY' | { open: number; close: number };

/**
 * One day's window. No row for a day that other days have = closed (the store page says "Closed today").
 *
 * The phone's hours editor is free text, so "9:00 - 5:00" means 9 am to 5 pm. A CLOSING time with no am/pm whose hour
 * is 1 to 11, written without a leading zero, is read as pm. Opening times are read as typed, and 24-hour values
 * ("02:00", "22:00") and am/pm stay exactly as written.
 */
function dayWindow(hours: readonly HoursRow[], dayOfWeek: number): DayWindow {
  const row = hours.find((h) => h.dayOfWeek === dayOfWeek);
  if (!row || row.isClosed) return 'CLOSED';
  const o = clockReading(row.openTime);
  const c = clockReading(row.closeTime);
  if (o === null || c === null) return 'ALL_DAY'; // unreadable times: the switch decides
  const open = o.minutes;
  const closeHour = Math.floor(c.minutes / 60);
  const close = !c.meridiem && !c.leadingZero && closeHour >= 1 && closeHour <= 11 ? c.minutes + 720 : c.minutes;
  if (open === close) return 'ALL_DAY'; // "00:00 - 00:00", "12:00 - 12:00": round the clock
  return { open, close };
}

const overnight = (w: { open: number; close: number }): boolean => w.close < w.open;

/** Whether the store's weekly hours allow an order at this instant (Guyana wall clock). No hours set: true. */
export function hoursAllowNow(hours: readonly HoursRow[], now: Date): boolean {
  if (hours.length === 0) return true;
  const { dayOfWeek, hour, minute } = guyanaWallClockParts(now);
  const t = hour * 60 + minute;
  const today = dayWindow(hours, dayOfWeek);
  if (today === 'ALL_DAY') return true;
  if (today !== 'CLOSED') {
    if (overnight(today) ? t >= today.open : t >= today.open && t < today.close) return true;
  }
  // Last night's hours that run past midnight (Saturday 18:00 - 02:00 is open at 01:00 on Sunday).
  const yesterday = dayWindow(hours, (dayOfWeek + 6) % 7);
  return typeof yesterday === 'object' && overnight(yesterday) && t < yesterday.close;
}

const clockWords = (minutes: number): string => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/** When the hours next open, in words ("today at 4:00 pm", "tomorrow at 8:00 am", "on Monday at 8:00 am"); null if never. */
export function nextOpeningWords(hours: readonly HoursRow[], now: Date): string | null {
  if (hours.length === 0) return null;
  const { dayOfWeek, hour, minute } = guyanaWallClockParts(now);
  const t = hour * 60 + minute;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = (dayOfWeek + ahead) % 7;
    const w = dayWindow(hours, day);
    if (w === 'CLOSED') continue;
    if (ahead === 0 && (w === 'ALL_DAY' || w.open <= t)) continue;
    const when = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : `on ${DAY_NAMES[day]}`;
    return w === 'ALL_DAY' ? when : `${when} at ${clockWords(w.open)}`;
  }
  return null;
}

/** THE rule: the manual switch AND the hours (the App Review fiction: the switch alone). */
export function storeOpenNow(
  vendor: { isCurrentlyOpen: boolean; isSynthetic?: boolean | null },
  hours: readonly HoursRow[],
  now: Date,
): boolean {
  return vendor.isCurrentlyOpen && (vendor.isSynthetic === true || hoursAllowNow(hours, now));
}

/** Per store: whether its hours allow an order now (true for a store with no hours, or the review fiction). */
export async function hoursOpenByVendor(db: Db, vendorIds: readonly string[], now: Date = new Date()): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(vendorIds)];
  if (ids.length === 0) return out;
  // One read of the hours table (never a second read of the store rows a list already chose). The App Review fiction's
  // hours are not read: a store with no hours keeps its switch.
  const rows = await db.operatingHours.findMany({
    where: { vendorId: { in: ids }, vendor: { isSynthetic: false } },
    select: { vendorId: true, ...HOURS_SELECT },
    orderBy: { dayOfWeek: 'asc' },
  });
  const byVendor = new Map<string, HoursRow[]>();
  for (const { vendorId, ...h } of rows) byVendor.set(vendorId, [...(byVendor.get(vendorId) ?? []), h]);
  for (const [vendorId, hours] of byVendor) out.set(vendorId, hoursAllowNow(hours, now));
  return out;
}

/** The rows with `isCurrentlyOpen` read as THE rule (switch AND hours). A store the read missed keeps its switch. */
export function withOpenNow<T extends { id: string; isCurrentlyOpen: boolean }>(rows: readonly T[], hoursOpen: Map<string, boolean>): T[] {
  return rows.map((r) => (r.isCurrentlyOpen && hoursOpen.get(r.id) === false ? { ...r, isCurrentlyOpen: false } : r));
}

/** Read the hours and apply THE rule to a list of store rows in one step. */
export async function applyOpenNow<T extends { id: string; isCurrentlyOpen: boolean }>(db: Db, rows: readonly T[], now: Date = new Date()): Promise<T[]> {
  return withOpenNow(rows, await hoursOpenByVendor(db, rows.filter((r) => r.isCurrentlyOpen).map((r) => r.id), now));
}

/** Dish rows (search, market): `vendorIsCurrentlyOpen` read as THE rule for the dish's store. */
export async function applyItemStoreOpenNow<T extends { vendorId: string; vendorIsCurrentlyOpen: boolean }>(db: Db, hits: readonly T[], now: Date = new Date()): Promise<T[]> {
  const open = await hoursOpenByVendor(db, hits.filter((h) => h.vendorIsCurrentlyOpen).map((h) => h.vendorId), now);
  return hits.map((h) => (h.vendorIsCurrentlyOpen && open.get(h.vendorId) === false ? { ...h, vendorIsCurrentlyOpen: false } : h));
}

/** The words for a store whose switch is on but whose hours say closed now ("It opens tomorrow at 8:00 am."). */
export function closedByHoursMessage(name: string, hours: readonly HoursRow[], now: Date): string {
  const next = nextOpeningWords(hours, now);
  return `${name} is closed right now (outside its opening hours).${next ? ` It opens ${next}.` : ''}`;
}

/**
 * Checkout: the VENDOR_CLOSED refusal for a store whose hours say closed now, or null when they allow the order.
 * The caller has already applied the switch (and the booking-only exception, which never reaches here).
 */
export async function storeHoursRefusal(db: Db, vendor: { id: string; name: string }, now: Date): Promise<AppError | null> {
  const row = await db.vendor.findUnique({
    where: { id: vendor.id },
    select: { isSynthetic: true, operatingHours: { select: HOURS_SELECT, orderBy: { dayOfWeek: 'asc' } } },
  });
  const hours = row?.operatingHours ?? [];
  if (!row || storeOpenNow({ isCurrentlyOpen: true, isSynthetic: row.isSynthetic }, hours, now)) return null;
  return new AppError(400, 'VENDOR_CLOSED', closedByHoursMessage(vendor.name, hours, now));
}

/** The store's own dashboard: whether its hours (not its switch) close it now, and when they open next. */
export function ownStoreHoursView(
  vendor: { isCurrentlyOpen: boolean; isSynthetic?: boolean | null; operatingHours?: readonly HoursRow[] | null },
  now: Date = new Date(),
): { closedByHoursNow: boolean; opensNext: string | null } {
  const hours = vendor.operatingHours ?? [];
  const closedByHoursNow = vendor.isCurrentlyOpen && !storeOpenNow({ ...vendor, isCurrentlyOpen: true }, hours, now);
  return { closedByHoursNow, opensNext: closedByHoursNow ? nextOpeningWords(hours, now) : null };
}
