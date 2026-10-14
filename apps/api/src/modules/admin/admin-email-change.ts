import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { getChannels } from '../../providers/notifications/channels';

/**
 * [OWNER #13 · Opus money review S2, 14 Oct 2026] The email on an ADMIN
 * account is where solo approval sends the owner's "you can still cancel"
 * warning. A session alone must never be able to point it somewhere else:
 *
 *   - changing it takes a fresh sign-in code (the step-up, spent by the change);
 *   - the OLD address is told before the change is written — no notice, no
 *     change (user/profile-update.ts);
 *   - every change is dated (users.emailChangedAt), and solo approval stays off
 *     for EMAIL_CHANGE_SOLO_QUIET_DAYS afterwards (solo-approval.ts), so a
 *     redirected address can never carry a solo warning.
 *
 * Customers are untouched: their change needs no code and sends no notice.
 */

/** Days after an email change during which solo approval stays off. */
export const EMAIL_CHANGE_SOLO_QUIET_DAYS = 7;
export const EMAIL_CHANGE_SOLO_QUIET_MS = EMAIL_CHANGE_SOLO_QUIET_DAYS * 24 * 60 * 60 * 1000;

const ADMIN_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'SUPER_ADMIN']);

/** An account that holds an admin role — active now or not (a second hat still counts). */
export function isAdminAccount(user: { activeRole: string; roles: readonly string[] }): boolean {
  return ADMIN_ROLES.has(user.activeRole) || user.roles.some((role) => ADMIN_ROLES.has(role));
}

/** When solo approval is allowed again after an email change, or null when it already is. */
export function soloQuietUntil(emailChangedAt: Date | null | undefined, now: Date): Date | null {
  if (!emailChangedAt) return null;
  const until = new Date(emailChangedAt.getTime() + EMAIL_CHANGE_SOLO_QUIET_MS);
  return until.getTime() > now.getTime() ? until : null;
}

/** "o•••@example.com": enough for the owner to recognise it, not a copy of it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/**
 * Tell the OLD address that an admin account's email is changing. Sent before
 * the change is written: a send that fails, or that a store-review seal
 * suppresses, refuses the change and nothing is written. (A write that then
 * fails leaves a notice about a change that did not happen: the safe side.)
 */
export async function sendAdminEmailChangeNotice(oldAddress: string, newAddress: string, at: Date): Promise<void> {
  const when = `${at.toLocaleString('en-GB', { timeZone: 'America/Guyana', dateStyle: 'medium', timeStyle: 'short' })} (Guyana time)`;
  const body = [
    'The email address on your Swift admin account is being changed.',
    '',
    `  New address: ${maskEmail(newAddress)}`,
    `  Changed: ${when}`,
    '',
    'It was confirmed with a sign-in code sent to the phone on your account.',
    `Solo approval stays off for ${EMAIL_CHANGE_SOLO_QUIET_DAYS} days after any email change.`,
    '',
    // [Opus S4-1] After a SIM swap the thief also receives the sign-in code: the carrier comes first.
    'If this was not you: call your carrier to lock your SIM, then change it back and sign out of every device.',
  ].join('\n');
  let ref: string;
  try {
    ({ ref } = await getChannels().email.sendEmail(oldAddress, 'Swift: the email on your admin account is being changed', body));
  } catch (err) {
    log().error({ err }, '[admin email change] notice to the old address could not be sent — refusing the change');
    throw noticeUnavailable();
  }
  if (!ref || ref === 'review-suppressed') throw noticeUnavailable();
}

function noticeUnavailable(): AppError {
  return new AppError(503, 'EMAIL_CHANGE_NOTICE_UNAVAILABLE',
    "An admin account's email changes only after Swift tells the old address, and Swift's email is not working right now. Nothing changed. Try again later.");
}
