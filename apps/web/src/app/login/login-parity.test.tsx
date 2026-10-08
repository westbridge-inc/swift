import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

const mocked = vi.hoisted(() => ({ replace: vi.fn(), sendOtp: vi.fn(), verifyPartnerLogin: vi.fn(), verifyCustomerLogin: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocked.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('next=%2F'),
}));
vi.mock('@/lib/auth', () => ({ sendOtp: mocked.sendOtp, verifyPartnerLogin: mocked.verifyPartnerLogin }));
vi.mock('@/lib/customer', () => ({ verifyCustomerLogin: mocked.verifyCustomerLogin }));

beforeEach(() => {
  mocked.sendOtp.mockReset().mockResolvedValue(undefined);
  mocked.verifyCustomerLogin.mockReset().mockResolvedValue({ user: { id: 'c1' } });
});

/** What the API stores for a number (apps/api/src/utils/phone.ts normalizePhone):
 *  spaces and punctuation stripped, a leading + kept. */
const apiCanonical = (raw: string) => (raw.trim().startsWith('+') ? '+' : '') + raw.replace(/\D/g, '');

// ---------------------------------------------------------------------------
// [WEB-REDESIGN · review S3] The redesign puts the number beside a +592 chip.
// Whatever someone types, sign-in must reach the SAME account it reached
// before: the server is sent a number that canonicalises exactly as the old
// trimmed input did (the API strips formatting before matching).
// ---------------------------------------------------------------------------

describe('[review S3] sign-in sends the same number as before the redesign', () => {
  it.each([
    ['the whole number, as before', '+5926001001', '+5926001001'],
    ['the whole number, spaced', '+592 600 1001', '+592 600 1001'],
    ['a local number beside the chip', '600 1001', '+592 600 1001'],
    ['Guyana’s code without the +', '5926001001', '+5926001001'],
    ['another country’s number, with its +', '+1 555 123 4567', '+1 555 123 4567'],
  ])('%s', async (_name, typed, typedBeforeRedesign) => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.sendOtp).toHaveBeenCalledTimes(1));
    const sent = String(mocked.sendOtp.mock.calls[0]![0]);
    expect(apiCanonical(sent)).toBe(apiCanonical(typedBeforeRedesign));
  });

  it('offers Continue only for a whole number', () => {
    render(<LoginPage />);
    const phone = screen.getByLabelText('Phone number');
    const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    fireEvent.change(phone, { target: { value: '600 100' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(phone, { target: { value: '600 1001' } });
    expect(button.disabled).toBe(false);
    fireEvent.change(phone, { target: { value: '+1 555' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(phone, { target: { value: '+1 555 1234' } });
    expect(button.disabled).toBe(false);
  });

  it('verifies with the six digits the server asks for (it refuses any other length)', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '600 1001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const code = await screen.findByLabelText('Verification code');
    const verify = screen.getByRole('button', { name: 'Verify' }) as HTMLButtonElement;
    fireEvent.change(code, { target: { value: '24681' } });
    expect(verify.disabled).toBe(true);
    // A pasted code with a space or dash still lands as its six digits.
    fireEvent.change(code, { target: { value: '246 810' } });
    expect(verify.disabled).toBe(false);
    fireEvent.click(verify);
    await waitFor(() => expect(mocked.verifyCustomerLogin).toHaveBeenCalledWith('+5926001001', '246810'));
  });
});

describe('[review S3] the code boxes always show where keyboard focus is', () => {
  it('marks the next box while the code field has focus — the last one once all six are in — and none when it loses focus', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '600 1001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const code = await screen.findByLabelText('Verification code');
    const focusedBoxes = () => Array.from(document.querySelectorAll('[data-code-box="focused"]'));
    fireEvent.focus(code);
    expect(focusedBoxes()).toHaveLength(1);
    fireEvent.change(code, { target: { value: '246810' } });
    expect(focusedBoxes()).toHaveLength(1);
    expect(focusedBoxes()[0]!.textContent).toBe('0');
    fireEvent.blur(code);
    expect(focusedBoxes()).toHaveLength(0);
  });
});
