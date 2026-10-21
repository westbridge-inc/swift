// [COORD 18 Oct 20:33Z] What a billing log line may say about a failure: a
// short code word only. An error's message (and its stack) can carry personal
// data (a name, a phone number, an address inside a database message), so a
// line that leaves the billing run names the code: an AppError's code, a
// database error's code (P2002), or the error's class (TypeError), else
// UNKNOWN. Never free text.
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function billingErrorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && CODE.test(name)) return name;
  }
  return 'UNKNOWN';
}
