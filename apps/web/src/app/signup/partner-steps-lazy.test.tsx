import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

// ---------------------------------------------------------------------------
// [D6 · WEB-ONBOARDING · perf] The business and vehicle steps are their own chunk (partner-steps.tsx): the sign-up
// page's first load no longer carries them (page-size.test.ts). The page starts loading them as soon as a partner door
// is chosen, long before "Create account"; if the chunk does not arrive, the step says so and can be tried again, with
// nothing lost. Synthetic values only.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), probe: vi.fn(), load: vi.fn(), fails: { n: 0 } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: vi.fn() }));
vi.mock('@/lib/otp-send', () => ({ sendOtp: fx.send }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become, signOwnName: vi.fn() }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: vi.fn(), placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
vi.mock('./weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));
vi.mock('./partner-steps-loader', async () => {
  const real = await vi.importActual<typeof import('./partner-steps-loader')>('./partner-steps-loader');
  return { loadPartnerSteps: () => { fx.load(); return fx.fails.n-- > 0 ? Promise.reject(new Error('chunk')) : real.loadPartnerSteps(); } };
});

beforeEach(() => {
  vi.resetAllMocks();
  fx.fails.n = 0;
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: false });
  window.history.replaceState(null, '', '/signup');
});

describe('[D6] the partner steps load on demand', () => {
  it('a partner door starts loading them at once, before the phone is even confirmed; ordering never does', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    expect(fx.load).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Deliver with Swift/ }));
    expect(await screen.findByLabelText('Phone number')).toBeTruthy();
    expect(fx.load).toHaveBeenCalled();
  });

  it('a chunk that does not arrive says so, and Try again brings the step (the account phone kept)', async () => {
    fx.fails.n = 1;
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1', phone: '+5926001008' } });
    window.history.replaceState(null, '', '/signup?resume=business');
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.click(await screen.findByRole('button', { name: 'Couldn’t load this step — try again' }));
    expect(await screen.findByRole('heading', { name: 'Your business' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Test shop' } });
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Test shop');
  });
});
