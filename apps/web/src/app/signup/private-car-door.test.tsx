import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';
import { feeQuote, type FeeState, type SignupPricing } from '@/lib/signup-fee';
import { PRIVATE_CAR_H_PLATE, PRIVATE_CAR_NOTE, TAXI_DOOR_PRIVATE_CAR } from '@/lib/signup-roles';

// ---------------------------------------------------------------------------
// [CARS-PLATES · owner 6 Nov 2026 + 04:30Z] P-plate (private) cars deliver only, at the delivery rider's weekly fee;
// H-plate (hire) cars drive taxi rides (and add deliveries in their account). While the server says private cars
// deliver (price list `privateCars.on`, the CAR_DELIVERIES switch), the delivery door also offers a car on a private
// plate with its details; an H plate there is sent to the taxi door. The taxi door keeps the H rule and, while cars
// deliver, says where a P car goes. With the switch off nothing changes (four-roles.test.tsx).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), probe: vi.fn(), open: true }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: vi.fn() }));
vi.mock('@/lib/otp-send', () => ({ sendOtp: fx.send }));
vi.mock('@/lib/customer-account', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become }));
vi.mock('@/lib/customer-places', () => ({ placesAutocomplete: vi.fn(), placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));
// The fee block stands in as an API older than the tick (nothing to tick), and says what the server says about cars.
vi.mock('./weekly-fee-loader', () => ({
  loadWeeklyFee: async () => ({
    WeeklyFee: ({ onChange, onPrivateCars }: { onChange: (_s: FeeState) => void; onPrivateCars?: (_open: boolean) => void }) => {
      useEffect(() => { onChange({ ask: null }); onPrivateCars?.(fx.open); }, [onChange, onPrivateCars]);
      return null;
    },
  }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  fx.open = true;
  fx.send.mockResolvedValue(undefined);
  fx.verify.mockResolvedValue({ signedIn: false, isNewUser: true });
  fx.register.mockResolvedValue({});
  fx.become.mockResolvedValue({});
  fx.probe.mockResolvedValue({ ok: false });
  window.history.replaceState(null, '', '/signup');
});

async function throughName(tile: RegExp) {
  const user = userEvent.setup();
  render(<SignupPage />);
  await user.click(screen.getByRole('button', { name: tile }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001234' } });
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Partner' } });
  await user.click(screen.getByRole('checkbox', { name: /Terms of Service/ }));
  await user.click(screen.getByRole('checkbox', { name: /18 or older/ }));
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return user;
}

const options = () => within(screen.getByLabelText('Vehicle')).getAllByRole('option').map((option) => [(option as HTMLOptionElement).value, option.textContent]);

describe('[CARS-PLATES] the delivery door takes a private (P) plate car', () => {
  it('offers a private car while cars deliver; asks its details; refuses an H plate there; sends the car', async () => {
    const user = await throughName(/Deliver with Swift/);
    await waitFor(() => expect(options()).toEqual([
      ['MOTORCYCLE', 'Motorbike'], ['BICYCLE', 'Bicycle'], ['CAR', 'Car (private P plate)'], ['WAGON_CAR', 'Wagon Car (private P plate)'],
    ]));
    fireEvent.change(screen.getByLabelText('Vehicle'), { target: { value: 'CAR' } });
    expect(screen.getAllByText(PRIVATE_CAR_NOTE).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Hire Car Driver’s Licence|Hire Car Driver's Licence/)).toBeNull();
    const create = () => screen.getByRole('button', { name: 'Create rider account' }) as HTMLButtonElement;
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Mover Agreement/ }));
    expect(create().disabled).toBe(true); // the car's details first
    for (const [label, value] of [['Make', 'Toyota'], ['Model', 'Premio'], ['Year', '2017'], ['Colour', 'White'], ['Licence plate', 'HC 1234']]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    expect(create().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(PRIVATE_CAR_H_PLATE);
    fireEvent.change(screen.getByLabelText('Licence plate'), { target: { value: 'PWX 4821' } });
    expect(create().disabled).toBe(false);
    await user.click(create());
    expect(fx.become.mock.calls[0]![0]).toEqual({
      role: 'MOVER', acceptAgreement: true, vehicleType: 'CAR',
      vehicle: { make: 'Toyota', model: 'Premio', year: 2017, color: 'White', licensePlate: 'PWX 4821' },
    });
  });

  it('cars paused (the kill switch): the delivery door offers bikes only, exactly as before', async () => {
    fx.open = false;
    await throughName(/Deliver with Swift/);
    await waitFor(() => expect(options()).toEqual([['MOTORCYCLE', 'Motorbike'], ['BICYCLE', 'Bicycle']]));
  });

  it('the taxi door keeps the H rule and, while cars deliver, says where a private car signs up', async () => {
    await throughName(/Drive a taxi with Swift/);
    fireEvent.change(screen.getByLabelText('Licence plate'), { target: { value: 'PLX4821' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(TAXI_DOOR_PRIVATE_CAR));
    expect(screen.getByRole('alert').textContent).toMatch(/private \(P\) plate cannot be approved/);
    expect((screen.getByRole('button', { name: 'Create driver account' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('[CARS-PLATES · owner 04:30Z] a private car is quoted the delivery rider’s fee', () => {
  const base: SignupPricing = { currencyCode: 'GYD', currencySymbol: '$', movers: [{ vehicleType: 'CAR', rate: 8000 }, { vehicleType: 'MOTORCYCLE', rate: 6000 }] };
  it('the server’s privateCars quote, only while it says cars deliver; never the taxi rate', () => {
    const open = { ...base, privateCars: { on: true, quotes: [{ vehicleType: 'CAR', rate: 6000, role: 'RIDER' }] } };
    expect(feeQuote(open, { role: 'MOVER', vehicleType: 'CAR', privateCar: true })).toBe(6000);
    expect(feeQuote(open, { role: 'MOVER', vehicleType: 'CAR' })).toBe(8000);
    expect(feeQuote({ ...base, privateCars: { on: false, quotes: [{ vehicleType: 'CAR', rate: 6000, role: 'RIDER' }] } }, { role: 'MOVER', vehicleType: 'CAR', privateCar: true })).toBeNull();
    expect(feeQuote(base, { role: 'MOVER', vehicleType: 'CAR', privateCar: true })).toBeNull();
    expect(feeQuote({ ...base, privateCars: { on: true, quotes: [{ vehicleType: 'CAR', rate: 8000, role: 'DRIVER' }] } }, { role: 'MOVER', vehicleType: 'CAR', privateCar: true })).toBeNull();
  });
});
