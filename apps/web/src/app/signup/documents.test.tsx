import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import SignupPage from './page';

const fx = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), api: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, apiFetch: fx.api }));
vi.mock('@/lib/customer', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become }));

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue({}); fx.verify.mockResolvedValue({ signedIn: false }); fx.register.mockResolvedValue({}); fx.become.mockResolvedValue({});
  fx.api.mockImplementation(async (path: string) => {
    const checklist = path.includes('BICYCLE') ? ['national_id', 'police_clearance'] : ['national_id', 'vehicle_insurance'];
    return { data: { checklist, missing: checklist, documents: [], roleVerified: false } };
  });
});

async function moverSignup() {
  render(<SignupPage />);
  fireEvent.click(screen.getByRole('button', { name: /Drive & deliver/ }));
  expect(fx.api).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001005' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Rider' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByLabelText('Vehicle type');
}

it('registers a bicycle rider with bicycle requirements and no car fields, only after explicit agreement', async () => {
  await moverSignup();
  await screen.findByText('Vehicle Insurance');
  fireEvent.change(screen.getByLabelText('Vehicle type'), { target: { value: 'BICYCLE' } });
  await screen.findByText('Police Clearance Certificate');
  expect(screen.queryByText('Vehicle Insurance')).toBeNull();
  expect(screen.queryByLabelText('Licence plate')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Upload your documents' })).toBeNull();
  expect(screen.getByRole('link', { name: 'driver agreement' }).getAttribute('href')).toBe('http://vendor-api.test/legal/driver-agreement');
  const create = screen.getByRole('button', { name: 'Create driver account' }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.click(create);
  expect(fx.become).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /driver agreement/ }));
  fireEvent.click(create);
  await waitFor(() => expect(fx.become).toHaveBeenCalledExactlyOnceWith({ role: 'MOVER', vehicleType: 'BICYCLE', acceptAgreement: true }));
  expect(fx.replace).toHaveBeenCalledWith('/portal/documents');
});

it('keeps the car details requirement when choosing a driver vehicle', async () => {
  await moverSignup();
  fireEvent.change(screen.getByLabelText('Vehicle type'), { target: { value: 'CAR' } });
  await screen.findByText('Vehicle Insurance');
  expect(screen.getByLabelText('Licence plate')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /driver agreement/ }));
  expect((screen.getByRole('button', { name: 'Create driver account' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fx.become).not.toHaveBeenCalled();
});
