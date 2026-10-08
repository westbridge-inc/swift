import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignupPage from './page';
import { LAUNCH_HIDDEN_BUSES, MOVER_VEHICLES } from '@/lib/signup-roles';

// ---------------------------------------------------------------------------
// [W9] Four first-level ways to join: order, a business, a delivery rider, a
// taxi driver. Riders and drivers are both movers to the API; the vehicle
// decides which one the server provisions, so each door offers only its own
// vehicles, and only a taxi asks for make, model and plate. The partner
// agreement is required on every partner door.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ send: vi.fn(), verify: vi.fn(), register: vi.fn(), become: vi.fn(), replace: vi.fn(), probe: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace }) }));
vi.mock('@/lib/auth', () => ({ sendOtp: fx.send, sessionProbe: fx.probe, apiFetch: vi.fn() }));
vi.mock('@/lib/customer', () => ({ verifyOtp: fx.verify, registerAccount: fx.register, becomePartner: fx.become, placesAutocomplete: vi.fn(), placeDetails: vi.fn() }));
vi.mock('@/lib/geolocate', () => ({ currentCoords: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
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
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  return user;
}

const options = () => within(screen.getByLabelText('Vehicle')).getAllByRole('option').map((option) => [(option as HTMLOptionElement).value, option.textContent]);

describe('[W9] four ways to join', () => {
  it('offers ordering, a business, a delivery rider and a taxi driver, in that order', () => {
    render(<SignupPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Who are you signing up as?' })).toBeTruthy();
    const titles = screen.getAllByRole('button').map((button) => button.textContent ?? '').filter((text) => /Swift/.test(text));
    expect(titles.map((text) => text.match(/^(Order on Swift|Put my business on Swift|Deliver with Swift|Drive a taxi with Swift)/)?.[1])).toEqual([
      'Order on Swift', 'Put my business on Swift', 'Deliver with Swift', 'Drive a taxi with Swift',
    ]);
  });

  it('a delivery rider registers as a mover, picks a motorbike or a bicycle only, gives no plate, and still accepts the agreement', async () => {
    const user = await throughName(/Deliver with Swift/);
    expect(fx.register.mock.calls[0]![0]).toMatchObject({ role: 'MOVER' });
    expect(options()).toEqual([['MOTORCYCLE', 'Motorbike'], ['BICYCLE', 'Bicycle']]);
    expect(screen.queryByLabelText('Make')).toBeNull();
    expect(screen.queryByLabelText('Licence plate')).toBeNull();
    const create = screen.getByRole('button', { name: 'Create rider account' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Vehicle'), { target: { value: 'BICYCLE' } });
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    await user.click(create);
    expect(fx.become).toHaveBeenCalledTimes(1);
    expect(fx.become.mock.calls[0]![0]).toEqual({ role: 'MOVER', acceptAgreement: true, vehicleType: 'BICYCLE' });
    expect(fx.replace).toHaveBeenCalledWith('/portal');
  });

  it('a taxi driver registers as a mover, picks a car only — buses are hidden at launch — and gives the vehicle’s details', async () => {
    const user = await throughName(/Drive a taxi with Swift/);
    expect(fx.register.mock.calls[0]![0]).toMatchObject({ role: 'MOVER' });
    expect(options()).toEqual([['CAR', 'Car'], ['WAGON_CAR', 'Wagon Car']]);
    for (const [label, value] of [['Make', 'Toyota'], ['Model', 'Axio'], ['Year', '2018'], ['Colour', 'Silver'], ['Licence plate', 'PAA 1234']]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    await user.click(screen.getByRole('button', { name: 'Create driver account' }));
    expect(fx.become.mock.calls[0]![0]).toEqual({
      role: 'MOVER', acceptAgreement: true, vehicleType: 'CAR',
      vehicle: { make: 'Toyota', model: 'Axio', year: 2018, color: 'Silver', licensePlate: 'PAA 1234' },
    });
  });

  it('the taxi door holds the vehicle year to what the server accepts (1980 to next year)', async () => {
    const user = await throughName(/Drive a taxi with Swift/);
    for (const [label, value] of [['Make', 'Toyota'], ['Model', 'Axio'], ['Colour', 'Silver'], ['Licence plate', 'PAA 1234']]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    await user.click(screen.getByRole('checkbox', { name: /I agree to the Driver Partner Agreement/ }));
    const create = () => screen.getByRole('button', { name: 'Create driver account' }) as HTMLButtonElement;
    const next = new Date().getFullYear() + 1;
    for (const [year, open] of [['1979', false], ['1980', true], [String(next), true], [String(next + 1), false]] as const) {
      fireEvent.change(screen.getByLabelText('Year'), { target: { value: year } });
      expect(create().disabled, year).toBe(!open);
    }
  });

  it('a business still registers as a business', async () => {
    await throughName(/Put my business on Swift/);
    expect(fx.register.mock.calls[0]![0]).toMatchObject({ role: 'VENDOR' });
    expect(await screen.findByRole('heading', { name: 'Your business' })).toBeTruthy();
  });
});

describe('[W9] the vehicles match the app and the server', () => {
  const mobile = (path: string) => readFileSync(join(__dirname, '..', '..', '..', '..', 'mobile', 'src', path), 'utf8');

  it('the taxi door offers the app’s driver vehicles minus the launch-hidden buses, the rider door the rest of what is offered at launch', () => {
    const driverKinds = /DRIVER_VEHICLE_KINDS: VehicleKind\[\] = \[([^\]]*)\]/.exec(mobile('services/api.ts'))![1]!.match(/'([A-Z_0-9]+)'/g)!.map((k) => k.slice(1, -1));
    const hidden = /LAUNCH_HIDDEN_VEHICLE_KINDS: readonly VehicleKind\[\] = \[([^\]]*)\]/.exec(mobile('lib/vehicleOffer.ts'))![1]!.match(/'([A-Z_0-9]+)'/g)!.map((k) => k.slice(1, -1));
    const all = [...mobile('modules/mover/screens/MoverOnboardingScreen.tsx').matchAll(/\{ key: '([A-Z_0-9]+)', label: '([^']+)'/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(all.length).toBeGreaterThan(5);
    // Owner ruling, 6 Oct: buses ("Group" rides) are hidden at launch. Whether
    // the app still lists them, or hides them too (its launch-hidden list),
    // the website's doors subtract them — so this holds either way.
    const offered = (key: string) => !hidden.includes(key) && !LAUNCH_HIDDEN_BUSES.includes(key);
    expect(MOVER_VEHICLES.DRIVER.map((v) => v.value)).toEqual(driverKinds.filter(offered));
    expect(MOVER_VEHICLES.RIDER.map((v) => v.value).sort()).toEqual(all.map(([key]) => key).filter((key) => !driverKinds.includes(key) && offered(key)).sort());
    for (const vehicle of [...MOVER_VEHICLES.RIDER, ...MOVER_VEHICLES.DRIVER]) {
      expect(vehicle.label, vehicle.value).toBe(all.find(([key]) => key === vehicle.value)![1]);
    }
  });

  it('buses are hidden at launch: no door offers one, and the hidden set names every bus class the app knows', () => {
    const appBuses = [...mobile('modules/mover/screens/MoverOnboardingScreen.tsx').matchAll(/\{ key: '(BUS_[A-Z_0-9]+)'/g)].map((m) => m[1]!);
    expect(appBuses.length).toBeGreaterThan(0);
    expect([...LAUNCH_HIDDEN_BUSES].sort()).toEqual([...new Set(appBuses)].sort());
    const offered = [...MOVER_VEHICLES.RIDER, ...MOVER_VEHICLES.DRIVER].map((v) => v.value);
    for (const bus of LAUNCH_HIDDEN_BUSES) expect(offered, bus).not.toContain(bus);
  });
});
