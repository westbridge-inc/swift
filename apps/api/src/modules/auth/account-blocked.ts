import type { UserStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [NO-DEAD-ENDS · owner, 6 Oct] Nobody is stuck without a reason and a next step.
 *
 * An account Swift has suspended, banned or closed cannot start or keep a
 * session (L04 · AUTH-2). The refusal used to be one sentence for all three,
 * "This account is suspended.", with nowhere to go: a blocked person cannot
 * sign in to reach Get Help or the appeal route. The refusal now says which
 * state the account is in and the one door that works without a session:
 * support's mailbox, which a person answers.
 *
 * Every app shows `message` verbatim (the store build in review included), so
 * the next step lives in the message itself. `details` lets a newer app offer
 * the door as a button. The code and status are unchanged: 403
 * ACCOUNT_SUSPENDED for every blocked state, as every client already expects.
 *
 * The admin's typed reason is NOT quoted here: it is written for the permanent
 * record and may name other people or internal signals. Support answers the
 * "why" by email.
 */
export type BlockedAccountStatus = Extract<UserStatus, 'SUSPENDED' | 'BANNED' | 'DEACTIVATED'>;

export const BLOCKED_ACCOUNT_STATUSES: ReadonlySet<UserStatus> = new Set<BlockedAccountStatus>(['SUSPENDED', 'BANNED', 'DEACTIVATED']);

/** The mailbox the apps also show on Contact Us (it receives mail; owner, 1 Oct). */
export const SUPPORT_EMAIL_FALLBACK = 'support@swiftgy.com';

const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** The deployment's support address when it is configured and well formed, else the default mailbox. */
export function supportEmail(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env['SUPPORT_EMAIL']?.trim();
  return configured && EMAIL_SHAPE.test(configured) ? configured : SUPPORT_EMAIL_FALLBACK;
}

export function isBlockedAccountStatus(status: string | null | undefined): status is BlockedAccountStatus {
  return status != null && BLOCKED_ACCOUNT_STATUSES.has(status as UserStatus);
}

export function blockedAccountMessage(status: BlockedAccountStatus, email: string = supportEmail()): string {
  switch (status) {
    case 'BANNED':
      return `Swift has closed this account, so it can't sign in. If you think this is a mistake, email ${email} with your phone number and a person will review it.`;
    case 'DEACTIVATED':
      return `This account has been closed, so it can't sign in. If you need help with it, email ${email} with your phone number.`;
    case 'SUSPENDED':
    default:
      return `Your Swift account is suspended, so it can't sign in right now. Email ${email} with your phone number and Swift will tell you why and what you can do to restore it.`;
  }
}

/** The one refusal every sign-in, refresh and credential path gives a blocked account. */
export function accountBlockedError(status: BlockedAccountStatus): AppError {
  const email = supportEmail();
  return new AppError(403, 'ACCOUNT_SUSPENDED', blockedAccountMessage(status, email), {
    accountStatus: status,
    supportEmail: email,
    nextStep: 'EMAIL_SUPPORT',
  });
}
