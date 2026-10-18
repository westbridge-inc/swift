import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaxiTripSafety, type TaxiSafetyFacts } from './taxi-trip-safety';
import * as rides from '@/lib/customer-rides';

// [Row 117] The trip page's safety half for a web-booked (or any) taxi ride,
// while web booking is on: the ride code, the driver's position, and an SOS
// that calls the police and pages Swift's safety team.

const FACTS: TaxiSafetyFacts = { ridePin: '482913', ridePinVerified: false, driverAt: { lat: 6.81, lng: -58.16 } };

beforeEach(() => {
  vi.spyOn(rides, 'rideSos').mockResolvedValue({ status: 'ACTIVE', sosAlertId: 'sos-1' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the ride code', () => {
  it.each(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'])('shows while the driver is coming (%s) and the code is unchecked', (status) => {
    render(<TaxiTripSafety rideId="ride-1" status={status} facts={FACTS} />);
    expect(screen.getByText('482913')).toBeTruthy();
    expect(screen.getByText(/Check the car and its plate first/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Your driver’s position' })).toBeTruthy();
  });

  it('no driver position from the server: no map, nothing invented', () => {
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_EN_ROUTE" facts={{ ...FACTS, driverAt: null }} />);
    expect(screen.queryByRole('img', { name: 'Your driver’s position' })).toBeNull();
    expect(screen.getByText('482913')).toBeTruthy();
  });

  it.each([
    ['checked already', 'DRIVER_ARRIVED', { ...FACTS, ridePinVerified: true }],
    ['on board', 'RIDE_IN_PROGRESS', FACTS],
    ['no driver yet', 'PENDING', FACTS],
    ['the ride is over', 'COMPLETED', FACTS],
    ['no code from the server', 'DRIVER_EN_ROUTE', { ...FACTS, ridePin: null }],
  ])('is hidden when %s', (_name, status, facts) => {
    render(<TaxiTripSafety rideId="ride-1" status={status} facts={facts} />);
    expect(screen.queryByText('482913')).toBeNull();
    expect(screen.queryByText('Your ride code')).toBeNull();
  });
});

describe('SOS', () => {
  it('asks first, then offers the police line and pages Swift’s safety team', async () => {
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    expect(screen.queryByRole('link', { name: /Call Police/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Emergency — get help now' }));
    expect(rides.rideSos).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Call Police 911' }).getAttribute('href')).toBe('tel:911');

    await user.click(screen.getByRole('button', { name: 'Alert Swift’s safety team' }));
    expect(await screen.findByText(/Swift’s safety team has been paged/)).toBeTruthy();
    expect(rides.rideSos).toHaveBeenCalledTimes(1);
    // No location permission was granted: help is never held up by a prompt.
    expect(rides.rideSos).toHaveBeenCalledWith('ride-1', null);
  });

  it('sends where the passenger is when the browser already allows it', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
      geolocation: { getCurrentPosition: (ok: (_p: unknown) => void) => ok({ coords: { latitude: 6.8, longitude: -58.15 } }) },
    });
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_ARRIVED" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'Emergency — get help now' }));
    await user.click(screen.getByRole('button', { name: 'Alert Swift’s safety team' }));
    await waitFor(() => expect(rides.rideSos).toHaveBeenCalledWith('ride-1', { lat: 6.8, lng: -58.15 }));
  });

  it('a failed page is said loudly, with the police line and a retry', async () => {
    vi.mocked(rides.rideSos).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'ACTIVE' });
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_EN_ROUTE" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'Emergency — get help now' }));
    await user.click(screen.getByRole('button', { name: 'Alert Swift’s safety team' }));
    expect((await screen.findByRole('alert')).textContent).toMatch('Swift was NOT alerted. Call the police now, then try again.');
    expect(screen.queryByText(/has been paged/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Call Police 911' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try alerting Swift again' }));
    expect(await screen.findByText(/Swift’s safety team has been paged/)).toBeTruthy();
    expect(rides.rideSos).toHaveBeenCalledTimes(2);
  });

  it.each(['PENDING', 'COMPLETED', 'CANCELLED'])('is not offered while no driver is engaged (%s)', (status) => {
    render(<TaxiTripSafety rideId="ride-1" status={status} facts={FACTS} />);
    expect(screen.queryByRole('button', { name: 'Emergency — get help now' })).toBeNull();
    expect(screen.queryByRole('img', { name: /driver’s position/ })).toBeNull();
  });
});
