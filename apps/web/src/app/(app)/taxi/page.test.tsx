import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaxiPage from './page';
import { CustomerSessionProvider, type CustomerSession, type SessionStatus } from '@/components/customer-session';
import { ApiRequestError } from '@/lib/auth';
import * as rides from '@/lib/customer-rides';
import * as places from '@/lib/customer-places';
import * as geolocate from '@/lib/geolocate';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 20:40Z] The website shows REAL taxi fare estimates:
// the server's own fare engine (POST /rides/estimate, the one the phone asks),
// for the pickup and destination the customer CHOSE. Booking stays in the
// Swift app — the page offers no way to request a ride.
//
// Kept from the pilot's W-17 / W-18 regressions, under the new rule:
//   - a price never outlives its route: change either end and the fare goes;
//   - no coordinate from the URL (or anywhere but a chosen place) is priced;
//   - a failed or missing estimate shows NO price, in plain words;
//   - nothing on the page can dispatch a driver.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const STABROEK = { placeId: 'p-stabroek', primary: 'Stabroek Market', secondary: 'Georgetown', lat: 6.8065, lng: -58.1626 };
const SHERIFF = { placeId: 'p-sheriff', primary: 'Sheriff Street', secondary: 'Georgetown', lat: 6.8164, lng: -58.1416 };
const CAMP = { placeId: 'p-camp', primary: 'Camp Road', secondary: 'Georgetown', lat: 6.8201, lng: -58.1554 };

const ESTIMATE = {
  tiers: [
    { rideClass: 'ECONOMY', fare: 1300, multiplier: 1, capacity: 4, source: 'formula' },
    { rideClass: 'COMFORT', fare: 1600, multiplier: 1.2, capacity: 4, source: 'formula' },
    { rideClass: 'GROUP', fare: 2600, multiplier: 2, capacity: 14, source: 'formula' },
  ],
  currencyCode: 'GYD', distanceKm: 5.9, durationMin: 14, billableKm: 5.9, routeSource: 'osrm',
};

function session(status: SessionStatus): CustomerSession {
  return {
    status, scope: status === 'signed-in' ? 'customer-test' : 'guest', epoch: 0,
    ensureSignedIn: async () => status === 'signed-in', nearPoint: null, setNearPoint: () => undefined,
  };
}

function renderAs(status: SessionStatus) {
  return render(
    <CustomerSessionProvider value={session(status)}>
      <TaxiPage />
    </CustomerSessionProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/taxi');
  vi.spyOn(geolocate, 'currentCoords').mockResolvedValue({ lat: 6.8, lng: -58.15 } as never);
  vi.spyOn(places, 'placesAutocomplete').mockImplementation(async (q: string) => (
    [STABROEK, SHERIFF, CAMP].filter((p) => p.primary.toLowerCase().startsWith(q.toLowerCase().slice(0, 4))) as never
  ));
  vi.spyOn(places, 'placeDetails').mockRejectedValue(new Error('not used: suggestions carry their point'));
  vi.spyOn(rides, 'rideEstimate').mockResolvedValue(ESTIMATE as never);
  vi.spyOn(rides, 'rideAvailability').mockResolvedValue({ level: 'GOOD', gate: false });
  vi.spyOn(rides, 'activeRide').mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, typed: string, place: { primary: string }) {
  const box = within(screen.getByText(label).parentElement!).getByPlaceholderText('Search address…');
  await user.clear(box);
  await user.type(box, typed);
  await user.click(await screen.findByRole('button', { name: new RegExp(place.primary) }));
}

/** No control on the page can book: no form, no request button, no ride-creation call. */
function expectNoBooking() {
  expect(document.querySelector('form')).toBeNull();
  expect(screen.queryByRole('button', { name: /\b(book|request|confirm|order)\b/i })).toBeNull();
  for (const call of vi.mocked(fetch).mock.calls) expect(String(call[0])).not.toMatch(/\/rides\/(request|queue)/);
}

describe('[Row 117] a signed-in customer sees the server’s real fare for the route they chose', () => {
  it('prices exactly the two chosen places and shows every tier the server sent', async () => {
    const user = userEvent.setup();
    renderAs('signed-in');

    await choose(user, 'Pick up from', 'Stab', STABROEK);
    expect(rides.rideEstimate).not.toHaveBeenCalled();
    await choose(user, 'Going to', 'Sher', SHERIFF);

    await waitFor(() => expect(rides.rideEstimate).toHaveBeenCalledTimes(1));
    expect(rides.rideEstimate).toHaveBeenCalledWith({
      pickup: { lat: STABROEK.lat, lng: STABROEK.lng },
      dropoff: { lat: SHERIFF.lat, lng: SHERIFF.lng },
    });
    const list = await screen.findByRole('list', { name: 'Fare estimates by ride type' });
    const rows = within(list).getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringMatching(/Car.*4 seats.*\$1,300/),
      expect.stringMatching(/Estate.*4 seats.*\$1,600/),
      expect.stringMatching(/Minibus.*14 seats.*\$2,600/),
    ]);
    // The phone's own words: an estimate, paid to the driver directly.
    expect(screen.getByText(/Fare estimate · pay the driver cash or MMG at drop-off · ~14 min trip\./)).toBeTruthy();
    expect(screen.getByText(/The Swift app shows the fare again before you book\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Book a taxi in the Swift app' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Swift app' }).getAttribute('href')).toBe('swift://');
    expectNoBooking();
  });

  it('a price never outlives its route: editing the destination clears the fare at once', async () => {
    const user = userEvent.setup();
    renderAs('signed-in');
    await choose(user, 'Pick up from', 'Stab', STABROEK);
    await choose(user, 'Going to', 'Sher', SHERIFF);
    expect(await screen.findByText(/\$1,300/)).toBeTruthy();

    const box = within(screen.getByText('Going to').parentElement!).getByPlaceholderText('Search address…');
    await user.type(box, 'x');
    expect(screen.queryByText(/\$1,300/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Fare estimates by ride type' })).toBeNull();
    expect(rides.rideEstimate).toHaveBeenCalledTimes(1);
  });

  it('a late answer for a route the customer already replaced is never shown', async () => {
    let answerFirst: (_v: unknown) => void = () => undefined;
    vi.mocked(rides.rideEstimate)
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }) as never)
      .mockResolvedValueOnce({ ...ESTIMATE, tiers: [{ ...ESTIMATE.tiers[0], fare: 900 }], durationMin: 6 } as never);
    const user = userEvent.setup();
    renderAs('signed-in');
    await choose(user, 'Pick up from', 'Stab', STABROEK);
    await choose(user, 'Going to', 'Sher', SHERIFF);
    await waitFor(() => expect(rides.rideEstimate).toHaveBeenCalledTimes(1));
    await choose(user, 'Going to', 'Camp', CAMP);
    expect(await screen.findByText(/\$900/)).toBeTruthy();

    answerFirst(ESTIMATE);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/\$1,300/)).toBeNull();
    expect(screen.getByText(/\$900/)).toBeTruthy();
    expect(rides.rideEstimate).toHaveBeenNthCalledWith(2, {
      pickup: { lat: STABROEK.lat, lng: STABROEK.lng }, dropoff: { lat: CAMP.lat, lng: CAMP.lng },
    });
  });

  it('shows the server’s waiting terms beside the fare when it sends them, and nothing it did not', async () => {
    vi.mocked(rides.rideEstimate).mockResolvedValue({ ...ESTIMATE, waiting: { chargePerBlock: 200, blockMinutes: 5, currencyCode: 'GYD', text: 'Waiting: $200 per 5 minutes after the driver arrives.' } } as never);
    const user = userEvent.setup();
    renderAs('signed-in');
    await choose(user, 'Pick up from', 'Stab', STABROEK);
    await choose(user, 'Going to', 'Sher', SHERIFF);
    expect(await screen.findByText('Waiting: $200 per 5 minutes after the driver arrives.')).toBeTruthy();
  });
});

describe('[W-17] a missing or failed estimate never shows a price', () => {
  async function priceRoute() {
    const user = userEvent.setup();
    renderAs('signed-in');
    await choose(user, 'Pick up from', 'Stab', STABROEK);
    await choose(user, 'Going to', 'Sher', SHERIFF);
    await waitFor(() => expect(rides.rideEstimate).toHaveBeenCalled());
    return user;
  }

  it('road routing down: the phone’s words, a retry, and no fare', async () => {
    vi.mocked(rides.rideEstimate)
      .mockRejectedValueOnce(new ApiRequestError('Road routing is unavailable. Try again in a moment.', 503, 'ROUTE_UNAVAILABLE'))
      .mockResolvedValueOnce(ESTIMATE as never);
    const user = await priceRoute();
    expect((await screen.findByRole('alert')).textContent).toMatch('Road routing is unavailable. Try again in a moment.');
    expect(screen.queryByText(/\$\d/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/\$1,300/)).toBeTruthy();
    expect(rides.rideEstimate).toHaveBeenCalledTimes(2);
  });

  it('outside the launch market: the server’s refusal, and no fare', async () => {
    vi.mocked(rides.rideEstimate).mockRejectedValue(new ApiRequestError(
      'Your destination is outside Guyana, where Swift works today. Choose a place in Guyana.', 400, 'ROUTE_OUT_OF_MARKET',
    ));
    await priceRoute();
    expect((await screen.findByRole('alert')).textContent).toMatch('Your destination is outside Guyana, where Swift works today. Choose a place in Guyana.');
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('any other failure: plain words, no fare, no retry loop', async () => {
    vi.mocked(rides.rideEstimate).mockRejectedValue(new Error('pricing down'));
    await priceRoute();
    expect((await screen.findByRole('alert')).textContent).toMatch('Couldn’t get a fare. Try another destination.');
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText(/pricing down/)).toBeNull();
  });

  it('an answer with no usable fare is not a fare: nothing is invented', async () => {
    vi.mocked(rides.rideEstimate).mockResolvedValue({ ...ESTIMATE, tiers: [{ rideClass: 'ECONOMY', fare: null }, { rideClass: 'SPACESHIP', fare: 500 }] } as never);
    await priceRoute();
    expect((await screen.findByRole('alert')).textContent).toMatch('Couldn’t get a fare. Try another destination.');
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });
});

describe('[W-18] nothing but a chosen place is ever priced', () => {
  it.each(['/taxi?pickup=6.8,-58.1&dropoff=6.81,-58.16', '/taxi?dropoff=6.81,-58.16&address=Changed', '/taxi?request=1&rideClass=ECONOMY'])(
    '%s prices nothing and books nothing', async (url) => {
      window.history.replaceState({}, '', url);
      renderAs('signed-in');
      await new Promise((r) => setTimeout(r, 300));
      expect(rides.rideEstimate).not.toHaveBeenCalled();
      expect(geolocate.currentCoords).not.toHaveBeenCalled();
      expect(screen.getByText('Set your pickup and destination to see the fare.')).toBeTruthy();
      expectNoBooking();
    },
  );
});

describe('[Row 117] guests and the first moment', () => {
  it('a guest is asked to sign in for a fare, and no account call is made', () => {
    renderAs('guest');
    expect(screen.getByRole('heading', { name: 'Sign in to see a fare estimate' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2Ftaxi');
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/signup?next=%2Ftaxi');
    expect(screen.queryByPlaceholderText('Search address…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Book a taxi in the Swift app' })).toBeTruthy();
    expect(screen.getByText(/Taxi rides are booked in the Swift mobile app/)).toBeTruthy();
    expect(rides.rideEstimate).not.toHaveBeenCalled();
    expect(places.placesAutocomplete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expectNoBooking();
  });

  it('while the session answer is on its way, nothing asks the server', () => {
    renderAs('checking');
    expect(screen.queryByPlaceholderText('Search address…')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(rides.rideEstimate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open Swift app' })).toBeTruthy();
  });
});
