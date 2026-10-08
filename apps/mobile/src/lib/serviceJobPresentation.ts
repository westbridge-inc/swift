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
