import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaxiPage from './page';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';
import { ApiRequestError } from '@/lib/auth';
import * as rides from '@/lib/customer-rides';
import * as places from '@/lib/customer-places';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026 20:40Z] Web taxi BOOKING, built behind the
// server switch WEB_TAXI_BOOKING (OFF). The page offers booking only when the
// server's capabilities answer says webBooking; then it books at the fare on
// the button, under one Idempotency-Key per booking intent, and goes to the
// trip page. Every refusal is said in plain words; none books twice.
// ---------------------------------------------------------------------------

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const STABROEK = { placeId: 'p-stabroek', primary: 'Stabroek Market', secondary: 'Georgetown', lat: 6.8065, lng: -58.1626 };
const SHERIFF = { placeId: 'p-sheriff', primary: 'Sheriff Street', secondary: 'Georgetown', lat: 6.8164, lng: -58.1416 };
const ESTIMATE = {
  tiers: [
    { rideClass: 'ECONOMY', fare: 1300, multiplier: 1, capacity: 4, source: 'formula' },
    { rideClass: 'COMFORT', fare: 1600, multiplier: 1.2, capacity: 4, source: 'formula' },
  ],
  currencyCode: 'GYD', distanceKm: 5.9, durationMin: 14, billableKm: 5.9, routeSource: 'osrm',
};
const signedIn: CustomerSession = {
  status: 'signed-in', scope: 'customer-test', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined,
};

beforeEach(() => {
  window.history.replaceState({}, '', '/taxi');
  push.mockReset();
  vi.spyOn(places, 'placesAutocomplete').mockImplementation(async (q: string) => (
    [STABROEK, SHERIFF].filter((p) => p.primary.toLowerCase().startsWith(q.toLowerCase().slice(0, 4))) as never
  ));
  vi.spyOn(places, 'placeDetails').mockRejectedValue(new Error('not used'));
  vi.spyOn(rides, 'rideEstimate').mockResolvedValue(ESTIMATE as never);
  vi.spyOn(rides, 'rideCapabilities').mockResolvedValue({ maxStops: 0, webBooking: true });
  vi.spyOn(rides, 'activeRide').mockResolvedValue(null);
  vi.spyOn(rides, 'requestRide').mockResolvedValue({ ride: { id: 'ride-1', status: 'REQUESTED', fare: 1300 } });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, typed: string, place: { primary: string }) {
  const box = within(screen.getByText(label).parentElement!).getByPlaceholderText('Search address…');
  await user.clear(box);
  await user.type(box, typed);
  await user.click(await screen.findByRole('button', { name: new RegExp(place.primary) }));
}

async function pricedPage() {
  const user = userEvent.setup();
  render(<CustomerSessionProvider value={signedIn}><TaxiPage /></CustomerSessionProvider>);
  await choose(user, 'Pick up from', 'Stab', STABROEK);
  await choose(user, 'Going to', 'Sher', SHERIFF);
  await screen.findByRole('radiogroup', { name: 'Choose your ride' });
  return user;
}

const requestButton = () => screen.queryByRole('button', { name: /^Request / });

describe('[Row 117] no booking unless the server says web booking is on', () => {
  it.each([
    ['the switch is off (no webBooking)', () => vi.mocked(rides.rideCapabilities).mockResolvedValue({ maxStops: 0 })],
    ['webBooking is not exactly true', () => vi.mocked(rides.rideCapabilities).mockResolvedValue({ maxStops: 0, webBooking: 'true' } as never)],
    ['the capabilities read fails', () => vi.mocked(rides.rideCapabilities).mockRejectedValue(new Error('down'))],
  ])('%s: estimates only — no ride choice, no request button, no booking call', async (_name, arrange) => {
    arrange();
    const user = userEvent.setup();
    render(<CustomerSessionProvider value={signedIn}><TaxiPage /></CustomerSessionProvider>);
    await choose(user, 'Pick up from', 'Stab', STABROEK);
    await choose(user, 'Going to', 'Sher', SHERIFF);
    expect(await screen.findByRole('list', { name: 'Fare estimates by ride type' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(requestButton()).toBeNull();
    expect(rides.requestRide).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Book a taxi in the Swift app' })).toBeTruthy();
    expect(screen.getByText(/Taxi booking is unavailable on the web/)).toBeTruthy();
  });
});

describe('[Row 117] with web booking on, the customer books at the fare on the button', () => {
  it('books the chosen ride type at its fare, under a web key, then opens the trip page', async () => {
    const user = await pricedPage();
    expect(requestButton()?.textContent).toBe('Request Car · $1,300');
    await user.click(screen.getByRole('radio', { name: /Estate/ }));
    expect(screen.getByRole('radio', { name: /Estate/ }).getAttribute('aria-checked')).toBe('true');
    await user.click(requestButton()!);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/orders/ride-1'));
    expect(rides.requestRide).toHaveBeenCalledTimes(1);
    const [body, key] = vi.mocked(rides.requestRide).mock.calls[0]!;
    expect(body).toEqual({
      pickup: { lat: STABROEK.lat, lng: STABROEK.lng }, dropoff: { lat: SHERIFF.lat, lng: SHERIFF.lng },
      pickupAddress: 'Stabroek Market', dropoffAddress: 'Sheriff Street',
      passengerCount: 1, rideClass: 'COMFORT', expectedFare: 1600,
    });
    expect(key).toMatch(/^web-taxi-[0-9a-f-]{16,}$/);
    expect(screen.getByText(/Your trip page shows a six-digit start code: your driver types it to start the ride\./)).toBeTruthy();
  });

  it('a press that may have landed is retried under the SAME key; a new choice gets a new key', async () => {
    vi.mocked(rides.requestRide)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiRequestError('outcome unknown', 503, 'RIDE_REQUEST_OUTCOME_UNKNOWN'))
      .mockRejectedValueOnce(new ApiRequestError('Too many strikes', 403, 'STRIKE_RESTRICTED'));
    const user = await pricedPage();
    await user.click(requestButton()!);
    expect((await screen.findByRole('alert')).textContent).toMatch('We couldn’t reach Swift');
    await user.click(requestButton()!);
    expect((await screen.findByRole('alert')).textContent).toMatch('We couldn’t confirm your ride. Check your orders before you try again.');
    await waitFor(() => expect(rides.requestRide).toHaveBeenCalledTimes(2));
    const keys = vi.mocked(rides.requestRide).mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);

    await user.click(screen.getByRole('radio', { name: /Estate/ }));
    await user.click(requestButton()!);
    await waitFor(() => expect(rides.requestRide).toHaveBeenCalledTimes(3));
    expect(vi.mocked(rides.requestRide).mock.calls[2]![1]).not.toBe(keys[0]);
    expect((await screen.findByRole('alert')).textContent).toMatch('Too many strikes');
    expect(push).not.toHaveBeenCalled();
  });

  it('the fare moved: nothing booked, the route is priced again, and the button carries the new fare', async () => {
    vi.mocked(rides.requestRide).mockRejectedValueOnce(new ApiRequestError('fare changed', 409, 'FARE_CHANGED'));
    const user = await pricedPage();
    vi.mocked(rides.rideEstimate).mockResolvedValue({ ...ESTIMATE, tiers: [{ ...ESTIMATE.tiers[0], fare: 1400 }] } as never);
    await user.click(requestButton()!);
    expect(await screen.findByText('The fare changed since you looked. Check the new fare, then request again.')).toBeTruthy();
    await waitFor(() => expect(requestButton()?.textContent).toBe('Request Car · $1,400'));
    expect(rides.rideEstimate).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ['ID_VERIFICATION_REQUIRED', 403, 'Your first ride needs your ID on file. Add your ID in the Swift app (Account), then book here.'],
    ['RIDE_IN_PROGRESS', 409, 'You already have a ride in progress.'],
    ['DUPLICATE_REQUEST', 409, 'This ride is already being requested — hold on.'],
  ])('%s is said in plain words and books nothing', async (code, status, words) => {
    vi.mocked(rides.requestRide).mockRejectedValueOnce(new ApiRequestError('server words', status, code));
    const user = await pricedPage();
    await user.click(requestButton()!);
    expect((await screen.findByRole('alert')).textContent).toMatch(words);
    expect(push).not.toHaveBeenCalled();
  });

  it('the switch went off while the page was open: booking goes away, the estimate stays', async () => {
    vi.mocked(rides.requestRide).mockRejectedValueOnce(new ApiRequestError('app only', 403, 'TAXI_MOBILE_APP_REQUIRED'));
    const user = await pricedPage();
    await user.click(requestButton()!);
    expect(await screen.findByText('Taxi booking on the website is off right now. Book a taxi in the Swift app.')).toBeTruthy();
    expect(requestButton()).toBeNull();
    expect(screen.getByRole('list', { name: 'Fare estimates by ride type' })).toBeTruthy();
  });

  it('the page never says web booking is unavailable while the server offers it', async () => {
    await pricedPage();
    expect(screen.getByRole('heading', { name: 'You can also book in the Swift app' })).toBeTruthy();
    expect(screen.queryByText(/Taxi booking is unavailable on the web/)).toBeNull();
    expect(screen.queryByText(/Taxi rides are booked in the Swift mobile app/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Swift app' })).toBeTruthy();
  });

  it('a ride already in progress: the page opens it instead of booking another', async () => {
    vi.mocked(rides.activeRide).mockResolvedValue({ id: 'ride-live', status: 'EN_ROUTE' });
    await pricedPage();
    expect(requestButton()).toBeNull();
    expect(screen.getByRole('link', { name: 'Open your ride' }).getAttribute('href')).toBe('/orders/ride-live');
    expect(rides.requestRide).not.toHaveBeenCalled();
  });

  it('no fare on screen, no booking: editing the destination takes the button away', async () => {
    const user = await pricedPage();
    const box = within(screen.getByText('Going to').parentElement!).getByPlaceholderText('Search address…');
    await user.type(box, 'x');
    expect(requestButton()).toBeNull();
    expect(rides.requestRide).not.toHaveBeenCalled();
  });
});
