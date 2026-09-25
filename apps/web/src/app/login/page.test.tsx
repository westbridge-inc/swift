import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

const mocked = vi.hoisted(() => ({
  query: '',
  replace: vi.fn(),
  sendOtp: vi.fn(),
  verifyPartnerLogin: vi.fn(),
  verifyCustomerLogin: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocked.query),
}));
vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp, verifyPartnerLogin: mocked.verifyPartnerLogin }));
vi.mock('@/lib/customer', () => ({ verifyCustomerLogin: mocked.verifyCustomerLogin }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

beforeEach(() => {
  mocked.replace.mockReset();
  mocked.sendOtp.mockResolvedValue(undefined);
  mocked.verifyCustomerLogin.mockResolvedValue({ user: { id: 'c1' } });
  mocked.verifyPartnerLogin.mockResolvedValue({ user: { id: 'p1' }, home: '/dashboard' });
});

async function signIn(query: string) {
  mocked.query = query;
  const user = userEvent.setup();
  render(<LoginPage />);
  const phone = screen.getByLabelText('Phone number');
  await user.clear(phone);
  await user.type(phone, '+5926001001');
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  await user.type(await screen.findByLabelText('Verification code'), '246810');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(mocked.replace).toHaveBeenCalledTimes(1));
  return String(mocked.replace.mock.calls[0]?.[0]);
}

// ---------------------------------------------------------------------------
// [Q7b] The customer app's Home is `/`. Signing in from it — or from Market,
// or anywhere else in the app — is a CUSTOMER sign-in that comes back to the
// same place. A customer account sent through the partner sign-in is refused
// ("No business or earner profile…"), so `/` must never be read as a partner
// return just because it names no customer prefix.
// ---------------------------------------------------------------------------

describe('[Q7b] signing in from the customer app', () => {
  it.each([
    ['Home', '/'],
    ['Home with its query', '/?source=pwa'],
    ['Market', '/market'],
    ['a store, on one item', '/order/vendor/v1?item=i1'],
    ['the cart', '/cart'],
  ])('from %s is a customer sign-in that returns there', async (_name, next) => {
    expect(await signIn(`next=${encodeURIComponent(next)}`)).toBe(next);
    expect(mocked.verifyCustomerLogin).toHaveBeenCalledWith('+5926001001', '246810');
    expect(mocked.verifyPartnerLogin).not.toHaveBeenCalled();
  });

  it('a partner page is still a partner sign-in', async () => {
    expect(await signIn(`next=${encodeURIComponent('/dashboard/orders')}`)).toBe('/dashboard');
    expect(mocked.verifyPartnerLogin).toHaveBeenCalled();
    expect(mocked.verifyCustomerLogin).not.toHaveBeenCalled();
  });

  it('refuses an off-site return, whatever it looks like', async () => {
    expect(await signIn(`next=${encodeURIComponent('//evil.example/')}`)).toBe('/dashboard');
    expect(mocked.verifyCustomerLogin).not.toHaveBeenCalled();
  });
});
