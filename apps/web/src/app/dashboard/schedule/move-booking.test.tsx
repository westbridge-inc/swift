import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import SchedulePage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { addAppointmentDays, appointmentDayKey, formatAppointmentDay } from '@/lib/appointmentTime';

// ---------------------------------------------------------------------------
// [BOOK-S5b · owner B2, copies #2196 MoveBookingSheet] "Move" on the web Schedule: only on a live booking (reserved
// or confirmed) that has not started and whose listing the server named; the free times are the server's own (the
// customer's slots read), the booked time left out; the move is the existing business route; a refusal is the
// server's words and the time is let go; a failed read of the times is an error with a retry. Synthetic people only.
// ---------------------------------------------------------------------------

const today = appointmentDayKey(new Date());
const tomorrow = addAppointmentDays(today, 1);
const at = (day: string, utc: string) => `${day}T${utc}:00.000Z`;
const BOOKED = at(tomorrow, '14:00'); // 10:00 Guyana
const FREE = at(tomorrow, '15:00'); // 11:00 Guyana

let bookings: unknown[];
let slotsFail: boolean;
let moveRefusal: string | null;
let writes: ApiRequest[];
let slotReads: string[];

beforeEach(async () => {
  bookings = [
    { id: 'b1', serviceName: 'Fixture trim', price: 2500, slotStart: BOOKED, slotEnd: at(tomorrow, '14:30'), status: 'CONFIRMED', orderId: 'o1', customer: { firstName: 'Sam' }, itemId: 'i9' },
    { id: 'b2', serviceName: 'Fixture shave', price: 1500, slotStart: at(tomorrow, '16:00'), slotEnd: at(tomorrow, '16:20'), status: 'COMPLETED', orderId: 'o2', customer: null, itemId: 'i8' },
    { id: 'b3', serviceName: 'Fixture wash', price: 1000, slotStart: at(tomorrow, '17:00'), slotEnd: at(tomorrow, '17:20'), status: 'RESERVED', orderId: 'o3', customer: null },
  ];
  slotsFail = false;
  moveRefusal = null;
  writes = [];
  slotReads = [];
  (await import('@/lib/auth')).setSelectedStore('store-1');
  mockApi((r) => {
    const path = r.url.pathname.replace('/api/v1', '');
    if (r.method !== 'GET') writes.push(r);
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Fixture Studio', vendorType: 'SERVICE', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
    if (path === '/vendor/bookings') return { body: { success: true, data: bookings } };
    if (path === '/vendor/bookings/exceptions') return { body: { success: true, data: [] } };
    if (path === '/vendor/categories') return { body: { success: true, data: [] } };
    if (path === '/customer/items/i9/slots') {
      slotReads.push(r.url.searchParams.get('date') ?? '');
      if (slotsFail) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      const date = r.url.searchParams.get('date');
      return { body: { success: true, data: { date, slots: date === tomorrow ? [BOOKED, FREE] : [], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6] } } };
    }
    if (path === '/vendor/bookings/b1/reschedule' && r.method === 'POST') {
      if (moveRefusal) return { status: 409, body: { success: false, error: { code: 'SLOT_TAKEN', message: moveRefusal } } };
      return { body: { success: true, data: { id: 'b1-moved', slotStart: FREE } } };
    }
    return { status: 404, body: { success: false } };
  });
});

async function click(el: HTMLElement) { await act(async () => { fireEvent.click(el); }); }
async function openTomorrow() {
  renderWithQuery(<SchedulePage />);
  await click(await screen.findByRole('button', { name: formatAppointmentDay(tomorrow) }));
  await screen.findByText('Fixture trim');
}

describe('[BOOK-S5b] Move a booking from the web Schedule', () => {
  it('Move only on a live, future booking whose listing the server named', async () => {
    await openTomorrow();
    expect(screen.getByRole('button', { name: /^Move Fixture trim at / })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Move Fixture shave/ })).toBeNull(); // completed
    expect(screen.queryByRole('button', { name: /^Move Fixture wash/ })).toBeNull(); // no listing named
  });

  it('moves to another free time of the same service, the booked one never offered', async () => {
    await openTomorrow();
    await click(screen.getByRole('button', { name: /^Move Fixture trim at / }));
    const dialog = await screen.findByRole('dialog', { name: 'Move this booking' });
    expect(within(dialog).getByText(/The customer is told the new time\./)).toBeTruthy();
    await click(within(dialog).getByRole('button', { name: formatAppointmentDay(tomorrow) }));
    const times = await within(dialog).findByRole('group', { name: 'Free times' });
    expect(within(times).getAllByRole('button').map((b) => b.textContent?.replace(/\s/g, ' '))).toEqual(['11:00 AM']);
    await click(within(times).getByRole('button', { name: /11:00/ }));
    await click(within(dialog).getByRole('button', { name: /^Move to / }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ newSlotStart: FREE });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move this booking' })).toBeNull());
    expect(slotReads).toContain(tomorrow);
  });

  it('a refused move is shown in the server’s words and the time is let go', async () => {
    moveRefusal = 'That slot was just taken — pick another time';
    await openTomorrow();
    await click(screen.getByRole('button', { name: /^Move Fixture trim at / }));
    const dialog = await screen.findByRole('dialog', { name: 'Move this booking' });
    await click(within(dialog).getByRole('button', { name: formatAppointmentDay(tomorrow) }));
    await click(await within(dialog).findByRole('button', { name: /11:00/ }));
    await click(within(dialog).getByRole('button', { name: /^Move to / }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(moveRefusal);
    expect((within(dialog).getByRole('button', { name: 'Pick a new time' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed read of the free times is an error with a retry, never “no times”', async () => {
    slotsFail = true;
    await openTomorrow();
    await click(screen.getByRole('button', { name: /^Move Fixture trim at / }));
    const dialog = await screen.findByRole('dialog', { name: 'Move this booking' });
    expect(await within(dialog).findByText('Couldn’t load the free times. Check your connection and try again.')).toBeTruthy();
    expect(within(dialog).queryByText(/No other free times/)).toBeNull();
    slotsFail = false;
    await click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('No other free times this day — try another.')).toBeTruthy();
  });
});
