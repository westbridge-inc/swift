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
  vi.spyOn(rides, 'outstandingCheckin').mockResolvedValue(null);
  vi.spyOn(rides, 'answerCheckin').mockResolvedValue({ escalated: false });
  vi.spyOn(rides, 'tripShares').mockResolvedValue([]);
  vi.spyOn(rides, 'shareTrip').mockResolvedValue({ token: 't', url: 'https://swiftgy.com/trip/tok', expiresAt: new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString() });
  vi.spyOn(rides, 'stopTripShares').mockResolvedValue({});
  vi.spyOn(rides, 'reportNotMyDriver').mockResolvedValue({ reDispatched: true });
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

// [WEB-TAXI · owner 21 Oct 2026] Trip Guardian's check-in on the trip page:
// the phone's card, raised by asking the server (the website has no order-room
// socket), answered at the phone's endpoint, with the phone's honest failures.
describe('Trip Guardian check-in', () => {
  const PENDING = { sessionId: 's-1', orderId: 'ride-1', level: 'HARD' as const, requestedAt: '2026-10-21T12:00:00.000Z', deadlineAt: '2026-10-21T12:05:00.000Z' };

  it('asks the server on arrival during the ride and shows the phone’s card', async () => {
    vi.mocked(rides.outstandingCheckin).mockResolvedValue(PENDING);
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    const card = await screen.findByRole('alertdialog', { name: 'Everything okay?' });
    expect(card.textContent).toContain('Swift’s Trip Guardian checks in when a trip pauses or changes route. Your driver can’t see your answer.');
    expect(screen.getByRole('button', { name: 'I’m okay' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'I need help' })).toBeTruthy();
  });

  it('keeps asking while the ride is in progress, and again when the tab is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
      await waitFor(() => expect(rides.outstandingCheckin).toHaveBeenCalledTimes(1));
      vi.mocked(rides.outstandingCheckin).mockResolvedValue(PENDING);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await screen.findByRole('alertdialog', { name: 'Everything okay?' })).toBeTruthy();
      const before = vi.mocked(rides.outstandingCheckin).mock.calls.length;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(vi.mocked(rides.outstandingCheckin).mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'COMPLETED'])('does not ask outside the ride itself (%s)', async (status) => {
    render(<TaxiTripSafety rideId="ride-1" status={status} facts={FACTS} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(rides.outstandingCheckin).not.toHaveBeenCalled();
  });

  it('a check-in for another trip is not this trip’s card', async () => {
    vi.mocked(rides.outstandingCheckin).mockResolvedValue({ ...PENDING, orderId: 'ride-2' });
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await waitFor(() => expect(rides.outstandingCheckin).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('I’m okay answers the server and closes the card; a failed send says so', async () => {
    vi.mocked(rides.outstandingCheckin).mockResolvedValueOnce(PENDING).mockResolvedValue(null);
    vi.mocked(rides.answerCheckin).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await user.click(await screen.findByRole('button', { name: 'I’m okay' }));
    expect(rides.answerCheckin).toHaveBeenCalledWith('OK');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t send that — Trip Guardian will check in again.');
    expect(rides.rideSos).not.toHaveBeenCalled();
  });

  it('I need help is the emergency answer: the server pages Swift, and the police line is right there', async () => {
    vi.mocked(rides.outstandingCheckin).mockResolvedValueOnce(PENDING).mockResolvedValue(null);
    vi.mocked(rides.answerCheckin).mockResolvedValue({ escalated: true });
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await user.click(await screen.findByRole('button', { name: 'I need help' }));
    expect(rides.answerCheckin).toHaveBeenCalledWith('NEED_HELP');
    expect(await screen.findByText(/Swift’s safety team has been paged/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Call 911' }).getAttribute('href')).toBe('tel:911');
  });

  it('a distress answer that did not send never pretends it did: it says so and opens Alert Swift', async () => {
    vi.mocked(rides.outstandingCheckin).mockResolvedValueOnce(PENDING).mockResolvedValue(null);
    vi.mocked(rides.answerCheckin).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await user.click(await screen.findByRole('button', { name: 'I need help' }));
    expect(screen.getAllByRole('alert').map((n) => n.textContent)).toContain('Your answer didn’t send — if you need help, use Alert Swift now.');
    expect(screen.queryByText(/has been paged/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Alert Swift now' })).toBeTruthy();
  });
});

// [WEB-TAXI · S-16] The phone's Share trip: a live, expiring, revocable link.
describe('Share trip', () => {
  it('mints the live link, hands it to the share sheet with the phone’s words, and says how long it lives', async () => {
    const shareSheet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share: shareSheet });
    vi.mocked(rides.tripShares).mockResolvedValueOnce([]).mockResolvedValue([{ id: 'l1', expiresAt: 'x' }]);
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_EN_ROUTE" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'Share trip' }));
    expect(rides.shareTrip).toHaveBeenCalledWith('ride-1');
    expect(shareSheet).toHaveBeenCalledWith({ text: "I'm on a Swift taxi. Follow the ride live — the map updates until it ends: https://swiftgy.com/trip/tok" });
    expect(await screen.findByText(/Anyone with this link can follow the ride for about 3 hours\. You can stop it at any time\./)).toBeTruthy();
    expect((screen.getByLabelText('Live trip link') as HTMLInputElement).value).toBe('https://swiftgy.com/trip/tok');
    expect(await screen.findByText('1 live link for this ride.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share again' })).toBeTruthy();
  });

  it('with no share sheet the link is copied, and said so', async () => {
    const user = userEvent.setup(); // first: it installs its own clipboard
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share: undefined, clipboard: { writeText } });
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'Share trip' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('https://swiftgy.com/trip/tok'));
    expect(await screen.findByText(/Link copied — paste it to someone you trust\./)).toBeTruthy();
  });

  it('stop all sharing revokes every live link', async () => {
    vi.mocked(rides.tripShares).mockResolvedValue([{ id: 'a', expiresAt: 'x' }, { id: 'b', expiresAt: 'y' }]);
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    expect(await screen.findByText('2 live links for this ride.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stop all sharing' }));
    expect(rides.stopTripShares).toHaveBeenCalledWith('ride-1');
    await waitFor(() => expect(screen.queryByText(/live links? for this ride/)).toBeNull());
  });

  it('a failure says what happened to the share', async () => {
    vi.mocked(rides.shareTrip).mockRejectedValue(Object.assign(new Error('x'), { code: 'TRIP_OVER' }));
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'Share trip' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This ride has already ended, so there is nothing live to follow.');
  });

  it('is not offered before a driver is engaged', () => {
    render(<TaxiTripSafety rideId="ride-1" status="PENDING" facts={FACTS} />);
    expect(screen.queryByRole('button', { name: 'Share trip' })).toBeNull();
  });
});

// [WEB-TAXI · §7.3] The phone's "This isn't my driver", at the kerb.
describe('This isn’t my driver', () => {
  it('is offered only once the driver has arrived', () => {
    const { rerender } = render(<TaxiTripSafety rideId="ride-1" status="DRIVER_EN_ROUTE" facts={FACTS} />);
    expect(screen.queryByRole('button', { name: 'This isn’t my driver' })).toBeNull();
    rerender(<TaxiTripSafety rideId="ride-1" status="DRIVER_ARRIVED" facts={FACTS} />);
    expect(screen.getByRole('button', { name: 'This isn’t my driver' })).toBeTruthy();
  });

  it('asks first with the phone’s words, then reports THIS ride', async () => {
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_ARRIVED" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'This isn’t my driver' }));
    expect(rides.reportNotMyDriver).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Not the person or car shown?' }).textContent).toContain('Don’t get in. We’ll cancel this pickup, alert Swift safety, and find you another driver — your trip stays exactly as it is.');
    await user.click(screen.getByRole('button', { name: 'Confirm — this isn’t my driver' }));
    expect(rides.reportNotMyDriver).toHaveBeenCalledWith('ride-1');
    expect(await screen.findByText(/Swift safety has been alerted and we’re finding you another driver\. Don’t get in that car\./)).toBeTruthy();
  });

  it('a failed report is said loudly and stays open with a retry — the driver is NOT cancelled', async () => {
    vi.mocked(rides.reportNotMyDriver).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_ARRIVED" facts={FACTS} />);
    await user.click(screen.getByRole('button', { name: 'This isn’t my driver' }));
    await user.click(screen.getByRole('button', { name: 'Confirm — this isn’t my driver' }));
    expect((await screen.findByRole('alert')).textContent).toBe('We could NOT reach Swift — this driver has not been cancelled. Do not get in. Try again, or close this and use Emergency.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/finding you another driver/)).toBeTruthy();
    expect(rides.reportNotMyDriver).toHaveBeenCalledTimes(2);
  });
});

// [WEB-TAXI] The SOS carries where the passenger is: watched during the ride
// once the browser allows it, never prompted for unasked.
describe('SOS location during the ride', () => {
  function geo(state: PermissionState) {
    let onFix: ((_p: unknown) => void) | null = null;
    const watchPosition = vi.fn((ok: (_p: unknown) => void) => { onFix = ok; return 7; });
    const clearWatch = vi.fn();
    const getCurrentPosition = vi.fn((_ok: unknown, fail: (_e: unknown) => void) => fail({ code: 3 }));
    vi.stubGlobal('navigator', {
      ...navigator,
      permissions: { query: vi.fn().mockResolvedValue({ state, addEventListener: vi.fn(), removeEventListener: vi.fn() }) },
      geolocation: { watchPosition, clearWatch, getCurrentPosition },
    });
    return { watchPosition, clearWatch, getCurrentPosition, fix: (lat: number, lng: number) => onFix?.({ coords: { latitude: lat, longitude: lng } }) };
  }

  it('already allowed: watches during the ride and the alert carries the last fix when no fresh one comes', async () => {
    const g = geo('granted');
    const user = userEvent.setup();
    const { unmount } = render(<TaxiTripSafety rideId="ride-1" status="RIDE_IN_PROGRESS" facts={FACTS} />);
    await waitFor(() => expect(g.watchPosition).toHaveBeenCalled());
    g.fix(6.79, -58.14);
    expect(await screen.findByText(/Your location is kept on this page for an emergency alert; it is sent only if you alert Swift\./)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Emergency — get help now' }));
    await user.click(screen.getByRole('button', { name: 'Alert Swift now' }));
    await waitFor(() => expect(rides.rideSos).toHaveBeenCalledWith('ride-1', { lat: 6.79, lng: -58.14 }));
    unmount();
    expect(g.clearWatch).toHaveBeenCalledWith(7);
  });

  it('not yet allowed: never watched unasked; the person can turn it on', async () => {
    const g = geo('prompt');
    const user = userEvent.setup();
    render(<TaxiTripSafety rideId="ride-1" status="DRIVER_ASSIGNED" facts={FACTS} />);
    const allow = await screen.findByRole('button', { name: 'Allow location for emergency alerts' });
    expect(g.watchPosition).not.toHaveBeenCalled();
    await user.click(allow);
    expect(g.watchPosition).toHaveBeenCalledTimes(1);
  });

  it('nothing is watched once the ride is over', async () => {
    const g = geo('granted');
    render(<TaxiTripSafety rideId="ride-1" status="COMPLETED" facts={FACTS} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(g.watchPosition).not.toHaveBeenCalled();
  });
});
