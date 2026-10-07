import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TripShareClient } from './trip-share-client';

// [L10 §2] The page offers exactly the number the server's market setting
// verified, and no call button at all when there is none. Never a baked-in 911.

function serve(emergencyDial: string | null, emergencyNote: string) {
  const view = { status: 'Trip in progress', ended: false, passengerFirstName: 'Asha', driver: null, location: null, emergencyNote, emergencyDial };
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ success: true, data: view }) })));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('[L10 §2] the trip page emergency line', () => {
  it('a verified number from the setting is the one the call button dials', async () => {
    serve('9990', 'If something is wrong, call the police on 9990.');
    const { container } = render(<TripShareClient token="t-verified" />);
    expect(await screen.findByText('If something is wrong, call the police on 9990.')).toBeTruthy();
    const call = container.querySelector('a[href^="tel:"]');
    expect(call?.getAttribute('href')).toBe('tel:9990');
    expect(call?.textContent).toBe('Call 9990');
  });

  it('no verified number: the page says so and offers no number to call', async () => {
    serve(null, 'If something is wrong, call your local emergency number.');
    const { container } = render(<TripShareClient token="t-none" />);
    expect(await screen.findByText('If something is wrong, call your local emergency number.')).toBeTruthy();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });
});
