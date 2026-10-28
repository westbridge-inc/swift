import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderDetailPage from './page';
import * as orders from '@/lib/customer-orders';
import * as customer from '@/lib/customer';
import * as rides from '@/lib/customer-rides';
import { ApiRequestError } from '@/lib/auth';
import { addAppointmentDays, appointmentDayKey } from '@/lib/appointmentTime';

// ---------------------------------------------------------------------------
// [BOOK-S6b · owner B2] The booking's order page shows the move and cancel
// rules the SERVER projected: "Change time" only when appointmentBooking says
// a move is allowed now (the times are the server's own free times of the same
// service, the booked one left out), its reason when it says no, nothing when
// it sends nothing (switch off, an older server). Synthetic people only.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'order-9' }) }));

const TOMORROW = addAppointmentDays(appointmentDayKey(new Date()), 1);
const BOOKED = `${TOMORROW}T14:00:00.000Z`; // 10:00 Guyana
const FREE = `${TOMORROW}T15:00:00.000Z`; // 11:00 Guyana

const ORDER = {
  id: 'order-9', orderNumber: 'SW-9001', status: 'ACCEPTED', fulfillment: 'APPOINTMENT', orderType: 'SERVICE',
  paymentMethod: 'CASH', paymentStatus: 'PENDING', totalAmount: 2500, subtotalCustomer: 2500,
  items: [{ id: 'l9', name: 'Fixture trim', quantity: 1, customerPrice: 2500, lineTotal: 2500 }],
  statusHistory: [], vendor: { id: 'v1', name: 'Fixture Studio' }, appointmentSlot: BOOKED, canCancel: false,
};
const withBooking = (reschedule: { allowed: boolean; message: string | null }) => ({
  ...ORDER, appointmentBooking: { id: 'b1', itemId: 'i9', slotStart: BOOKED, reschedule },
});

beforeEach(() => {
  vi.spyOn(rides, 'rideCapabilities').mockResolvedValue({ maxStops: 0 });
  vi.spyOn(customer, 'getItemSlots').mockImplementation(async (_itemId, date) => ({
    date, durationMinutes: 30, slots: date === TOMORROW ? [BOOKED, FREE] : [], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6], serviceMode: 'AT_BUSINESS',
  }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('[BOOK-S6b] Change time on a booking', () => {
  it('moves the booking to another free time of the same service, never offering the booked one', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(withBooking({ allowed: true, message: null }) as never);
    const move = vi.spyOn(orders, 'rescheduleBooking').mockResolvedValue({ id: 'b2' } as never);
    render(<OrderDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change time' }));
    expect(screen.getByText('Pick another free time for the same service. Your current time stays booked until the move goes through.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow' }));
    expect(await screen.findByRole('button', { name: /11:00\sAM/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^10:00\sAM$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /11:00\sAM/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Move to / }));
    await waitFor(() => expect(move).toHaveBeenCalledWith('b1', FREE));
    expect(customer.getItemSlots).toHaveBeenCalledWith('i9', TOMORROW);
  });

  it('a refused move is shown in the server’s words (the two-hour cut-off, a taken time)', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(withBooking({ allowed: true, message: null }) as never);
    vi.spyOn(orders, 'rescheduleBooking').mockRejectedValue(new ApiRequestError('That slot was just taken — pick another time', 409, 'SLOT_TAKEN'));
    render(<OrderDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change time' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(await screen.findByRole('button', { name: /11:00\sAM/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Move to / }));
    expect(await screen.findByText('That slot was just taken — pick another time')).toBeTruthy();
  });

  it('when the server says no, its reason is shown and there is no Change time', async () => {
    const message = 'Times can be changed in the app until 2 hours before the start. Contact the business to change it now.';
    vi.spyOn(orders, 'getOrder').mockResolvedValue(withBooking({ allowed: false, message }) as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change time' })).toBeNull();
  });

  it('switch off (no appointmentBooking): no Change time and no move words at all', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, cancelUnavailable: { code: 'APPOINTMENT_CANCEL_WINDOW', message: 'Contact the business to cancel this booking.', contactPhone: null },
    } as never);
    render(<OrderDetailPage />);
    // The cancel rule is still the server's own words.
    expect(await screen.findByText('Contact the business to cancel this booking.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change time' })).toBeNull();
    expect(screen.queryByText(/Pick another free time/)).toBeNull();
  });
});
