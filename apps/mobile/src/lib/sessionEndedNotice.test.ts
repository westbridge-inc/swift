import { beforeEach, describe, expect, it, vi } from 'vitest';

const { alert, openURL } = vi.hoisted(() => ({ alert: vi.fn(), openURL: vi.fn(() => Promise.resolve()) }));
vi.mock('react-native', () => ({ Alert: { alert }, Linking: { openURL } }));

import { SIGNED_OUT_MESSAGE, SIGNED_OUT_TITLE, noticeSessionEnded } from './sessionEndedNotice';

// [Row 3] A session the server ended is no longer a silent sign-out: the person
// is told, with one tap back to sign-in. A suspended account keeps its own words.

beforeEach(() => { alert.mockClear(); openURL.mockClear(); });

const expired = { response: { status: 401, data: { error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' } } } };

describe('noticeSessionEnded', () => {
  it('an expired or revoked session says so, and "Sign in" goes straight to sign-in', () => {
    const signIn = vi.fn();
    noticeSessionEnded(expired, signIn);
    expect(alert).toHaveBeenCalledOnce();
    const [title, message, buttons] = alert.mock.calls[0] as unknown as [string, string, Array<{ text: string; style?: string; onPress?: () => void }>];
    expect([title, message]).toEqual([SIGNED_OUT_TITLE, SIGNED_OUT_MESSAGE]);
    expect(title).toBe('You’ve been signed out');
    expect(buttons.map((b) => b.text)).toEqual(['Not now', 'Sign in']);
    expect(signIn).not.toHaveBeenCalled();
    buttons.find((b) => b.text === 'Sign in')?.onPress?.();
    expect(signIn).toHaveBeenCalledOnce();
  });

  it('a suspended account keeps its own explanation, never both', () => {
    noticeSessionEnded({ response: { status: 403, data: { error: {
      code: 'ACCOUNT_SUSPENDED', message: 'Your Swift account is suspended, so it can’t sign in right now.',
      details: { accountStatus: 'SUSPENDED', supportEmail: 'support@swiftgy.com' },
    } } } }, vi.fn());
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![1]).toMatch(/suspended/i);
    expect(alert.mock.calls[0]![1]).not.toBe(SIGNED_OUT_MESSAGE);
  });

  it('never throws when there is no native alert to show it with', () => {
    alert.mockImplementationOnce(() => { throw new Error('no native module'); });
    expect(() => noticeSessionEnded(expired, vi.fn())).not.toThrow();
  });
});
