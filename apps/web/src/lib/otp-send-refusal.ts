/**
 * [SIGNUP-PHONE · owner 1 Nov 2026] What the person reads when the server refuses to send a code. Never silence and
 * never a generic failure: a refused number (400: the request's shape, or a number outside Guyana) and an SMS the
 * provider would not deliver to that number (502 SMS_SEND_FAILED) both ask for the number again; a throttle (429)
 * says how long to wait, from the server's own Retry-After / retryAfterSeconds or the minutes in its message.
 */
export const NUMBER_LOOKS_WRONG = "That number doesn't look right: enter the 7-digit number after +592.";

function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function otpSendRefusal(status: number, body: unknown, retryAfterHeader: string | null = null): string {
  const error = (body as { error?: { message?: unknown; details?: { retryAfterSeconds?: unknown; codeAlreadySent?: unknown } } } | null)?.error;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (status === 400 || status === 502) return NUMBER_LOOKS_WRONG;
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
    return 'Too many tries; wait a few minutes, then ask for a new code.';
  }
  return message || 'Could not send the code. Check your connection and try again.';
}
