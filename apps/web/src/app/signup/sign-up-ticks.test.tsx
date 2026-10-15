import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

// ---------------------------------------------------------------------------
// [Owner ruling 15 Oct 2026 · Terms intro "ticking the acceptance box at registration"] The website's
// sign-up had a sentence ("By creating an account you agree …") and sent acceptTerms: true for everyone;
// the Terms say acceptance is by ticking a box. It now has two unticked ticks — Terms + Privacy, and
// "I am 18 or older" — and creates nothing until both are ticked. The API records both.
// ---------------------------------------------------------------------------

const mocked = vi.hoisted(() => ({
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
  registerAccount: vi.fn(),
  becomePartner: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocked.replace, push: mocked.push }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp, sessionProbe: vi.fn().mockResolvedValue({ ok: false }) }));
vi.mock('@/lib/customer', () => ({ verifyOtp: mocked.verifyOtp, registerAccount: mocked.registerAccount, becomePartner: mocked.becomePartner }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  mocked.sendOtp.mockResolvedValue(undefined);
  mocked.verifyOtp.mockResolvedValue({ isNewUser: true, signedIn: false });
  mocked.registerAccount.mockResolvedValue({ user: { id: 'u1', roles: ['CUSTOMER'] }, roles: ['CUSTOMER'] });
  window.history.replaceState(null, '', '/signup');
});

async function toNameStep() {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: /Put my business on Swift/i }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001234' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Tick' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Box' } });
  return user;
}

describe('the website sign-up has two real ticks', () => {
  it('both start unticked, and "Create account" stays off until both are ticked', async () => {
    const user = await toNameStep();
    const terms = screen.getByRole('checkbox', { name: /I agree to the Terms of Service and Privacy Policy/ }) as HTMLInputElement;
    const adult = screen.getByRole('checkbox', { name: 'I am 18 or older.' }) as HTMLInputElement;
    const create = screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement;
    expect(terms.checked).toBe(false);
    expect(adult.checked).toBe(false);
    expect(create.disabled).toBe(true);
    await user.click(terms);
    expect(create.disabled).toBe(true);
    await user.click(adult);
    expect(create.disabled).toBe(false);
    await user.click(terms);
    expect(create.disabled).toBe(true);
    expect(mocked.registerAccount).not.toHaveBeenCalled();
  });

  it('the account is created with both ticks sent, as ticked', async () => {
    const user = await toNameStep();
    await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
    await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(mocked.registerAccount).toHaveBeenCalledTimes(1);
    expect(mocked.registerAccount.mock.calls[0]![0]).toMatchObject({ acceptTerms: true, ageConfirmed: true, role: 'VENDOR' });
  });

  it('the page no longer accepts the Terms with a sentence and no tick', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'app', 'signup', 'page.tsx'), 'utf8');
    expect(page).not.toMatch(/By creating an account you agree/);
    expect(page).not.toMatch(/acceptTerms: true/);
  });
});
