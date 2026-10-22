import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import SchedulePage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { addAppointmentDays, appointmentDayKey, formatAppointmentDay } from '@/lib/appointmentTime';

// ---------------------------------------------------------------------------
// The app's Schedule tab for a Services store
// (apps/mobile/src/modules/vendor/screens/VendorScheduleScreen.tsx): a 7-day
// strip, the chosen day's blocked time (one tap to unblock) and appointments,
// and "Block time" (all day or a window). Owners and managers only, as in the
// app (VendorStack: isService && manager). Every read and write is an endpoint
// the app already uses: GET /vendor/bookings, GET/POST/DELETE
// /vendor/bookings/exceptions.
// ---------------------------------------------------------------------------

type Role = 'OWNER' | 'MANAGER' | 'STAFF';
interface Opts { role?: Role; vendorType?: string; failStores?: boolean; failBookings?: boolean; failBlocks?: boolean; failDelete?: boolean }

const today = appointmentDayKey(new Date());
const tomorrow = addAppointmentDays(today, 1);
// Noon in Guyana (UTC-4) sits inside the same market day whatever the test machine's zone.
const at = (day: string, utc: string) => `${day}T${utc}:00.000Z`;

const writes: Array<{ method: string; path: string; body: unknown }> = [];
const reads: string[] = [];

function scheduleApi(opts: Opts = {}) {
  const { role = 'OWNER', vendorType = 'SERVICE' } = opts;
  return mockApi((request: ApiRequest) => {
    const { method, url, init } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (opts.failDelete && method === 'DELETE') return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: {} } };
    }
    reads.push(path);
    if (path === '/vendor/stores') {
      if (opts.failStores) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: {
        stores: [{ id: 'store-1', name: 'Sample Salon', vendorType, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }],
        selectedId: 'store-1', myRole: role,
      } } };
    }
    if (path === '/vendor/bookings') {
      if (opts.failBookings) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: [
        { id: 'b1', serviceName: 'Haircut', price: 2500, slotStart: at(today, '14:00'), slotEnd: at(today, '14:30'), status: 'CONFIRMED', orderId: 'o1', customer: { firstName: 'Asha' } },
        { id: 'b2', serviceName: 'Beard trim', price: 1500, slotStart: at(tomorrow, '15:00'), slotEnd: at(tomorrow, '15:20'), status: 'RESERVED', orderId: null, customer: null },
      ] } };
    }
    if (path === '/vendor/bookings/exceptions') {
      if (opts.failBlocks) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: [
        { id: 'x1', itemId: null, date: `${today}T00:00:00.000Z`, start: '13:00', end: '17:00', reason: 'Family visit' },
        { id: 'x2', itemId: null, date: `${tomorrow}T00:00:00.000Z`, start: null, end: null, reason: null },
      ] } };
    }
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  reads.length = 0;
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('the Schedule tab copies the app', () => {
  it('shows the chosen day only: today first, then tomorrow from the strip', async () => {
    scheduleApi();
    renderWithQuery(<SchedulePage />);
    const appointments = await screen.findByRole('list', { name: 'Appointments' });
    expect(within(appointments).getByText('Haircut')).toBeTruthy();
    expect(within(appointments).getByText(/Asha · \$2,500/)).toBeTruthy();
    expect(within(appointments).getByText('Confirmed')).toBeTruthy();
    expect(screen.queryByText('Beard trim')).toBeNull();
    const blocked = screen.getByRole('list', { name: 'Blocked time' });
    expect(within(blocked).getByText('Blocked · 13:00–17:00')).toBeTruthy();
    expect(within(blocked).getByText('Family visit')).toBeTruthy();

    const strip = screen.getByRole('group', { name: 'Day' });
    const chips = within(strip).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['Today', ...[1, 2, 3, 4, 5, 6].map((i) => formatAppointmentDay(addAppointmentDays(today, i)))]);
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(chips[1]!);
    expect(chips[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText('Beard trim')).toBeTruthy();
    expect(screen.getByText(/^Customer · \$1,500$/)).toBeTruthy();
    expect(screen.getByText('Reserved')).toBeTruthy();
    expect(screen.getByText('Blocked · all day')).toBeTruthy();
    expect(screen.queryByText('Haircut')).toBeNull();
    expect(screen.queryByText('Blocked · 13:00–17:00')).toBeNull();
  });

  it('a day with nothing on it says so, in the app\'s words', async () => {
    scheduleApi();
    renderWithQuery(<SchedulePage />);
    await screen.findByText('Haircut');
    fireEvent.click(within(screen.getByRole('group', { name: 'Day' })).getAllByRole('button')[2]!);
    expect(await screen.findByText('No bookings this day')).toBeTruthy();
    expect(screen.getByText('Your open hours are visible to customers — reservations land here.')).toBeTruthy();
  });

  it('blocks the whole chosen day: the date only, no window', async () => {
    scheduleApi();
    renderWithQuery(<SchedulePage />);
    await screen.findByText('Haircut');
    fireEvent.click(within(screen.getByRole('group', { name: 'Day' })).getAllByRole('button')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Block time' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block time' });
    expect(within(dialog).getByRole('switch', { name: 'All day' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block time' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/vendor/bookings/exceptions', body: { date: tomorrow } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('blocks a window with a note, and refuses times that are out of order', async () => {
    scheduleApi();
    renderWithQuery(<SchedulePage />);
    await screen.findByText('Haircut');
    fireEvent.click(screen.getByRole('button', { name: 'Block time' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block time' });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'All day' }));
    const from = within(dialog).getByLabelText('From');
    const until = within(dialog).getByLabelText('Until');
    fireEvent.change(from, { target: { value: '15:00' } });
    fireEvent.change(until, { target: { value: '14:00' } });
    // [#947's grammar] Disabled says the ask.
    const refused = within(dialog).getByRole('button', { name: 'Times must be HH:MM, start before end' });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(until, { target: { value: '16:30' } });
    fireEvent.change(within(dialog).getByLabelText('Note (only you see this)'), { target: { value: '  Funeral  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block time' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/vendor/bookings/exceptions', body: { date: today, start: '15:00', end: '16:30', reason: 'Funeral' } }]));
  });

  it('unblocks with one tap, through the app\'s endpoint', async () => {
    scheduleApi();
    renderWithQuery(<SchedulePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove block, 13:00–17:00' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'DELETE', path: '/vendor/bookings/exceptions/x1', body: null }]));
  });

  it('an unblock the server refused says so on the page', async () => {
    scheduleApi({ failDelete: true });
    renderWithQuery(<SchedulePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove block, 13:00–17:00' }));
    expect(await screen.findByText(/Service unavailable/)).toBeTruthy();
    expect(screen.getByText('Blocked · 13:00–17:00')).toBeTruthy();
  });
});

describe('the Schedule never reads a failed read as an empty day', () => {
  it('the appointments read failed: says it could not check, never "No bookings"', async () => {
    scheduleApi({ failBookings: true });
    renderWithQuery(<SchedulePage />);
    expect(await screen.findByText('Couldn\'t load your schedule.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('No bookings this day')).toBeNull();
  });

  it('the blocked-time read failed: says it could not check, never "No bookings"', async () => {
    scheduleApi({ failBlocks: true });
    renderWithQuery(<SchedulePage />);
    expect(await screen.findByText('Couldn\'t load your blocked time.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText('No bookings this day')).toBeNull();
    expect(screen.queryByText('Haircut')).toBeNull();
  });
});

describe('the Schedule never reads a failed store read as "loading" or an empty day', () => {
  it('the store read failed: says it could not check, reads no bookings, offers nothing', async () => {
    scheduleApi({ failStores: true });
    renderWithQuery(<SchedulePage />);
    expect(await screen.findByText('Couldn\'t load your store.', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/Loading your schedule/)).toBeNull();
    expect(screen.queryByText('No bookings this day')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Block time' })).toBeNull();
    expect(reads.filter((p) => p.startsWith('/vendor/bookings'))).toEqual([]);
  });
});

describe('the Schedule is for a Services store\'s owners and managers, as in the app', () => {
  it('a manager of a Services store reads the bookings and the blocked time', async () => {
    scheduleApi({ role: 'MANAGER' });
    renderWithQuery(<SchedulePage />);
    await screen.findByText('Haircut');
    expect(reads).toContain('/vendor/bookings');
    expect(reads).toContain('/vendor/bookings/exceptions');
  });

  it('a staff login is told who the schedule is for, and nothing is read or offered', async () => {
    scheduleApi({ role: 'STAFF' });
    renderWithQuery(<SchedulePage />);
    expect(await screen.findByText('The schedule is for the store\'s owner and managers.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Block time' })).toBeNull();
    expect(reads.filter((p) => p.startsWith('/vendor/bookings'))).toEqual([]);
  });

  it('a store that is not a Services store is sent to its opening hours, and nothing is read', async () => {
    scheduleApi({ vendorType: 'RESTAURANT' });
    renderWithQuery(<SchedulePage />);
    expect(await screen.findByText(/The schedule is for Services stores/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/dashboard/settings');
    expect(screen.queryByRole('button', { name: 'Block time' })).toBeNull();
    expect(reads.filter((p) => p.startsWith('/vendor/bookings'))).toEqual([]);
  });
});
