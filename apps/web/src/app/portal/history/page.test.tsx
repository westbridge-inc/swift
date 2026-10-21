import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HistoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

describe('phone history', () => {
  it('keeps order, store, status, and amount together in a delivery card', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1' } } };
      if (url.pathname === '/api/v1/driver/profile') return { status: 404, body: { error: 'Absent' } };
      if (url.pathname === '/api/v1/rider/orders') return { body: { data: [{ id: 'delivery-1', orderNumber: 'SW-1001', vendor: { name: 'Fixture Market' }, status: 'DELIVERED', deliveryFee: '800.00', placedAt: '2026-09-29T18:00:00Z' }], meta: { totalPages: 1 } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<HistoryPage />);
    const card = await screen.findByRole('article', { name: 'Delivery SW-1001' });
    expect(card.textContent).toContain('Fixture Market');
    expect(card.textContent).toContain('Delivered');
    expect(card.textContent).not.toContain('DELIVERED');
    expect(card.textContent).toContain('$800');
    expect(card.textContent).not.toContain('GY$');
    expect(card.className).toContain('sm:hidden');
  });

  it('keeps ride status, fare, and tip together in a phone card', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return { status: 404, body: { error: 'Absent' } };
      if (url.pathname === '/api/v1/driver/profile') return { body: { data: { id: 'driver-1' } } };
      if (url.pathname === '/api/v1/driver/rides') return { body: { data: [{ id: 'ride-1', orderNumber: 'SW-2001', status: 'COMPLETED', taxiPickupAddress: 'Market Street', taxiDropoffAddress: 'Camp Street', taxiFareTotal: '2500.00', tipAmount: '200.00' }], meta: { totalPages: 1 } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<HistoryPage />);
    const card = await screen.findByRole('article', { name: 'Ride SW-2001' });
    expect(card.textContent).toContain('Completed');
    expect(card.textContent).not.toContain('COMPLETED');
    expect(card.textContent).toContain('$2,500');
    expect(card.textContent).toContain('$200');
    expect(card.textContent).not.toContain('GY$');
  });
});

// [REVIEW-F2 #1968 S4-3 · COORD l.2680] A status this build does not know is a
// neutral line, never the code made to look like words; a job still moving is "In progress".
describe('[S4-3] history statuses never dress a code', () => {
  it.each([['SOME_NEW_STATUS', 'Status unavailable'], ['PICKED_UP', 'In progress'], ['REFUNDED', 'Refunded']])('%s reads "%s"', async (status, words) => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1' } } };
      if (url.pathname === '/api/v1/driver/profile') return { status: 404, body: { error: 'Absent' } };
      if (url.pathname === '/api/v1/rider/orders') return { body: { data: [{ id: 'delivery-1', orderNumber: 'SW-1001', vendor: { name: 'Fixture Market' }, status, deliveryFee: '800.00', placedAt: '2026-09-29T18:00:00Z' }], meta: { totalPages: 1 } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<HistoryPage />);
    const card = await screen.findByRole('article', { name: 'Delivery SW-1001' });
    expect(card.textContent).toContain(words);
    expect(card.textContent).not.toContain(status);
    expect(card.textContent!.toLowerCase()).not.toMatch(/some new status|picked up/);
  });
});

// [UI-SWEEP U24] A failed profile read said "No earner profile on this account" — to a working driver.
describe('[U24] a failed profile read is not "no earner profile"', () => {
  it('says it could not check, and retries', async () => {
    let calls = 0;
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return ++calls === 1 ? { status: 503, body: { error: { message: 'Unavailable' } } } : { body: { data: { id: 'rider-1' } } };
      if (url.pathname === '/api/v1/driver/profile') return { status: 404, body: { error: 'Absent' } };
      if (url.pathname === '/api/v1/rider/orders') return { body: { data: [], meta: { total: 0, totalPages: 1 } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    const { user } = renderWithQuery(<HistoryPage />);
    expect(await screen.findByText("Couldn't load your earner profile.")).toBeTruthy();
    expect(screen.queryByText(/No earner profile/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText("Couldn't load your earner profile.")).toBeNull());
    expect(screen.queryByText(/No earner profile/)).toBeNull();
  });

  it('control: only a server "absent" on both says there is no earner profile', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile' || url.pathname === '/api/v1/driver/profile') return { status: 404, body: { error: 'Absent' } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<HistoryPage />);
    expect(await screen.findByText('No earner profile on this account.')).toBeTruthy();
  });
});
