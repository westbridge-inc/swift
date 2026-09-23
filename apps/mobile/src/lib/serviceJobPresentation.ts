const MAX_TIMER_DELAY_MS = 2_147_000_000;

const AGREED_PRICE_STATUSES = new Set(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED']);

export function showsServiceJobAgreedPrice(status: string): boolean {
  return AGREED_PRICE_STATUSES.has(status);
}

/** Parse the provider's quote without silently rounding sub-cent input. */
export function parseServiceQuoteInput(input: string): number | null {
  const normalized = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 100_000_000) return null;
  return amount;
}

/**
 * Fastify's canonical AppError envelope is `{ error: { message } }`. Retain
 * the old top-level fallback for non-AppError responses, but never hide the
 * actionable server reason behind generic copy.
 */
export function serviceJobErrorMessage(error: unknown, fallback: string): string {
  const responseData = (error as any)?.response?.data;
  return responseData?.error?.message ?? responseData?.message ?? fallback;
}

export type ServiceJobScheduleDay = Readonly<{
  key: string;
  label: string;
}>;

function localCalendarKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The schedule chips describe the customer's local calendar. Keep their
 * identity in that same calendar rather than deriving a UTC date key from a
 * local Date, which changes "Today" after a UTC rollover.
 */
export function serviceJobScheduleDays(now: Date = new Date()): ServiceJobScheduleDay[] {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid current date');

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + index);
    return {
      key: localCalendarKey(day),
      label: index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : day.toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
    };
  });
}

/** Build the API instant from the selected local calendar day and wall time. */
export function localServiceJobDateTime(dayKey: string, time: string): Date {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  const timeParts = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dateParts || !timeParts) throw new RangeError('Invalid local service-job slot');

  const [, yearText, monthText, dayText] = dateParts;
  const [, hourText, minuteText] = timeParts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const scheduledFor = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (
    scheduledFor.getFullYear() !== year
    || scheduledFor.getMonth() !== month - 1
    || scheduledFor.getDate() !== day
    || scheduledFor.getHours() !== hour
    || scheduledFor.getMinutes() !== minute
  ) {
    throw new RangeError('Invalid local service-job slot');
  }
  return scheduledFor;
}

export function serviceJobDueDelayMs(scheduledFor: string, nowMs: number): number {
  const dueAt = new Date(scheduledFor).getTime();
  if (!Number.isFinite(dueAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, dueAt - nowMs);
}

/**
 * Arm a due-time wakeup without assuming the native timer can span an
 * arbitrarily distant date. The callback re-arms after each safe segment and
 * fires exactly once after the server-provided scheduled instant is reached.
 */
export function armServiceJobDueWakeup(
  scheduledFor: string,
  now: () => number,
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
  onDue: () => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (cancelled) return;
    const remaining = serviceJobDueDelayMs(scheduledFor, now());
    if (remaining <= 0) {
      onDue();
      return;
    }
    timer = setTimer(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };

  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimer(timer);
  };
}
