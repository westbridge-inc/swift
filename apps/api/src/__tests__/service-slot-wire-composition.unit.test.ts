import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUYANA_TZ as SHARED_GUYANA_TZ } from '@swift/types';
import { GUYANA_TZ } from '../modules/prep/prep-time';
import { customerRoutes } from '../modules/user/customer.routes';
import { BookingService } from '../modules/booking/booking.service';
import { computeDaySlots, fmtSlotTime, slotFitsConfig } from '../modules/booking/availability';
import { FREE_CANCEL_WINDOW_MIN, freeCancellationExpiresAt } from '../modules/order/cancel-policy';
import { sendBookingReminders } from '../modules/services/services.service';
import { hostRoutes, orderStore, prismaDouble, recordingIo, recordingRedis } from './helpers/service-vertical-doubles';

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// THE APPOINTMENT TIME CONTRACT — one convention everywhere.
//
// A vendor's schedule is Guyana wall-clock ("09:00"). The producer resolves it
// through the platform's ONE zone authority (utils/guyana-day.ts, GUYANA_TZ)
// and emits the TRUE instant: 09:00 in Guyana is 13:00Z on the wire, 13:00Z in
// booking.slotStart and order.appointmentSlot. Validation, the cancellation
// policy and the reminder sweep compare that instant with the real clock —
// nothing converts twice — and every human-facing copy formats it in the
// market zone explicitly, never in UTC and never in the host zone. These cases
// run the real route handler, the real BookingService, the real producer, the
// real policy and the real reminder sweep against in-memory doubles; the same
// file passes under TZ=UTC, TZ=America/Guyana and TZ=Asia/Tokyo.
// ---------------------------------------------------------------------------

const source = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('one market zone, declared once', () => {
  it('the API resolves through the same zone the phone and the site format in', () => {
    expect(GUYANA_TZ).toBe('America/Guyana');
    expect(SHARED_GUYANA_TZ).toBe(GUYANA_TZ);
  });

  it('the cancellation policy reads the stored instant directly — the face compensation is gone', () => {
    const policy = source('modules/order/cancel-policy.ts');
    expect(policy).not.toMatch(/slotInstant|instantOfGuyanaWallClock|booking\/availability/);
    expect(source('modules/booking/availability.ts')).not.toMatch(/export function slotInstant/);
  });

  it('every server copy that names an appointment time formats in the market zone', () => {
    for (const rel of ['modules/services/services.service.ts', 'modules/services/services.routes.ts', 'modules/booking/availability.ts']) {
      const text = source(rel);
      expect(text, rel).toMatch(/formatGuyanaTime\(/);
      expect(text, rel).not.toMatch(/toLocaleString\(|toLocaleTimeString\(|toLocaleDateString\(/);
    }
  });
});

describe('09:00 Guyana appointment slot across the API wire', () => {
  it('sends the real 13:00Z instant to a client, rather than a UTC-face value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T14:00:00.000Z'));

    const prisma = prismaDouble(orderStore([]), {
      item: {
        findUnique: async () => ({
          id: 'item-haircut', vendorId: 'vendor-svc', fulfillment: 'APPOINTMENT', isAvailable: true,
          bookingConfig: {
            durationMinutes: 30,
            slots: [{ dayOfWeek: 4, start: '09:00', end: '09:30' }],
          },
        }),
      },
      bookingException: { findMany: async () => [] },
      booking: { findMany: async () => [] },
    });
    const host = await hostRoutes(customerRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
    const response = await host.call('get /items/:id/slots', {
      user: { userId: 'user-customer', role: 'CUSTOMER' },
      params: { id: 'item-haircut' },
      query: { date: '2026-09-24' },
    }) as { data: { slots: string[] } };

    expect(response.data.slots).toEqual(['2026-09-24T13:00:00.000Z']);
  });

  it('lets checkout validate 09:00 local while the real 13:00Z start is still future', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z')); // 06:00 in Guyana
    let storedSlot: Date | undefined;
    const prisma = prismaDouble(orderStore([]), {
      item: {
        findUnique: async () => ({
          id: 'item-haircut', vendorId: 'vendor-svc', fulfillment: 'APPOINTMENT', isAvailable: true,
          bookingConfig: {
            durationMinutes: 30,
            slots: [{ dayOfWeek: 4, start: '09:00', end: '09:30' }],
          },
        }),
      },
      bookingException: { findMany: async () => [] },
      booking: { create: async ({ data }: { data: { slotStart: Date } }) => {
        storedSlot = data.slotStart;
        return data;
      } },
    });

    const service = new BookingService(prisma);
    const slot = new Date('2026-09-24T13:00:00.000Z');
    await expect(service.validateSlot(
      'item-haircut', slot,
    )).resolves.toMatchObject({ durationMinutes: 30 });
    await service.reserveSlot('item-haircut', 'customer-1', slot);
    expect(storedSlot?.toISOString()).toBe('2026-09-24T13:00:00.000Z');
  });

  it('keeps a 23:30 Guyana slot on its local Thursday across the UTC day boundary', () => {
    const config = { durationMinutes: 15, slots: [{ dayOfWeek: 4, start: '23:30', end: '23:59' }] };
    const slots = computeDaySlots({
      itemId: 'late', config, year: 2026, month: 9, day: 24,
      exceptions: [], takenStarts: [], now: new Date('2026-09-24T10:00:00.000Z'),
    });
    expect(slots.map((s) => s.toISOString())).toEqual(['2026-09-25T03:30:00.000Z']);
    expect(slotFitsConfig(slots[0]!, config, new Date('2026-09-24T10:00:00.000Z'))).toBe('OK');
    expect(fmtSlotTime(slots[0]!)).toContain('23:30');
  });

  it('queries taken bookings and exceptions by the Guyana day at 23:30 local', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
    const taken = new Date('2026-09-25T03:30:00.000Z');
    let query: { where: { slotStart: { gte: Date; lte: Date } } } | undefined;
    let exceptionDate: Date | undefined;
    const prisma = prismaDouble(orderStore([]), {
      item: { findUnique: async () => ({
        id: 'late', vendorId: 'vendor-svc', fulfillment: 'APPOINTMENT', isAvailable: true,
        bookingConfig: { durationMinutes: 15, slots: [{ dayOfWeek: 4, start: '23:30', end: '23:59' }] },
      }) },
      booking: { findMany: async (args: typeof query) => { query = args; return [{ slotStart: taken }]; } },
      bookingException: { findMany: async ({ where }: { where: { date: Date } }) => {
        exceptionDate = where.date;
        return [];
      } },
    });
    const host = await hostRoutes(customerRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
    const response = await host.call('get /items/:id/slots', {
      user: { userId: 'user-customer', role: 'CUSTOMER' },
      params: { id: 'late' }, query: { date: '2026-09-24' },
    }) as { data: { slots: string[] } };
    expect(query?.where.slotStart.gte.toISOString()).toBe('2026-09-24T04:00:00.000Z');
    expect(query?.where.slotStart.lte.toISOString()).toBe('2026-09-25T03:59:59.999Z');
    expect(response.data.slots).toEqual([]);
    await new BookingService(prisma).validateSlot('late', taken);
    expect(exceptionDate?.toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });

  it('rejects a genuinely past slot as SLOT_IN_PAST', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T14:00:00.000Z'));
    const prisma = prismaDouble(orderStore([]), {
      item: { findUnique: async () => ({
        id: 'item-haircut', vendorId: 'vendor-svc', fulfillment: 'APPOINTMENT', isAvailable: true,
        bookingConfig: { durationMinutes: 30, slots: [{ dayOfWeek: 4, start: '09:00', end: '09:30' }] },
      }) },
    });
    await expect(new BookingService(prisma).validateSlot('item-haircut', new Date('2026-09-24T13:00:00.000Z')))
      .rejects.toMatchObject({ code: 'SLOT_IN_PAST' });
  });

  it('uses the true instant for the unchanged free-cancel rule and the 9:00 AM reminder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T14:00:00.000Z'));
    const slot = new Date('2026-09-24T13:00:00.000Z');
    const snapshot = {
      status: 'PENDING', orderType: 'FOOD_DELIVERY', placedAt: new Date('2026-09-23T13:00:00.000Z'),
      holdExpiresAt: null, riderId: null, driverId: null, scheduledFor: null, appointmentSlot: slot,
    };
    expect(freeCancellationExpiresAt(snapshot)?.toISOString())
      .toBe(new Date(slot.getTime() - FREE_CANCEL_WINDOW_MIN * 60_000).toISOString());
    const bodies: string[] = [];
    let reminderWindow: { gt: Date; lte: Date } | undefined;
    const prisma = {
      serviceJob: { findMany: async () => [] },
      booking: { findMany: async ({ where }: { where: { slotStart: { gt: Date; lte: Date } } }) => {
        reminderWindow = where.slotStart;
        return [{
          id: 'booking-1', customerId: 'customer-1', slotStart: slot,
          item: { name: 'Haircut', vendor: { name: 'Sharp Cuts', owner: { userId: 'owner-1' } } },
        }];
      } },
      notification: { findFirst: async () => null },
    };
    const sent = await sendBookingReminders(prisma as never, async (n) => { bodies.push(n.body); });
    expect(sent).toBe(2);
    expect(reminderWindow?.gt.toISOString()).toBe('2026-09-23T14:00:00.000Z');
    expect(reminderWindow?.lte.toISOString()).toBe('2026-09-24T14:00:00.000Z');
    expect(bodies).toEqual([expect.stringContaining('9:00 AM'), expect.stringContaining('9:00 AM')]);
  });
});
