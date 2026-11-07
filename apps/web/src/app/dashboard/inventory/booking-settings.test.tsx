import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import InventoryPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [BOOK-S5b · owner A4/C1/C2, copies #2196] The web Products editor for a bookable service, as the partner app's:
// hours per day with more than one window a day (a break is the gap between two), EVERY stored window kept (the old
// editor put the first window's times on every chosen day: per-day hours were lost on the next web save), plain-word
// hour problems before the save, the gap and the minimum notice, and "Confirm bookings automatically" only while the
// server's profile says it can be chosen. Synthetic store and listing only.
// ---------------------------------------------------------------------------

const STORED = {
  durationMinutes: 30,
  slots: [
    { dayOfWeek: 1, start: '09:00', end: '12:00' },
    { dayOfWeek: 1, start: '13:00', end: '17:00' },
    { dayOfWeek: 2, start: '10:00', end: '14:00' },
  ],
  serviceMode: 'AT_BUSINESS',
  bufferMinutes: 7,
  minNoticeMinutes: 120,
  instantBooking: false,
};

let instantAvailable: boolean;
let writes: ApiRequest[];
const body = (r: ApiRequest) => JSON.parse(String(r.init?.body));

beforeEach(() => {
  instantAvailable = false;
  writes = [];
  mockApi((r) => {
    const path = r.url.pathname;
    if (r.method !== 'GET') writes.push(r);
    if (path === '/api/v1/vendor/items' && r.method === 'GET') {
      return { body: { data: [{ id: 'trim', name: 'Fixture trim', basePrice: '2500.00', categoryId: 'cuts', category: { id: 'cuts', name: 'Cuts' }, isAvailable: true, stockQuantity: null, fulfillment: 'APPOINTMENT', bookingConfig: STORED, optionGroups: [] }] } };
    }
    if (path === '/api/v1/vendor/categories' && r.method === 'GET') return { body: { data: [{ id: 'cuts', name: 'Cuts' }] } };
    if (path === '/api/v1/vendor/stores') return { body: { data: { stores: [{ id: 'store-1', name: 'Fixture Studio', vendorType: 'SERVICE', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
    if (path === '/api/v1/vendor/profile') {
      return { body: { data: { myRole: 'OWNER', vendors: [{ id: 'store-1', vendorType: 'SERVICE', bookingCapacity: 1, ...(instantAvailable ? { instantBookingAvailable: true } : {}) }] } } };
    }
    if (path === '/api/v1/vendor/store-vat') return { body: { data: { status: 'NONE' } } };
    const one = path.match(/^\/api\/v1\/vendor\/items\/([^/]+)$/);
    if (one && r.method === 'PUT') return { body: { data: { id: one[1], name: 'Fixture trim', basePrice: '2500.00', categoryId: 'cuts', ...body(r) } } };
    if (path === '/api/v1/vendor/items' && r.method === 'POST') return { body: { data: { id: 'new-1', ...body(r), basePrice: String(body(r).basePrice) } } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
});

async function click(el: HTMLElement) { await act(async () => { fireEvent.click(el); }); }
async function setValue(el: HTMLElement, value: string) { await act(async () => { fireEvent.change(el, { target: { value } }); }); }
async function openTrim() {
  renderWithQuery(<InventoryPage />);
  const row = await screen.findByRole('article', { name: 'Fixture trim' });
  await click(await within(row).findByRole('button', { name: 'Edit item' }));
  return screen.findByRole('dialog');
}
const saved = () => body(writes.find((w) => w.method === 'PUT' || w.method === 'POST')!);

describe('[BOOK-S5b] a bookable service’s hours, gap, notice and confirm-automatically on the web', () => {
  it('an unchanged save keeps every stored window: Monday’s break and Tuesday’s own hours are not flattened', async () => {
    const editor = await openTrim();
    expect(within(editor).getByText('Hours each day')).toBeTruthy();
    expect((within(editor).getByLabelText('Mon opens at (2)') as HTMLInputElement).value).toBe('13:00');
    expect((within(editor).getByLabelText('Tue opens at') as HTMLInputElement).value).toBe('10:00');
    await click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().bookingConfig.slots).toEqual(STORED.slots);
    expect(saved().bookingConfig).toMatchObject({ bufferMinutes: 7, minNoticeMinutes: 120 });
    // Switch off: the editor never names "confirm automatically", so the listing keeps what it stores.
    expect(saved().bookingConfig).not.toHaveProperty('instantBooking');
    expect(within(editor).queryByRole('switch', { name: 'Confirm bookings automatically' })).toBeNull();
  });

  it('a closed day opens with hours, and "Add hours" adds a second window after a break', async () => {
    const editor = await openTrim();
    await click(within(editor).getByRole('button', { name: 'Wed · closed' }));
    await click(within(editor).getByRole('button', { name: 'Add hours on Wed' }));
    await click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().bookingConfig.slots.filter((s: { dayOfWeek: number }) => s.dayOfWeek === 3)).toEqual([
      { dayOfWeek: 3, start: '09:00', end: '17:00' }, { dayOfWeek: 3, start: '18:00', end: '20:00' },
    ]);
  });

  it('overlapping windows on one day are refused in plain words before anything is sent', async () => {
    const editor = await openTrim();
    await setValue(within(editor).getByLabelText('Mon opens at (2)'), '11:00');
    expect(within(editor).getByRole('alert').textContent).toBe('On Monday, 09:00–12:00 and 11:00–17:00 overlap. Join them into one, or change one.');
    const fix = within(editor).getByRole('button', { name: 'Fix the hours' }) as HTMLButtonElement;
    expect(fix.disabled).toBe(true);
    await click(fix);
    expect(writes).toHaveLength(0);
  });

  it('the gap and the notice: a stored odd value is shown as its own chip, and a new choice is what is sent', async () => {
    const editor = await openTrim();
    const gap = within(editor).getByRole('group', { name: 'Gap after each booking' });
    expect(within(gap).getByRole('button', { name: '7 min' }).getAttribute('aria-pressed')).toBe('true');
    await click(within(gap).getByRole('button', { name: '15 min' }));
    // [REVIEW-F S4-1 on #2203] The phone's caption (#2201).
    expect(within(editor).getByText('How close to its start a customer can still book a time.')).toBeTruthy();
    const notice = within(editor).getByRole('group', { name: 'Minimum notice' });
    expect(within(notice).getByRole('button', { name: '2 hours' }).getAttribute('aria-pressed')).toBe('true');
    await click(within(notice).getByRole('button', { name: '1 day' }));
    await click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().bookingConfig).toMatchObject({ bufferMinutes: 15, minNoticeMinutes: 1440 });
  });

  it('switch on: "Confirm bookings automatically" shows the stored setting, says its rule, and is sent', async () => {
    instantAvailable = true;
    const editor = await openTrim();
    const toggle = await within(editor).findByRole('switch', { name: 'Confirm bookings automatically' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(within(editor).getByText('Every booking waits for you to accept it.')).toBeTruthy();
    await click(toggle);
    expect(within(editor).getByText('Bookings paid in cash at the appointment are confirmed as soon as the customer books. MMG bookings still wait for you to accept.')).toBeTruthy();
    await click(within(editor).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().bookingConfig.instantBooking).toBe(true);
  });

  it('a new bookable service opens confirmed automatically with 2 hours’ notice while it can be chosen, and as today otherwise', async () => {
    instantAvailable = true;
    const { unmount } = renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Fixture trim' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    let editor = await screen.findByRole('dialog');
    expect((await within(editor).findByRole('switch', { name: 'Confirm bookings automatically' })).getAttribute('aria-checked')).toBe('true');
    expect(within(within(editor).getByRole('group', { name: 'Minimum notice' })).getByRole('button', { name: '2 hours' }).getAttribute('aria-pressed')).toBe('true');
    unmount();
    instantAvailable = false;
    renderWithQuery(<InventoryPage />);
    await screen.findByRole('article', { name: 'Fixture trim' });
    await click(await screen.findByRole('button', { name: '+ Add item' }));
    editor = await screen.findByRole('dialog');
    expect(within(editor).queryByRole('switch', { name: 'Confirm bookings automatically' })).toBeNull();
    expect(within(within(editor).getByRole('group', { name: 'Minimum notice' })).getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('true');
  });
});
