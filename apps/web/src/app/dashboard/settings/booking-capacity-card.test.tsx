import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BookingCapacityCard } from './booking-capacity-card';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [BOOK-S5b · owner C1, copies #2196 BookingCapacityCard] "How many bookings at once" on the web: Services stores,
// owners and managers, only when the server sends the setting; Fewer / More from 1 to the server's most (20), then
// Save; a lowering the server refuses is shown in its own words. Synthetic store only.
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;
let role: string;
let refusal: string | null;
let writes: ApiRequest[];

beforeEach(async () => {
  store = { id: 'store-1', vendorType: 'SERVICE', bookingCapacity: 1 };
  role = 'OWNER';
  refusal = null;
  writes = [];
  (await import('@/lib/auth')).setSelectedStore('store-1');
  mockApi((r) => {
    if (r.url.pathname === '/api/v1/vendor/profile' && r.method === 'GET') return { body: { success: true, data: { myRole: role, vendors: [store] } } };
    if (r.url.pathname === '/api/v1/vendor/profile' && r.method === 'PUT') {
      writes.push(r);
      if (refusal) return { status: 409, body: { success: false, error: { code: 'BOOKING_CAPACITY_IN_USE', message: refusal } } };
      store = { ...store, ...JSON.parse(String(r.init?.body)) };
      return { body: { success: true, data: store } };
    }
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
});

async function click(name: string) {
  const button = await screen.findByRole('button', { name });
  await act(async () => { fireEvent.click(button); });
}

/** The card has loaded the store's own number when its sentence names it: until then the counter still holds its
 *  first-render default (1) and a click lands on that, not on the store's setting. Wait for it before any click. */
async function loaded(sentence: string) { expect(await screen.findByText(sentence)).toBeTruthy(); }

describe('[BOOK-S5b] How many bookings at once', () => {
  it('one by default, More then Save sends the number, and the words follow it', async () => {
    renderWithQuery(<BookingCapacityCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'How many bookings at once' })).toBeTruthy();
    await loaded('One booking at a time across all your services. Choose more if several people or chairs serve customers at the same time.');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await click('More');
    await click('More');
    expect(screen.getByText('Up to 3 bookings at the same time, across all your services.')).toBeTruthy();
    await click('Save');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ bookingCapacity: 3 });
  });

  it('stays within 1 to 20, the server’s most', async () => {
    store = { ...store, bookingCapacity: 20 };
    renderWithQuery(<BookingCapacityCard storeId="store-1" />);
    await screen.findByRole('heading', { name: 'How many bookings at once' });
    await loaded('Up to 20 bookings at the same time, across all your services.');
    expect((screen.getByRole('button', { name: 'More' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a lowering the server refuses is shown in its own words', async () => {
    store = { ...store, bookingCapacity: 3 };
    refusal = 'You already have 3 bookings at the same time on Fri 30 Oct. Move or cancel one first.';
    renderWithQuery(<BookingCapacityCard storeId="store-1" />);
    await screen.findByRole('heading', { name: 'How many bookings at once' });
    await loaded('Up to 3 bookings at the same time, across all your services.');
    await click('Fewer');
    await loaded('Up to 2 bookings at the same time, across all your services.');
    await click('Save');
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
  });

  it('not shown to staff, to a store that is not a Services business, or when the server sends no setting', async () => {
    for (const [nextRole, nextStore] of [
      ['STAFF', store],
      ['OWNER', { ...store, vendorType: 'RESTAURANT' }],
      ['OWNER', { id: 'store-1', vendorType: 'SERVICE' }],
    ] as const) {
      role = nextRole;
      store = nextStore;
      const { unmount } = renderWithQuery(<BookingCapacityCard storeId="store-1" />);
      await waitFor(() => expect(screen.queryByText('Loading')).toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('heading', { name: 'How many bookings at once' })).toBeNull();
      unmount();
    }
  });

  it('the Settings page shows the card', () => {
    const page = readFileSync(join(process.cwd(), 'src/app/dashboard/settings/page.tsx'), 'utf8');
    expect(page).toMatch(/<BookingCapacityCard storeId=\{storeId\} \/>/);
  });
});
