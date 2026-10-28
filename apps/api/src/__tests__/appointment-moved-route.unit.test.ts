import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appointmentMovedData, appointmentMovedDedupeKey } from '../modules/booking/appointment-moved';

// ---------------------------------------------------------------------------
// [BOOK-FU2 · the #2188 family] A STORE appointment's move notice. It was sent as booking_rescheduled, and the
// phone builds in the stores route the booking_ family to ServiceJobs (the marketplace jobs list) unless a case
// names the kind. Its own kind keeps it out of that family; the booking's order lets every released router open
// the booking itself (customer: its order screen; business: that order on the order desk). The routes are
// proved on real Postgres in scheduling-reschedule.test.ts and appointment-times-journey.test.ts; the released
// routers were replayed outside the repo.
// ---------------------------------------------------------------------------

describe('[BOOK-FU2] the appointment-moved notice payload', () => {
  it('names the moved booking and its order, outside the booking_ family', () => {
    const data = appointmentMovedData({ id: 'bk-new', orderId: 'o1' });
    expect(data).toEqual({ kind: 'appointment_moved', bookingId: 'bk-new', orderId: 'o1' });
    expect(data.kind.startsWith('booking_')).toBe(false);
  });

  it('never invents an order: a booking with none carries no orderId', () => {
    expect(appointmentMovedData({ id: 'bk-new', orderId: null })).toEqual({ kind: 'appointment_moved', bookingId: 'bk-new' });
  });

  it('carries no audience of its own: each route tags its copy (NotificationService merges it)', () => {
    expect(appointmentMovedData({ id: 'bk-new', orderId: 'o1' })).not.toHaveProperty('audience');
  });

  it('is deduplicated per move: the key names the new booking row a move writes', () => {
    expect(appointmentMovedDedupeKey('bk-new')).toBe('appointment-moved:bk-new');
    expect(appointmentMovedDedupeKey('bk-a')).not.toBe(appointmentMovedDedupeKey('bk-b'));
  });

  it('both reschedule routes send it, and nothing in the API sends booking_rescheduled any more', () => {
    const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
    for (const rel of ['modules/user/customer.routes.ts', 'modules/vendor/vendor.routes.ts']) {
      const text = src(rel);
      expect(text, rel).toContain('dedupeKey: appointmentMovedDedupeKey(result.booking.id),');
      expect(text, rel).toContain('data: appointmentMovedData(result.booking),');
      expect(text, rel).not.toContain("kind: 'booking_rescheduled'");
    }
  });
});
