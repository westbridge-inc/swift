import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

const mocked = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  registerAccount: vi.fn(),
  becomePartner: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: mocked.push }),
}));

vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp }));
vi.mock('@/lib/customer', () => ({
  verifyOtp: mocked.verifyOtp,
  registerAccount: mocked.registerAccount,
  becomePartner: mocked.becomePartner,
}));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

describe('web signup continuation recovery', () => {
  beforeEach(() => {
    mocked.sendOtp.mockResolvedValue(undefined);
    mocked.verifyOtp.mockResolvedValue({ isNewUser: true, signedIn: false });
    mocked.registerAccount.mockRejectedValue(new Error('Registration could not finish.'));
  });

  it('returns an ambiguous failed registration to a fresh OTP request', async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.click(screen.getByRole('button', { name: /Order on Swift/i }));
    const phone = screen.getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '+5926001001');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    const code = await screen.findByLabelText('Verification code');
    await user.type(code, '246810');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await user.type(await screen.findByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Customer');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Confirm your phone' })).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Request a new verification code to try again.');
    expect(screen.queryByLabelText('Verification code')).toBeNull();
    expect(mocked.registerAccount).toHaveBeenCalledTimes(1);
    expect(mocked.replace).not.toHaveBeenCalled();
  });
});

describe('[E27] a new customer is not sent to the camera', () => {
  beforeEach(() => {
    mocked.replace.mockReset();
    mocked.sendOtp.mockResolvedValue(undefined);
    mocked.verifyOtp.mockResolvedValue({ isNewUser: true, signedIn: false });
    mocked.registerAccount.mockResolvedValue({ user: { id: 'u1', roles: ['CUSTOMER'] } });
  });

  async function registerCustomer() {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.click(screen.getByRole('button', { name: /Order on Swift/i }));
    const phone = screen.getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '+5926001002');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('First name'), 'New');
    await user.type(screen.getByLabelText('Last name'), 'Customer');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(mocked.replace).toHaveBeenCalledTimes(1));
    return String(mocked.replace.mock.calls[0]?.[0]);
  }

  it('lands on ordering, not /selfie', async () => {
    window.history.replaceState(null, '', '/signup');
    expect(await registerCustomer()).toBe('/order');
  });

  it('keeps a safe return path, still without the selfie detour', async () => {
    window.history.replaceState(null, '', '/signup?next=%2Fcart');
    expect(await registerCustomer()).toBe('/cart');
  });
});
