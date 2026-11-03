/**
 * [SIGNUP-PHONE · owner 1 Nov 2026] What the person reads when the server refuses to send a code. Never silence and
 * never a generic failure: a refused number (400: the request's shape, or a number outside Guyana) asks for the
 * number again; a failed SMS (502 SMS_SEND_FAILED, any provider failure: the number is not blamed) says to try again
 * in a moment, in the server's words as the app shows them; a throttle (429) says how long to wait, from the
 * server's retryAfterSeconds or the minutes in its message, and a daily cap with no time says "later".
 */
export const NUMBER_LOOKS_WRONG = 'That number doesn’t look right: enter the 7-digit number after +592.';
export const SMS_NOT_SENT = 'We couldn’t send the code just now. Try again in a moment.';
export const TRY_LATER = 'Too many tries right now. Try again later.';

function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function otpSendRefusal(status: number, body: unknown, retryAfterHeader: string | null = null): string {
  const error = (body as { error?: { message?: unknown; details?: { retryAfterSeconds?: unknown; codeAlreadySent?: unknown } } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (status === 400) return NUMBER_LOOKS_WRONG;
  if (status === 502) return message || SMS_NOT_SENT;
  if (status === 429) {
    const fromBody = error?.details?.retryAfterSeconds;
    const fromHeader = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const seconds = typeof fromBody === 'number' && fromBody > 0 ? fromBody : fromHeader > 0 ? fromHeader : NaN;
    if (Number.isFinite(seconds)) {
      // The code sent moments ago is on its way: say so, so nobody asks again and again.
      if (error?.details?.codeAlreadySent === true) return `We already sent a code to this number. Wait ${waitWords(Math.ceil(seconds))} to ask for a new one.`;
      return `Too many tries; wait ${waitWords(Math.ceil(seconds))}.`;
    }
    const minutes = message.match(/(\d+)\s*minute/);
    if (minutes) return `Too many tries; wait ${waitWords(Number(minutes[1]) * 60)}.`;
    return TRY_LATER;
  }
  return message || 'Could not send the code. Check your connection and try again.';
}

/** [FLOW-QA F16] A refused code check, in plain words. Errors the page raised itself (no status) keep their words. */
export const CODE_NOT_RIGHT = 'That code isn’t right — check the latest text from Swift.';
/** [REVIEW-GMF2 S3-2] A locked or expired code is not a wrong one: the way on is a new code. */
export const CODE_LOCKED = 'Too many tries for this code. Send a new code.';
export const CODE_EXPIRED = 'That code has expired. Send a new code.';
export function otpVerifyRefusal(error: unknown): string {
  const e = error as { message?: unknown; status?: unknown; code?: unknown; retryAfterSeconds?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (e?.status === 429) {
    const seconds = typeof e.retryAfterSeconds === 'number' && e.retryAfterSeconds > 0 ? Math.ceil(e.retryAfterSeconds) : NaN;
    return Number.isFinite(seconds) ? `Too many tries; wait ${waitWords(seconds)}.` : 'Too many tries; wait a minute, then try again.';
  }
  if (e?.code === 'INVALID_OTP' || e?.status === 400) {
    // the server's reasons (utils/otp): "Too many attempts. Request a new OTP." / "OTP expired or not found. Request a new one."
    if (/too many attempts/i.test(message)) return CODE_LOCKED;
    if (/expired|not found/i.test(message)) return CODE_EXPIRED;
    return CODE_NOT_RIGHT;
  }
  return message || 'Could not check the code. Check your connection and try again.';
}
