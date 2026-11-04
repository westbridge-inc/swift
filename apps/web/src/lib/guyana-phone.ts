/**
 * [SIGNUP-PHONE · owner 1 Nov 2026] The sign-up phone field holds only the local number beside a fixed +592 chip,
 * like sign-in and the app (apps/mobile lib/phone clampPhone: a pasted copy of the calling code is dropped, never
 * kept as part of the number). Every normal way of typing a Guyana number reaches the server on the FIRST try:
 *   "6001234", "600 1234", "600-1234", "0600 1234" (trunk 0), "+592 600 1234", "592 600 1234", "(592) 600-1234",
 *   "00592 600 1234"  ->  "+5926001234".
 * The server (apps/api utils/phone normalizePhone) strips formatting itself but cannot guess a country for a number
 * without a "+", so the site always sends +592 and the seven digits.
 */
export const GUYANA_DIAL_CODE = '+592';

/** The local digits in what was typed or pasted: formatting, a copy of Guyana's code and a trunk 0 dropped. */
export function guyanaLocal(typed: string): string {
  let digits = typed.replace(/\D/g, '');
  if (digits.startsWith('00592')) digits = digits.slice(5);
  else if (digits.startsWith('592') && (digits.length >= 10 || typed.trimStart().startsWith('+') || typed.trimStart().startsWith('('))) digits = digits.slice(3);
  if (digits.length === 8 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/** The number the server is sent: +592 and the seven local digits. */
export function guyanaPhone(typed: string): string {
  return `${GUYANA_DIAL_CODE}${guyanaLocal(typed)}`;
}

/** Why the number cannot be sent yet, in words for under the field; null when it can (or nothing is typed yet). */
export function guyanaPhoneProblem(typed: string): string | null {
  const local = guyanaLocal(typed);
  if (local.length === 0) return null;
  if (!/^[67]/.test(local)) return 'Guyana mobile numbers start with 6 or 7.';
  if (local.length > 7) return 'That is too many digits: enter the 7-digit number after +592.';
  return null;
}

/** Ready to send: seven digits starting with 6 or 7. */
export function guyanaPhoneReady(typed: string): boolean {
  return /^[67]\d{6}$/.test(guyanaLocal(typed));
}

/** [FLOW-QA F23] The number as people read it: "+592 600 9121". */
export function guyanaDisplay(typed: string): string {
  const local = guyanaLocal(typed);
  return local.length === 7 ? `${GUYANA_DIAL_CODE} ${local.slice(0, 3)} ${local.slice(3)}` : `${GUYANA_DIAL_CODE} ${local}`;
}
