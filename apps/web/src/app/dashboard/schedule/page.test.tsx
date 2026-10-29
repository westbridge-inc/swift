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
interface Opts {
  role?: Role; vendorType?: string; failStores?: boolean; failBookings?: boolean; failBlocks?: boolean; failDelete?: boolean;
  // [UI-SWEEP, REVIEW-F #2013 S4-1/S4-2/S4-4/S4-5]
  failCreate?: boolean; holdStores?: Promise<void>; bookingsData?: unknown[]; blocksData?: unknown[]; menu?: unknown[] | 'fail';
  // [size budget] The unblock's own states: hold the DELETE, and answer each one in turn.
  holdDelete?: Promise<void>; deleteResults?: Array<'fail' | 'ok'>;
}

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
      if (method === 'DELETE' && (opts.holdDelete || opts.deleteResults)) {
        const result = opts.deleteResults?.shift() ?? 'ok';
        const answer = result === 'fail' ? { status: 503, body: { success: false, error: { message: 'Service unavailable' } } } : { body: { success: true, data: {} } };
        return (opts.holdDelete ?? Promise.resolve()).then(() => answer);
      }
      if (opts.failCreate && method === 'POST') return { status: 409, body: { success: false, error: { message: 'That time overlaps a booking.' } } };
      return { body: { success: true, data: {} } };
    }
    reads.push(path);
    if (path === '/vendor/stores') {
      if (opts.holdStores) return opts.holdStores.then(() => ({ status: 503, body: { success: false } }));
      if (opts.failStores) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: {
        stores: [{ id: 'store-1', name: 'Sample Salon', vendorType, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }],
        selectedId: 'store-1', myRole: role,
      } } };
    }
    if (path === '/vendor/bookings') {
      if (opts.failBookings) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      if (opts.bookingsData) return { body: { success: true, data: opts.bookingsData } };
      return { body: { success: true, data: [
        { id: 'b1', serviceName: 'Haircut', price: 2500, slotStart: at(today, '14:00'), slotEnd: at(today, '14:30'), status: 'CONFIRMED', orderId: 'o1', customer: { firstName: 'Asha' } },
        { id: 'b2', serviceName: 'Beard trim', price: 1500, slotStart: at(tomorrow, '15:00'), slotEnd: at(tomorrow, '15:20'), status: 'RESERVED', orderId: null, customer: null },
      ] } };
    }
    if (path === '/vendor/bookings/exceptions') {
      if (opts.failBlocks) return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      if (opts.blocksData) return { body: { success: true, data: opts.blocksData } };
      return { body: { success: true, data: [
        { id: 'x1', itemId: null, date: `${today}T00:00:00.000Z`, start: '13:00', end: '17:00', reason: 'Family visit' },
        { id: 'x2', itemId: null, date: `${tomorrow}T00:00:00.000Z`, start: null, end: null, reason: null },
      ] } };
    }
    if (path === '/vendor/categories' && opts.menu) {
      if (opts.menu === 'fail') return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } };
      return { body: { success: true, data: opts.menu } };
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

// [size budget] The unblock is a plain call now (react-query's mutation code stays out of
// this tab's first load), so its states are pinned here: nothing else covered them.
describe('an unblock on its way, refused, then tried again', () => {
  it('every remove button waits while it is sent; a refusal shows and re-enables them; the next try clears it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    scheduleApi({ holdDelete: held, deleteResults: ['fail', 'ok'] });
    renderWithQuery(<SchedulePage />);
    const remove = await screen.findByRole('button', { name: 'Remove block, 13:00–17:00' }) as HTMLButtonElement;
    fireEvent.click(remove);
    await waitFor(() => expect(remove.disabled).toBe(true));
    fireEvent.click(remove);
    release();
    expect(await screen.findByText(/Service unavailable/)).toBeTruthy();
    await waitFor(() => expect(remove.disabled).toBe(false));
    expect(writes.filter((w) => w.method === 'DELETE')).toHaveLength(1);
    const blockReads = reads.filter((r) => r === '/vendor/bookings/exceptions').length;
    fireEvent.click(remove);
    await waitFor(() => expect(writes.filter((w) => w.method === 'DELETE')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/Service unavailable/)).toBeNull());
    // A removal that went through reads the blocked time again.
    await waitFor(() => expect(reads.filter((r) => r === '/vendor/bookings/exceptions').length).toBeGreaterThan(blockReads));
    await waitFor(() => expect(remove.disabled).toBe(false));
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

// ---------------------------------------------------------------------------
// [UI-SWEEP, REVIEW-F #2013 S4-1/S4-2, both apps; phone twin in the app's
// VendorScheduleScreen] The Schedule's words are true:
//   - GET /vendor/bookings drops only CANCELLED, so a COMPLETED appointment is
//     served, and it read 'Reserved' (every status but CONFIRMED did);
//   - a block on ONE listing (itemId) read 'Blocked · all day', as if the whole
//     store were closed; it names the listing (the store's own menu), or says
//     'One listing' when the name is not known, never the whole store.
// ---------------------------------------------------------------------------
describe('the Schedule names what it shows, in the app\'s words', () => {
  const booking = (status: string) => ({
    id: `bk-${status}`, serviceName: 'Haircut', price: 2500, slotStart: at(today, '14:00'), slotEnd: at(today, '14:30'), status, orderId: null, customer: { firstName: 'Asha' },
  });
  const words = ['Reserved', 'Confirmed', 'Completed', 'Status unavailable'];
  it.each([
    ['RESERVED', 'Reserved'],
    ['CONFIRMED', 'Confirmed'],
    ['COMPLETED', 'Completed'],
    ['SOMETHING_NEWER', 'Status unavailable'],
  ])('a %s booking reads %s', async (status, word) => {
    scheduleApi({ bookingsData: [booking(status)], blocksData: [] });
    renderWithQuery(<SchedulePage />);
    const appointments = await screen.findByRole('list', { name: 'Appointments' });
    expect(within(appointments).getByText(word)).toBeTruthy();
    for (const other of words.filter((w) => w !== word)) expect(within(appointments).queryByText(other), `${status} never reads '${other}'`).toBeNull();
    expect(within(appointments).queryByText(status), 'the raw status is never shown').toBeNull();
  });

  const block = (over: Record<string, unknown>) => ({ id: 'x9', itemId: null, date: `${today}T00:00:00.000Z`, start: null, end: null, reason: null, ...over });

  it('a one-listing block names the listing, never reads as the whole store', async () => {
    scheduleApi({
      bookingsData: [], blocksData: [block({ itemId: 'it-2', start: '13:00', end: '17:00' })],
      menu: [{ id: 'c1', name: 'Cuts', items: [{ id: 'it-1', name: 'Haircut' }, { id: 'it-2', name: 'Beard trim' }] }],
    });
    renderWithQuery(<SchedulePage />);
    const blocked = await screen.findByRole('list', { name: 'Blocked time' });
    expect(await within(blocked).findByText('Beard trim blocked · 13:00–17:00')).toBeTruthy();
    expect(within(blocked).queryByText('Blocked · 13:00–17:00')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove block, Beard trim, 13:00–17:00' })).toBeTruthy();
  });

  it('a one-listing block whose name is unknown (menu failed, or the listing is gone) says "One listing"', async () => {
    scheduleApi({ bookingsData: [], blocksData: [block({ itemId: 'it-gone' })], menu: 'fail' });
    renderWithQuery(<SchedulePage />);
    const blocked = await screen.findByRole('list', { name: 'Blocked time' });
    expect(within(blocked).getByText('One listing blocked · all day')).toBeTruthy();
    expect(within(blocked).queryByText('Blocked · all day')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove block, one listing, all day' })).toBeTruthy();
  });

  it('a whole-store block still reads "Blocked · all day"', async () => {
    scheduleApi({ bookingsData: [], blocksData: [block({})], menu: [] });
    renderWithQuery(<SchedulePage />);
    const blocked = await screen.findByRole('list', { name: 'Blocked time' });
    expect(within(blocked).getByText('Blocked · all day')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove block, all day' })).toBeTruthy();
  });
});

// [UI-SWEEP, REVIEW-F #2013 S4-4] No test made Block time's POST fail.
describe('a refused block stays on screen, in the server\'s words', () => {
  it('the dialog stays open with the refusal, and Block time can be pressed again', async () => {
    scheduleApi({ failCreate: true });
    renderWithQuery(<SchedulePage />);
    await screen.findByText('Haircut');
    fireEvent.click(screen.getByRole('button', { name: 'Block time' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block time' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block time' }));
    expect(await within(dialog).findByText(/That time overlaps a booking\./)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Block time' })).toBeTruthy();
    const again = within(dialog).getByRole('button', { name: 'Block time' }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(writes.filter((w) => w.method === 'POST')).toHaveLength(1);
  });
});

// [UI-SWEEP, REVIEW-F #2013 S4-5] react-query 5: a disabled query is not
// isLoading, so while the role and store type are still being read the page
// must say it is loading, never 'No bookings this day'.
describe('while the store read is still out, the Schedule says it is loading', () => {
  it('never "No bookings this day", and nothing is read yet', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    scheduleApi({ holdStores: held });
    renderWithQuery(<SchedulePage />);
    expect(await screen.findByText(/Loading your schedule/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('No bookings this day')).toBeNull();
    expect(reads.filter((p) => p.startsWith('/vendor/bookings'))).toEqual([]);
    release();
  });
});
