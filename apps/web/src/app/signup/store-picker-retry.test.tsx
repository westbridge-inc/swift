import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF] The store map picker's code now loads on demand. On a flaky
// connection that fetch can fail. The page must say so in place and let the
// owner try again with everything typed still there: never the app's error
// page, never a lost form.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(),
  replace: vi.fn(), coords: vi.fn(), search: vi.fn(), details: vi.fn(), api: vi.fn(),
  load: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, apiFetch: fx.api }));
vi.mock('@/lib/customer-account', () => ({
  verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become,
}));
vi.mock('@/lib/customer-places', () => ({
  placesAutocomplete: fx.search, placeDetails: fx.details,
}));
vi.mock('@/lib/geolocate', () => ({ currentCoords: fx.coords }));
vi.mock('./store-picker-loader', () => ({ loadStorePicker: fx.load }));
// [Row 628] The weekly fee block has its own tests (weekly-fee.test.tsx); here it says what an API older than the tick says.
vi.mock('./weekly-fee-loader', () => ({ loadWeeklyFee: () => import('@/test/weekly-fee-fixture') }));

import SignupPage from './page';

const DOOR = { placeId: 'door', primary: '12 Regent Street', secondary: 'Georgetown', lat: 6.812, lng: -58.163 };
const chunkLost = () => Promise.reject(new Error('Loading chunk 1563 failed.'));
const realPicker = () => vi.importActual<typeof import('@/components/store-location-picker')>('@/components/store-location-picker');

beforeEach(() => {
  vi.resetAllMocks();
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.coords.mockResolvedValue({ lat: 6.79, lng: -58.12 });
  fx.search.mockResolvedValue([DOOR]);
  fx.api.mockResolvedValue({ data: { address: 'Store entrance, Georgetown' } });
});

async function business() {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: /Put my business on Swift/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Merchant' } });
  await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
  await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  fireEvent.change(await screen.findByLabelText('Business name'), { target: { value: 'Test shop' } });
  for (const [label, value] of [['Street address', '12 Regent Street'], ['City or town', 'Georgetown'], ['Region', 'Demerara-Mahaica']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  return user;
}

describe('[PERF] the on-demand store map picker', () => {
  it('is fetched once the business step shows, before the tap', async () => {
    fx.load.mockImplementation(realPicker);
    await business();
    expect(fx.load).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch says so in place, keeps what was typed, and Try again brings the map', async () => {
    fx.load.mockImplementation(chunkLost);
    const user = await business();
    await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The map didn’t load');
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Test shop');
    expect((screen.getByLabelText('Street address') as HTMLInputElement).value).toBe('12 Regent Street');

    fx.load.mockImplementation(realPicker);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('application')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('Business name') as HTMLInputElement).value).toBe('Test shop');
  });

  it('a tap after a failed early fetch tries again by itself', async () => {
    fx.load.mockImplementationOnce(chunkLost).mockImplementation(realPicker);
    const user = await business();
    await vi.waitFor(() => expect(fx.load).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
    expect(await screen.findByRole('application')).toBeTruthy();
    expect(fx.load).toHaveBeenCalledTimes(2);
  });

  it('Back from a failed map returns to the form', async () => {
    fx.load.mockImplementation(chunkLost);
    const user = await business();
    await user.click(screen.getByRole('button', { name: 'Place your store on the map' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Place your store on the map' })).toBeTruthy();
  });
});
