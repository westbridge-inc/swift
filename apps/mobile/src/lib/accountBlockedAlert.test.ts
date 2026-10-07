import { beforeEach, describe, expect, it, vi } from 'vitest';

const { alert, openURL } = vi.hoisted(() => ({ alert: vi.fn(), openURL: vi.fn(() => Promise.resolve()) }));
vi.mock('react-native', () => ({ Alert: { alert }, Linking: { openURL } }));

import { explainSessionEnded } from './accountBlockedAlert';

// [NO-DEAD-ENDS] Swift suspended the account mid-session: the sign-out says
// why and offers support's mailbox; every other ended session stays quiet.

beforeEach(() => {
  alert.mockClear();
  openURL.mockClear();
});

describe('explainSessionEnded', () => {
  it('tells a suspended person why they were signed out, with the mail door', () => {
    const shown = explainSessionEnded({ response: { status: 403, data: { error: {
      code: 'ACCOUNT_SUSPENDED',
      message: 'Your Swift account is suspended, so it can’t sign in right now. Email support@swiftgy.com with your phone number.',
      details: { accountStatus: 'SUSPENDED', supportEmail: 'support@swiftgy.com' },
    } } } });

    expect(shown).toBe(true);
    expect(alert).toHaveBeenCalledOnce();
    const [title, message, buttons] = alert.mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
    expect(title).toMatch(/signed out/i);
    expect(message).toMatch(/suspended/i);
    const door = buttons.find((button) => button.text === 'Email support');
    door?.onPress?.();
    expect(openURL).toHaveBeenCalledWith(expect.stringMatching(/^mailto:support@swiftgy\.com\?/));
  });

  it('stays quiet for an ordinary expired or revoked session', () => {
    expect(explainSessionEnded({ response: { status: 401, data: { error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' } } } })).toBe(false);
    expect(explainSessionEnded(new Error('Network Error'))).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
