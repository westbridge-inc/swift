import { screen, render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import TaxiPage from './page';
import * as customer from '@/lib/customer';
import * as geolocate from '@/lib/geolocate';

// The pilot removes booking entirely. Keep the former W-17/W-18 regression
// scenarios under the stronger invariant: no location, quote or dispatch call
// is possible, including with a valid price or stale destination in the URL.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  vi.spyOn(geolocate, 'currentCoords').mockResolvedValue({ lat: 6.80, lng: -58.15 } as never);
  vi.spyOn(customer, 'activeRide').mockResolvedValue(null);
  vi.spyOn(customer, 'rideAvailability').mockResolvedValue({ level: 'GOOD', gate: false });
  vi.spyOn(customer, 'rideEstimate').mockResolvedValue({ tiers: [{ rideClass: 'ECONOMY', fare: 1800 }] });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function expectMobileOnly() {
  const { container } = render(<TaxiPage />);
  expect(screen.getByText(/Taxi rides are booked in the Swift mobile app/)).toBeTruthy();
  expect(container.querySelector('input, button, form')).toBeNull();
  expect(geolocate.currentCoords).not.toHaveBeenCalled();
  expect(customer.rideEstimate).not.toHaveBeenCalled();
  expect(customer.rideAvailability).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

describe('[W-18] no destination can dispatch a web taxi during the pilot', () => {
  it('a chosen destination cannot enable a request or price a route', () => {
    window.history.replaceState({}, '', '/taxi?dropoff=6.81,-58.16');
    expectMobileOnly();
  });

  it('editing the destination cannot send stale coordinates', () => {
    window.history.replaceState({}, '', '/taxi?dropoff=6.81,-58.16&address=Changed');
    expectMobileOnly();
  });

  it('a price never outlives its route: no web fare is offered', () => {
    expectMobileOnly();
    expect(screen.queryByText('Economy')).toBeNull();
  });
});

describe('[W-17] neither missing nor valid pricing can enable web booking', () => {
  it('a failed estimate cannot enable booking', () => {
    vi.mocked(customer.rideEstimate).mockRejectedValue(new Error('pricing down'));
    expectMobileOnly();
  });

  it('failed availability cannot turn the restriction into a quiet-market retry', () => {
    vi.mocked(customer.rideAvailability).mockRejectedValue(new Error('availability down'));
    expectMobileOnly();
    expect(screen.queryByText(/Try anyway|Notify me when/)).toBeNull();
  });

  it('even with a valid price the pilot requires the mobile app', () => {
    expectMobileOnly();
    expect(screen.getByRole('link', { name: 'Open Swift app' }).getAttribute('href')).toBe('swift://');
  });
});
