import { describe, expect, it } from 'vitest';
import { accountBlockedOf, accountSupportMailto, SWIFT_SUPPORT_EMAIL } from './accountBlocked';

// [NO-DEAD-ENDS] The blocked-account refusal is read the same way on the code
// screen and when a refresh ends the session.

const refused = (error: Record<string, unknown>, status = 403) => ({ response: { status, data: { success: false, error } } });

describe('accountBlockedOf', () => {
  it('reads the state, the server sentence and the mailbox from the current server', () => {
    const message = 'Your Swift account is suspended, so it can’t sign in right now. Email help@example.gy with your phone number and Swift will tell you why and what you can do to restore it.';
    expect(accountBlockedOf(refused({
      code: 'ACCOUNT_SUSPENDED',
      message,
      details: { accountStatus: 'SUSPENDED', supportEmail: 'help@example.gy', nextStep: 'EMAIL_SUPPORT' },
    }))).toEqual({ status: 'SUSPENDED', message, supportEmail: 'help@example.gy' });
  });

  it('gives an older server’s bare refusal a next step instead of a dead end', () => {
    const blocked = accountBlockedOf(refused({ code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended.' }));
    expect(blocked?.status).toBeNull();
    expect(blocked?.supportEmail).toBe(SWIFT_SUPPORT_EMAIL);
    expect(blocked?.message).toMatch(/can't sign in/);
    expect(blocked?.message).toContain(SWIFT_SUPPORT_EMAIL);
    expect(blocked?.message).not.toBe('This account is suspended.');
  });

  it('never trusts a malformed mailbox from the wire', () => {
    for (const supportEmail of ['', 'nobody', 'x@y', 'a@b.gy?cc=evil@x.gy', 42]) {
      expect(accountBlockedOf(refused({ code: 'ACCOUNT_SUSPENDED', message: 'm', details: { accountStatus: 'BANNED', supportEmail } }))?.supportEmail, String(supportEmail))
        .toBe(SWIFT_SUPPORT_EMAIL);
    }
  });

  it('is null for every other failure', () => {
    expect(accountBlockedOf(refused({ code: 'ACCOUNT_SUSPENDED', message: 'x' }, 401))).toBeNull();
    expect(accountBlockedOf(refused({ code: 'INVALID_OTP', message: 'Invalid or expired OTP' }, 400))).toBeNull();
    expect(accountBlockedOf(refused({ code: 'FORBIDDEN', message: 'nope' }))).toBeNull();
    expect(accountBlockedOf(new Error('Network Error'))).toBeNull();
    expect(accountBlockedOf(undefined)).toBeNull();
  });
});

describe('accountSupportMailto', () => {
  it('drafts a mail to the mailbox that names the person’s own number, encoded', () => {
    const url = accountSupportMailto({ status: 'BANNED', message: 'm', supportEmail: SWIFT_SUPPORT_EMAIL }, '+5926001234');
    expect(url.startsWith(`mailto:${SWIFT_SUPPORT_EMAIL}?subject=`)).toBe(true);
    expect(decodeURIComponent(url)).toContain('Please review my closed Swift account');
    expect(decodeURIComponent(url)).toContain('My Swift phone number is +5926001234.');
    expect(url).not.toContain(' ');
  });
});
