// The API's per-number OTP resend window, as the auth screens use it.
//
// send-otp answers a resend inside the window with HTTP 429 RATE_LIMITED and
// details { retryAfterSeconds, codeAlreadySent }: how long until a new code
// may be requested, and whether the code sent moments ago is out (it stays
// valid for minutes, well past the window). That is not a wrong number, so it
// never flags the phone field. The hourly cap and the daily SMS budgets are
// 429 RATE_LIMITED too but carry no details — they are not this, and keep
// their own copy.

/** Mirrors the API window (apps/api/src/utils/otp.ts OTP_RESEND_WINDOW_S): a
 *  new code unlocks this long after a send. A refusal re-syncs to the
 *  server's own figure anyway. */
export const OTP_RESEND_WINDOW_S = 60;

export interface OtpCooldown {
  /** Whole seconds until this number may request another code. */
  retryAfterSeconds: number;
  /** The code sent moments ago is out: offer code entry, not a dead end. */
  codeAlreadySent: boolean;
}

/** The resend window refusal inside a failed send-otp call, or null for any
 *  other failure (foreign number, hourly cap, budget, network). */
export function otpCooldownOf(error: unknown): OtpCooldown | null {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null | undefined)?.response;
  if (response?.status !== 429) return null;
  const body = (response.data as { error?: { code?: unknown; details?: unknown } } | null | undefined)?.error;
  if (body?.code !== 'RATE_LIMITED') return null;
  const details = body.details as { retryAfterSeconds?: unknown; codeAlreadySent?: unknown } | null | undefined;
  const seconds = details?.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { retryAfterSeconds: Math.ceil(seconds), codeAlreadySent: details?.codeAlreadySent === true };
}

/** "42s" — the resend wait as the auth screens print it: whole seconds,
 *  rounded up, never "0s" while the wait is still on. */
export function formatResendWait(seconds: number): string {
  return `${Math.max(1, Math.ceil(seconds))}s`;
}

/** Whole seconds left until a wall-clock deadline, rounded up; 0 once past. */
export function secondsUntil(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}
