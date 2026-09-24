import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// [Q2-OTP] The resend-window dead end, mounted. The REAL mobile phone step and
// verify screen run in the DOM test host; only the native drawing primitives,
// the kit, navigation, the auth store and the transport are replaced. The kit
// double renders the phone field's error state as aria-invalid plus the error
// line — the red field the owner saw on the device. Refusals are the exact
// bodies the API pins in apps/api/src/__tests__/otp-cooldown-honesty.test.ts.

const nav = vi.hoisted(() => ({ navigate: vi.fn(), params: {} as Record<string, unknown> }));
const auth = vi.hoisted(() => ({ sendOtp: vi.fn(), verifyOtp: vi.fn() }));
const store = vi.hoisted(() => ({
  intent: 'mover' as const,
  cancelAuth: () => {},
  setCountry: () => {},
  setIntent: () => {},
  setAuth: () => {},
}));

vi.mock('../../../mobile/node_modules/react-native', () => {
  const View = ({ children, testID }: any) => <div data-testid={testID}>{children}</div>;
  return {
    View, ScrollView: View, KeyboardAvoidingView: View,
    Platform: { OS: 'ios' },
    Pressable: ({ children, onPress, accessibilityLabel, disabled, testID }: any) => (
      <button type="button" aria-label={accessibilityLabel} data-testid={testID} disabled={disabled} onClick={onPress}>
        {typeof children === 'function' ? children({ pressed: false }) : children}
      </button>
    ),
    TextInput: ({ onChangeText, value, testID, ref }: any) => (
      <input ref={ref} data-testid={testID} value={value} onChange={(e) => onChangeText?.(e.target.value)} />
    ),
    TurboModuleRegistry: { get: () => null },
  };
});
vi.mock('../../../mobile/node_modules/@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: nav.navigate }),
  useRoute: () => ({ params: nav.params }),
}));
vi.mock('../../../mobile/src/services/api', () => ({ authApi: auth }));
vi.mock('../../../mobile/src/stores/authStore', () => ({
  useAuthStore: (select?: (_state: typeof store) => unknown) => (select ? select(store) : store),
}));
vi.mock('../../../mobile/src/components/SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../../../mobile/src/kit', () => ({
  Screen: ({ children }: any) => <main>{children}</main>,
  Header: ({ title }: any) => <h1>{title}</h1>,
  T: ({ children, testID }: any) => <span data-testid={testID}>{children}</span>,
  LabeledInput: ({ error, value, onChangeText, testID, accessibilityLabel }: any) => (
    <div>
      <input
        data-testid={testID}
        aria-label={accessibilityLabel}
        aria-invalid={error ? 'true' : 'false'}
        value={value}
        onChange={(e) => onChangeText(e.target.value)}
      />
      {error ? <p data-testid="auth-phone-error">{error}</p> : null}
    </div>
  ),
  PillButton: ({ label, onPress, disabled, loading, testID, variant }: any) => (
    <button type="button" data-testid={testID} data-variant={variant ?? 'primary'} disabled={Boolean(disabled || loading)} onClick={onPress}>
      {label}
    </button>
  ),
}));

// Variable imports keep this cross-surface test from adding mobile source to
// Next's production type-check graph. Each app has its own typecheck gate.
const phoneScreenPath = new URL('../../../mobile/src/screens/auth/PhoneEntryScreen.tsx', import.meta.url).pathname;
const verifyScreenPath = new URL('../../../mobile/src/screens/auth/OtpVerificationScreen.tsx', import.meta.url).pathname;
let PhoneEntryScreen: React.ComponentType;
let OtpVerificationScreen: React.ComponentType;

/** Fictional: no Guyana subscriber number starts with 0. */
const LOCAL = '0924001';
const PHONE = `+592${LOCAL}`;

const failed = (status: number, error: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { success: false, error }, headers: {} },
  });
const windowRefusal = (retryAfterSeconds: number, codeAlreadySent: boolean) => failed(429, {
  code: 'RATE_LIMITED',
  message: codeAlreadySent
    ? `We already sent a code to this number. You can request a new one in ${retryAfterSeconds} seconds.`
    : `A code was just requested for this number. You can request a new one in ${retryAfterSeconds} seconds.`,
  details: { retryAfterSeconds, codeAlreadySent },
});
const sent = { data: { success: true, data: { message: 'OTP sent successfully', expiresIn: 300 } } };

function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
/** Let the rejected/resolved call and React Query's zero-delay notify land. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1); });
/** Let wall-clock time pass a second at a time, as on a device: each tick
 *  re-renders before the countdown arms its next one. */
async function elapse(ms: number) {
  for (let left = ms; left > 0; left -= 1000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(1000, left)); });
  }
}
const phoneField = () => screen.getByTestId('auth-phone-input') as HTMLInputElement;
const sendButton = () => screen.getByTestId('auth-send-code') as HTMLButtonElement;
async function tapSend() {
  fireEvent.click(sendButton());
  await settle();
}

beforeAll(async () => {
  ({ PhoneEntryScreen } = await import(phoneScreenPath));
  ({ OtpVerificationScreen } = await import(verifyScreenPath));
});
beforeEach(() => {
  vi.useFakeTimers();
  nav.navigate.mockReset();
  nav.params = {};
  auth.sendOtp.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('mounted phone step: a resend inside the window', () => {
  it('keeps the number in good standing, counts down, and offers the code already sent on the existing verify step', async () => {
    auth.sendOtp.mockRejectedValueOnce(windowRefusal(42, true));
    mount(<PhoneEntryScreen />);
    fireEvent.change(phoneField(), { target: { value: LOCAL } });
    await tapSend();
    expect(auth.sendOtp).toHaveBeenCalledWith(PHONE);

    // Not a wrong number: the field is not flagged and carries no error line.
    expect(phoneField().getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByTestId('auth-phone-error')).toBeNull();
    // Calm copy with a live countdown; resend held until the window ends.
    expect(screen.getByTestId('auth-resend-wait').textContent).toBe(
      `Code already sentWe texted a code to ${PHONE} moments ago. Enter that code, or request a new one in 42s.`,
    );
    expect(sendButton().textContent).toBe('Resend Code');
    expect(sendButton().disabled).toBe(true);
    await elapse(1000);
    expect(screen.getByTestId('auth-resend-wait').textContent).toContain('request a new one in 41s.');

    // The primary action: the existing code-entry step, same number, the wait handed over.
    expect(screen.getByTestId('auth-enter-code').getAttribute('data-variant')).toBe('primary');
    fireEvent.click(screen.getByTestId('auth-enter-code'));
    expect(nav.navigate).toHaveBeenCalledWith('OtpVerification', { phone: PHONE, resendInSeconds: 41 });

    // When the countdown ends, resend unlocks and asks again for the same number.
    await elapse(41_000);
    expect(screen.getByTestId('auth-resend-wait').textContent).toContain('Enter that code, or request a new one.');
    expect(sendButton().disabled).toBe(false);
    auth.sendOtp.mockResolvedValueOnce(sent);
    await tapSend();
    expect(auth.sendOtp).toHaveBeenLastCalledWith(PHONE);
    expect(nav.navigate).toHaveBeenLastCalledWith('OtpVerification', { phone: PHONE });
  });

  it('when the window holds no delivered code, it waits calmly and offers no code to enter', async () => {
    auth.sendOtp.mockRejectedValueOnce(windowRefusal(9, false));
    mount(<PhoneEntryScreen />);
    fireEvent.change(phoneField(), { target: { value: LOCAL } });
    await tapSend();

    expect(phoneField().getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByTestId('auth-phone-error')).toBeNull();
    expect(screen.getByTestId('auth-resend-wait').textContent).toBe(
      `Just a momentA code was just requested for ${PHONE}. You can request a new one in 9s.`,
    );
    expect(screen.queryByTestId('auth-enter-code')).toBeNull();
    expect(sendButton().textContent).toBe('Send Code');
    expect(sendButton().disabled).toBe(true);

    await elapse(9_000);
    expect(screen.queryByTestId('auth-resend-wait')).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it('the window belongs to its number, and every other refusal still flags the field with the server words', async () => {
    auth.sendOtp.mockRejectedValueOnce(windowRefusal(42, true));
    mount(<PhoneEntryScreen />);
    fireEvent.change(phoneField(), { target: { value: LOCAL } });
    await tapSend();
    expect(screen.getByTestId('auth-resend-wait')).toBeTruthy();

    // A different number is not inside that window.
    fireEvent.change(phoneField(), { target: { value: '0924002' } });
    expect(screen.queryByTestId('auth-resend-wait')).toBeNull();
    expect(screen.queryByTestId('auth-enter-code')).toBeNull();
    expect(sendButton().textContent).toBe('Send Code');
    expect(sendButton().disabled).toBe(false);

    const others = [
      [failed(429, { code: 'RATE_LIMITED', message: 'Too many codes requested for this number. Try again in 42 minutes.' }), 'Too many codes requested for this number. Try again in 42 minutes.'],
      [failed(400, { code: 'COUNTRY_NOT_ACTIVE', message: 'Swift is currently available in Guyana only' }), 'Swift is currently available in Guyana only'],
      [Object.assign(new Error('Network Error'), { isAxiosError: true }), 'Could not send the code. Try again.'],
    ] as const;
    for (const [error, words] of others) {
      auth.sendOtp.mockRejectedValueOnce(error);
      await tapSend();
      expect(phoneField().getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByTestId('auth-phone-error').textContent).toBe(words);
      expect(screen.queryByTestId('auth-resend-wait')).toBeNull();
      expect(screen.queryByTestId('auth-enter-code')).toBeNull();
    }
  });
});

describe('mounted verify step: the resend countdown tells the truth', () => {
  it('opened from the window, it starts at the handed-over wait and unlocks resend when that ends', async () => {
    nav.params = { phone: PHONE, resendInSeconds: 41 };
    mount(<OtpVerificationScreen />);
    expect(screen.getByText('Resend in 41s')).toBeTruthy();
    expect(screen.queryByTestId('otp-resend')).toBeNull();
    await elapse(40_000);
    expect(screen.getByText('Resend in 1s')).toBeTruthy();
    await elapse(1_000);
    expect(screen.getByTestId('otp-resend')).toBeTruthy();
  });

  it('after a fresh send it waits out the whole server window instead of unlocking a refused resend at 30s', async () => {
    nav.params = { phone: PHONE };
    mount(<OtpVerificationScreen />);
    expect(screen.getByText('Resend in 60s')).toBeTruthy();
    await elapse(30_000);
    expect(screen.queryByTestId('otp-resend')).toBeNull();
    expect(screen.getByText('Resend in 30s')).toBeTruthy();
    await elapse(30_000);
    expect(screen.getByTestId('otp-resend')).toBeTruthy();
  });

  it('a resend refused inside the window says no new code went out and re-syncs to the server figure', async () => {
    nav.params = { phone: PHONE, resendInSeconds: 0 };
    auth.sendOtp.mockRejectedValueOnce(windowRefusal(25, true));
    mount(<OtpVerificationScreen />);
    fireEvent.click(screen.getByTestId('otp-resend'));
    await settle();
    expect(auth.sendOtp).toHaveBeenCalledWith(PHONE);
    expect(screen.getByText('Resend in 25s')).toBeTruthy();
    expect(screen.getByTestId('otp-resend-wait').textContent).toBe('No new code yet: enter the one we texted you moments ago.');

    await elapse(25_000);
    expect(screen.getByTestId('otp-resend')).toBeTruthy();
    expect(screen.queryByTestId('otp-resend-wait')).toBeNull();
  });
});
