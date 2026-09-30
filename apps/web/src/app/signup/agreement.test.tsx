import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';

const fx = vi.hoisted(() => ({ api: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: vi.fn(), apiFetch: fx.api }));
// Keep the real becomePartner so assertions cover the serialized request body.
vi.mock('@/lib/customer', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/customer')>(),
  verifyOtp: vi.fn(async () => ({ signedIn: false, isNewUser: true })),
  registerAccount: vi.fn(async () => ({})),
}));
vi.mock('@/components/store-location-picker', () => ({
  StoreLocationPicker: ({ onConfirm }: { onConfirm: (_pin: { latitude: number; longitude: number }) => void }) => (
    <button onClick={() => onConfirm({ latitude: 6.812, longitude: -58.163 })}>Confirm store location</button>
  ),
}));

beforeEach(() => {
  fx.api.mockResolvedValue({ data: {} });
});

async function readyBusiness() {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: /Put my business on Swift/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Merchant' } });
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByLabelText('Business name');
  for (const [label, value] of [['Business name', 'Test shop'], ['Street address', '12 Regent Street'], ['City or town', 'Georgetown'], ['Region', 'Demerara-Mahaica']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
  await user.click(screen.getByRole('button', { name: 'Confirm store location' }));
  return user;
}

describe('[PIN-OWNER] explicit business agreement consent', () => {
  it('starts unticked and cannot submit a complete business until consent is ticked', async () => {
    const user = await readyBusiness();
    const create = screen.getByRole('button', { name: 'Create business' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const consent = screen.getByRole('checkbox', { name: 'I agree to the Swift Business Agreement' }) as HTMLInputElement;
    expect(consent.checked).toBe(false);
    const agreement = screen.getByRole('link', { name: 'Swift Business Agreement' });
    expect(agreement.getAttribute('href')).toBe('http://vendor-api.test/legal/vendor-agreement');
    await user.click(create);
    expect(fx.api).not.toHaveBeenCalled();
    await user.click(consent);
    expect(create.disabled).toBe(false);
    await user.click(consent);
    expect(create.disabled).toBe(true);
    await user.click(create);
    expect(fx.api).not.toHaveBeenCalled();
    expect(fx.replace).not.toHaveBeenCalled();
  });

  it('submits acceptAgreement true only after explicit consent', async () => {
    const user = await readyBusiness();
    await user.click(screen.getByRole('checkbox', { name: 'I agree to the Swift Business Agreement' }));
    await user.click(screen.getByRole('button', { name: 'Create business' }));
    await waitFor(() => expect(fx.api).toHaveBeenCalledTimes(1));
    expect(fx.api.mock.calls[0]![0]).toBe('/api/v1/partner/become');
    expect(fx.api.mock.calls[0]![1].method).toBe('POST');
    expect(JSON.parse(fx.api.mock.calls[0]![1].body)).toMatchObject({
      role: 'VENDOR', acceptAgreement: true,
      business: { name: 'Test shop', latitude: 6.812, longitude: -58.163 },
    });
    expect(fx.replace).toHaveBeenCalledWith('/dashboard');
  });
});
