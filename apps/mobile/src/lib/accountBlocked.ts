/**
 * [NO-DEAD-ENDS · owner, 6 Oct] A blocked account is never a dead end.
 *
 * An account Swift suspended, banned or closed is refused at sign-in and at
 * token refresh with 403 ACCOUNT_SUSPENDED. Every in-app door (Get Help, the
 * appeal) needs the session that was just refused, so the one door left is
 * support's mailbox, which a person answers. The server says which state the
 * account is in and where to write (`error.details`); this reads it and falls
 * back to the same mailbox Contact Us shows when an older server does not.
 *
 * Kept free of React Native imports so it is unit-testable.
 */
export const SWIFT_SUPPORT_EMAIL = 'support@swiftgy.com';

export type BlockedAccountStatus = 'SUSPENDED' | 'BANNED' | 'DEACTIVATED';

export interface AccountBlocked {
  /** null when an older server sent only the code. */
  status: BlockedAccountStatus | null;
  /** The server's sentence, verbatim, or a plain fallback. */
  message: string;
  supportEmail: string;
}

const EMAIL_SHAPE = /^[^\s@<>"?&#]+@[^\s@<>"?&#]+\.[^\s@<>"?&#]+$/;
const STATUSES: readonly BlockedAccountStatus[] = ['SUSPENDED', 'BANNED', 'DEACTIVATED'];

const FALLBACK_MESSAGE: Record<BlockedAccountStatus | 'UNKNOWN', string> = {
  SUSPENDED: `Your Swift account is suspended, so it can't sign in right now. Email ${SWIFT_SUPPORT_EMAIL} with your phone number and Swift will tell you why and what you can do to restore it.`,
  BANNED: `Swift has closed this account, so it can't sign in. If you think this is a mistake, email ${SWIFT_SUPPORT_EMAIL} with your phone number and a person will review it.`,
  DEACTIVATED: `This account has been closed, so it can't sign in. If you need help with it, email ${SWIFT_SUPPORT_EMAIL} with your phone number.`,
  UNKNOWN: `This account can't sign in right now. Email ${SWIFT_SUPPORT_EMAIL} with your phone number and Swift will tell you why.`,
};

/** The blocked-account refusal inside an axios error, or null for any other failure. */
export function accountBlockedOf(error: unknown): AccountBlocked | null {
  const body = (error as { response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown; details?: unknown } } } })
    ?.response;
  const refusal = body?.data?.error;
  if (body?.status !== 403 || refusal?.code !== 'ACCOUNT_SUSPENDED') return null;
  const details = (refusal.details ?? {}) as { accountStatus?: unknown; supportEmail?: unknown };
  const status = STATUSES.includes(details.accountStatus as BlockedAccountStatus)
    ? (details.accountStatus as BlockedAccountStatus)
    : null;
  const supportEmail = typeof details.supportEmail === 'string' && EMAIL_SHAPE.test(details.supportEmail.trim())
    ? details.supportEmail.trim()
    : SWIFT_SUPPORT_EMAIL;
  const serverMessage = typeof refusal.message === 'string' ? refusal.message.trim() : '';
  // A server that names the state also wrote the next step into its sentence.
  // An older one said only "This account is suspended." for every blocked
  // state, with no next step: say one here, without guessing the state.
  const message = status && serverMessage ? serverMessage : FALLBACK_MESSAGE[status ?? 'UNKNOWN'];
  return { status, message, supportEmail };
}

/** A mail draft to support that names the account by its phone number (the person's own, on their own phone). */
export function accountSupportMailto(blocked: AccountBlocked, phone?: string | null): string {
  const subject = blocked.status === 'BANNED' ? 'Please review my closed Swift account' : 'Help with my Swift account';
  const body = phone ? `My Swift phone number is ${phone}.` : 'My Swift phone number is: ';
  return `mailto:${blocked.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
