import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import LoginPage from './page';

// [W4] Place order signs a guest in for the one checkout: the code must sign
// them in as a CUSTOMER and bring them back to /checkout (never the partner
// consoles). Synthetic number only.
const mocked = vi.hoisted(() => ({ replace: vi.fn(), sendOtp: vi.fn(), verifyPartnerLogin: vi.fn(), verifyCustomerLogin: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('next=%2Fcheckout'),
}));
vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp, verifyPartnerLogin: mocked.verifyPartnerLogin }));
vi.mock('@/lib/customer', () => ({ verifyCustomerLogin: mocked.verifyCustomerLogin }));

it('signs in as a customer and returns to the one checkout', async () => {
  mocked.sendOtp.mockResolvedValue(undefined);
  mocked.verifyCustomerLogin.mockResolvedValue({ user: { id: 'c1' } });
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '600 1001' } });
  const next = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
  await waitFor(() => expect(next.disabled).toBe(false));
  fireEvent.click(next);
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(mocked.replace).toHaveBeenCalledWith('/checkout'));
  expect(mocked.verifyCustomerLogin).toHaveBeenCalledOnce();
  expect(mocked.verifyPartnerLogin).not.toHaveBeenCalled();
});
