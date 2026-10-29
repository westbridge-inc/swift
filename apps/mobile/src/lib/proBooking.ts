// ---------------------------------------------------------------------------
// [BOOK-P3] Booking a pro from their list of services: what the SERVER says,
// read for the phone's screens. The app authors no rule of its own (notice,
// cut-off, horizon, caps, price, the pro's agreement): it shows the server's
// times, the server's verdicts (the job's `appointment` view) and the server's
// words when it refuses.
// ---------------------------------------------------------------------------
import { addAppointmentDays, appointmentWeekday, formatAppointmentDay } from './appointmentTime';
import { serviceJobCancelView } from './serviceJobPresentation';

export interface ProOffering {
  id: string;
  name: string;
  durationMinutes: number;
  /** GYD, the fixed price the customer is shown and books at. */
  price: number;
}

export interface ProOfferingsAnswer {
  providerId: string;
  tradeLabel: string;
  offerings: ProOffering[];
  bookableWeekdays: number[];
  minNoticeMinutes: number;
  horizonDays?: number;
  paymentMethod: 'CASH';
}

/** The appointment view the server adds to a job booked from a pro's list (customer only). */
export interface ServiceAppointmentView {
  canCancel: boolean;
  freeCancellationExpiresAt: string | null;
  cancellationMessage: string | null;
  cancelUnavailable: { code: string; message: string } | null;
  canReschedule: boolean;
  rescheduleUnavailable: { code: string; message: string } | null;
}

/** Strict read of the server's appointment view: anything malformed is no view. */
export function readAppointmentView(value: unknown): ServiceAppointmentView | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as {
    canCancel?: unknown; freeCancellationExpiresAt?: unknown; cancellationMessage?: unknown; cancelUnavailable?: unknown;
    canReschedule?: unknown; rescheduleUnavailable?: unknown;
  };
  if (typeof v.canCancel !== 'boolean' || typeof v.canReschedule !== 'boolean') return null;
  const reason = (r: unknown) => (r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string'
    ? { code: String((r as { code?: unknown }).code ?? ''), message: (r as { message: string }).message }
    : null);
  return {
    canCancel: v.canCancel,
    freeCancellationExpiresAt: typeof v.freeCancellationExpiresAt === 'string' ? v.freeCancellationExpiresAt : null,
    cancellationMessage: typeof v.cancellationMessage === 'string' ? v.cancellationMessage : null,
    cancelUnavailable: reason(v.cancelUnavailable),
    canReschedule: v.canReschedule,
    rescheduleUnavailable: reason(v.rescheduleUnavailable),
  };
}

/** A job booked from a pro's list of services (it carries the service it was booked for). */
export function isListBookedJob(job: { offeringId?: unknown; scheduledFor?: unknown }): boolean {
  return typeof job.offeringId === 'string' && job.offeringId.length > 0 && typeof job.scheduledFor === 'string';
}

export interface JobControls {
  canCancel: boolean;
  /** Words shown instead of a Cancel button (who to contact), or null. */
  contactWords: string | null;
  /** "Free to cancel until …" (an ISO instant), or null. */
  freeCancelUntil: string | null;
  /** The pro is very late: the server's words for the free cancel, or null. */
  cancelNote: string | null;
  canMove: boolean;
  /** Words shown instead of "Change time", or null. */
  moveWords: string | null;
}

const CLOSED = new Set(['COMPLETED', 'CANCELLED']);

/**
 * What one job card offers. The CUSTOMER of a list-booked job reads the server's appointment view (B1/B2:
 * free cancel and move until two hours before; null view = the switch is off, so the quote-job rule). The
 * PRO cancels a live job and moves a list-booked one at any time (B2), as the server allows. Everything
 * else keeps the quote-job rule (serviceJobPresentation).
 */
export function serviceJobControls(job: { status: string; offeringId?: unknown; scheduledFor?: unknown; appointment?: unknown }, isCustomer: boolean): JobControls {
  const none: JobControls = { canCancel: false, contactWords: null, freeCancelUntil: null, cancelNote: null, canMove: false, moveWords: null };
  if (CLOSED.has(job.status)) return none;
  const listBooked = isListBookedJob(job);
  // The quote-job rule, unchanged (who cancels when, and who to contact).
  const quoteRule = serviceJobCancelView(job.status, isCustomer);
  if (!isCustomer) return { ...none, canCancel: quoteRule.canCancel, canMove: listBooked && job.status === 'SCHEDULED' };
  const view = listBooked ? readAppointmentView(job.appointment) : null;
  if (!view) return { ...none, canCancel: quoteRule.canCancel, contactWords: quoteRule.contactWords };
  return {
    canCancel: view.canCancel,
    contactWords: view.canCancel ? null : view.cancelUnavailable?.message ?? null,
    freeCancelUntil: view.canCancel ? view.freeCancellationExpiresAt : null,
    cancelNote: view.canCancel ? view.cancellationMessage : null,
    canMove: view.canReschedule,
    moveWords: view.canReschedule ? null : view.rescheduleUnavailable?.message ?? null,
  };
}

export interface BookingDay {
  key: string;
  label: string;
  /** No hours that weekday: shown, not selectable. */
  closed: boolean;
}

/** The day strip: today and the next `count - 1` days, never past the server's horizon. */
export function bookingDays(todayKey: string, count: number, bookableWeekdays: readonly number[] | undefined, horizonDays?: number): BookingDay[] {
  const n = horizonDays != null ? Math.min(count, horizonDays + 1) : count;
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    const key = addAppointmentDays(todayKey, i);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatAppointmentDay(key);
    return { key, label, closed: bookableWeekdays ? !bookableWeekdays.includes(appointmentWeekday(key)) : false };
  });
}

/** Whole days from one Guyana date key to another (YYYY-MM-DD). */
export function daysBetween(fromKey: string, toKey: string): number {
  const at = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((at(toKey) - at(fromKey)) / 86_400_000);
}

/** How many days a move's strip shows: two weeks, and always a week past the booked day. */
export function moveStripLength(todayKey: string, bookedKey: string): number {
  return Math.max(14, daysBetween(todayKey, bookedKey) + 8);
}

/** "1 hr 30 min", "45 min". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** The server's refusal code, if any. */
export function apiErrorCode(error: unknown): string | null {
  const code = (error as { response?: { data?: { error?: { code?: unknown } } } })?.response?.data?.error?.code;
  return typeof code === 'string' ? code : null;
}

/** After a refusal: reload the times (someone took it, or it is no longer open) or the services (the price changed). */
export function bookingRefusalRefresh(error: unknown): 'slots' | 'offerings' | null {
  const code = apiErrorCode(error);
  if (code === 'SLOT_TAKEN' || code === 'SLOT_UNAVAILABLE' || code === 'TOO_SOON' || code === 'SLOT_IN_PAST' || code === 'TOO_FAR_AHEAD') return 'slots';
  if (code === 'PRICE_CHANGED' || code === 'OFFERING_UNAVAILABLE') return 'offerings';
  return null;
}

// --- The pro's weekly hours ------------------------------------------------

export interface HoursWindow { dayOfWeek: number; start: string; end: string }

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A typed "9:00" / "09:00" / "17:30" as HH:MM, or null. */
export function normalizeClock(input: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(input);
  if (!m) return null;
  const v = `${m[1]!.padStart(2, '0')}:${m[2]}`;
  return HHMM.test(v) ? v : null;
}

/** The weekly hours with one day's windows replaced (sorted as the server stores them). */
export function withDayWindows(hours: readonly HoursWindow[], dayOfWeek: number, windows: ReadonlyArray<{ start: string; end: string }>): HoursWindow[] {
  return [...hours.filter((w) => w.dayOfWeek !== dayOfWeek), ...windows.map((w) => ({ dayOfWeek, start: w.start, end: w.end }))]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.start.localeCompare(b.start));
}

/** "Mon 09:00–13:00, 14:00–17:00" lines, one per open day. */
export function hoursSummary(hours: readonly HoursWindow[]): string[] {
  return WEEKDAY_NAMES.map((name, d) => {
    const day = hours.filter((w) => w.dayOfWeek === d).sort((a, b) => a.start.localeCompare(b.start));
    return day.length ? `${name.slice(0, 3)} ${day.map((w) => `${w.start}–${w.end}`).join(', ')}` : null;
  }).filter((l): l is string => l != null);
}
