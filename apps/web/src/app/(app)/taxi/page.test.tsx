import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import TaxiPage from './page';
import * as customer from '@/lib/customer';
import * as geolocate from '@/lib/geolocate';

// ---------------------------------------------------------------------------
// [W-18] A DRIVER IS SENT TO THE PLACE ON THE SCREEN.
//
// Pick a destination, then edit the visible text without choosing again: the
// page kept the previously chosen coordinates and submitted them, and named
// them in the confirmation. The passenger watched a driver head to the address
// they had just replaced, and nothing on screen revealed the swap.
//
// The field cannot produce that state any more — but the PAGE has to read the
// submittable point rather than the raw selection, and that is what this
// asserts, by driving the page the way a passenger does.
// ---------------------------------------------------------------------------

const LAMAHA = { placeId: 'p-lamaha', primary: '42 Lamaha Street', secondary: 'Georgetown', lat: 6.81, lng: -58.16 };

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  vi.spyOn(geolocate, 'currentCoords').mockResolvedValue({ lat: 6.80, lng: -58.15 } as never);
  vi.spyOn(customer, 'activeRide').mockResolvedValue(null as never);
  vi.spyOn(customer, 'rideAvailability').mockResolvedValue({ level: 'HIGH', gate: false } as never);
  vi.spyOn(customer, 'rideEstimate').mockResolvedValue({ durationMin: 12, distanceKm: 4.2, tiers: [{ rideClass: 'ECONOMY', fare: 1800 }] } as never);
  vi.spyOn(customer, 'placesAutocomplete').mockResolvedValue([LAMAHA] as never);
  vi.spyOn(customer, 'placeDetails').mockResolvedValue({ lat: LAMAHA.lat, lng: LAMAHA.lng } as never);
});
afterEach(() => vi.restoreAllMocks());

const box = () => screen.getByPlaceholderText('Search address…');

describe('[W-18] the taxi request goes where the screen says', () => {
  it('a chosen destination enables the request and prices THAT route', async () => {
    const user = userEvent.setup();
    render(<TaxiPage />);
    await waitFor(() => expect(screen.getByText('Current location')).toBeTruthy());

    await user.type(box(), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Request ride' })).toBeTruthy());
    await waitFor(() => expect(customer.rideEstimate).toHaveBeenCalledWith(
      expect.objectContaining({ dropoff: expect.objectContaining({ lat: LAMAHA.lat, lng: LAMAHA.lng }) }),
    ));
  });

  it('EDITING the destination after choosing takes the request away — no stale coordinates can be sent', async () => {
    const user = userEvent.setup();
    const requestRide = vi.spyOn(customer, 'requestRide').mockResolvedValue({ id: 'ride-1' } as never);
    render(<TaxiPage />);
    await waitFor(() => expect(screen.getByText('Current location')).toBeTruthy());

    await user.type(box(), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request ride' })).toBeTruthy());

    // The passenger changes their mind and types over it without choosing.
    await user.type(box(), ' and a bit');

    await waitFor(() => {
      const cta = screen.getByRole('button', { name: 'Set your destination' }) as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
    });
    expect(requestRide).not.toHaveBeenCalled();
  });

  it('the fare disappears with the destination — a price never outlives the route it was for', async () => {
    const user = userEvent.setup();
    render(<TaxiPage />);
    await waitFor(() => expect(screen.getByText('Current location')).toBeTruthy());

    await user.type(box(), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));
    await waitFor(() => expect(screen.getByText('Economy')).toBeTruthy());

    await user.type(box(), 'x');
    await waitFor(() => expect(screen.queryByText('Economy')).toBeNull());
  });
});


// ---------------------------------------------------------------------------
// [W-17] NO PRICE, NO RIDE — and a dependency that failed says so.
//
// The page swallowed every failure: `rideAvailability(...).catch(() => {})`,
// `activeRide(...).catch(() => {})`, and an estimate failure that simply hid
// the price block while the Request button stayed live. An outage rendered
// exactly like a healthy market, and a ride could be ordered with no price
// shown anywhere.
// ---------------------------------------------------------------------------
describe('[W-17] a ride is not ordered on a price nobody saw', () => {
  it('a failed estimate blocks the request and says why — it used to just hide the price', async () => {
    vi.spyOn(customer, 'rideEstimate').mockRejectedValue(new Error('pricing down'));
    const requestRide = vi.spyOn(customer, 'requestRide').mockResolvedValue({ id: 'ride-1' } as never);
    const user = userEvent.setup();
    render(<TaxiPage />);
    await waitFor(() => expect(screen.getByText('Current location')).toBeTruthy());

    await user.type(box(), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const cta = screen.getByRole('button', { name: 'Waiting for a price…' }) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    await user.click(cta);
    expect(requestRide).not.toHaveBeenCalled();
  });

  it('a failed availability read is stated — an outage is not a quiet night', async () => {
    vi.spyOn(customer, 'rideAvailability').mockRejectedValue(new Error('availability down'));
    render(<TaxiPage />);
    await waitFor(() => expect(screen.getByText('Current location')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/this is our problem, not a quiet night/)).toBeTruthy());
  });

  it('with a price, the request goes through — the gate is the price, not a permanent block', async () => {
    const requestRide = vi.spyOn(customer, 'requestRide').mockResolvedValue({ id: 'ride-1' } as never);
    const user = userEvent.setup();
    render(<TaxiPage />);
    await waitFor(() => expect(screen.getByText('Current location')).toBeTruthy());

    await user.type(box(), '42 Lam');
    await user.click(await screen.findByRole('button', { name: /42 Lamaha Street/ }));
    await user.click(await screen.findByRole('button', { name: 'Request ride' }));

    await waitFor(() => expect(requestRide).toHaveBeenCalledTimes(1));
  });
});
