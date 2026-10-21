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
    // The phone's words (TaxiScreen StartCodeCeremony) and its spoken label.
    expect(screen.getByText('Say this code to start the ride')).toBeTruthy();
    expect(screen.getByLabelText('Start code. 4, 8, 2, 9, 1, 3')).toBeTruthy();
    expect(screen.getByText(/It proves this is your ride — the driver types it to start\. Check the car and its plate first\./)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Your driver’s position' })).toBeTruthy();
  });

  it('names the driver the way the phone does', () => {
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_ARRIVED" facts={{ ...FACTS, driverName: 'Ann' }} />);
    expect(screen.getByText(/It proves this is your ride — Ann types it to start\./)).toBeTruthy();
  });

  it.each([['no code', null], ['a code that is not six digits', '48291']])(
    'with %s from the server while the driver is coming: the phone’s warning, never a made-up code', (_name, ridePin) => {
      render(<TaxiTripSafety rideId="ride-1" status="DRIVER_EN_ROUTE" facts={{ ...FACTS, ridePin }} />);
      expect(screen.getByRole('alert').textContent).toBe('The six-digit start code isn’t available. Don’t begin the ride until it appears.');
      expect(screen.queryByText('48291')).toBeNull();
      expect(screen.queryByLabelText(/^Start code\./)).toBeNull();
    },
  );

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
  ])('is hidden when %s', (_name, status, facts) => {
    render(<TaxiTripSafety rideId="ride-1" status={status} facts={facts} />);
    expect(screen.queryByText('482913')).toBeNull();
    expect(screen.queryByText('Say this code to start the ride')).toBeNull();
    expect(screen.queryByText(/start code isn’t available/)).toBeNull();
  });
});

describe('SOS', () => {
  it('asks first, then offers the police line and pages Swift’s safety team', async () => {
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    expect(screen.queryByRole('link', { name: /Call 911/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Emergency — get help now' }));
    expect(rides.rideSos).not.toHaveBeenCalled();
    // The phone's question and its warning (SosCeremony), said for the web's two steps.
    expect(screen.getByRole('group', { name: 'Get emergency help?' })).toBeTruthy();
    expect(screen.getByText(/Call 911 — your market’s emergency services — then alert Swift: .* Use only in a real emergency\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Call 911' }).getAttribute('href')).toBe('tel:911');

    await user.click(screen.getByRole('button', { name: 'Alert Swift now' }));
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
    await user.click(screen.getByRole('button', { name: 'Alert Swift now' }));
    await waitFor(() => expect(rides.rideSos).toHaveBeenCalledWith('ride-1', { lat: 6.8, lng: -58.15 }));
  });

  it('a failed page is said loudly, with the police line and a retry', async () => {
    vi.mocked(rides.rideSos).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'ACTIVE' });
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_EN_ROUTE" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'Emergency — get help now' }));
    await user.click(screen.getByRole('button', { name: 'Alert Swift now' }));
    // The phone's failure words (SosCeremony raiseError).
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Swift was NOT alerted — the request failed.Your emergency call is unaffected. Check your connection and try again so Swift can track and record this emergency.',
    );
    expect(screen.queryByText(/has been paged/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Call 911' })).toBeTruthy();
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
