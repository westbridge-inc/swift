import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUYANA_TZ } from '@swift/types';
import { addAppointmentDays, appointmentDayKey, appointmentInstantOfWallClock, appointmentWeekday, formatAppointmentClock, formatAppointmentDay, formatAppointmentSlot, serviceJobScheduleSelection, upcomingAppointmentDays } from './appointmentTime';

// Appointment wire values are TRUE UTC instants (a 09:00 Guyana slot travels as
// 13:00Z). This module is the phone's ONE formatter for them: every chip, cart
// line, booking detail and provider screen renders through it in the market
// zone, never in UTC and never in the device zone. These cases pass under
// TZ=UTC, TZ=America/Guyana and TZ=Asia/Tokyo alike.

describe('appointment time on a phone in any device zone', () => {
  it('shows the real 13:00Z instant as 9:00 AM Guyana', () => {
    const slot = '2026-09-24T13:00:00.000Z';
    expect(formatAppointmentClock(slot)).toBe('9:00 AM');
    expect(formatAppointmentSlot(slot)).toContain('9:00 AM');
    expect(appointmentDayKey(slot)).toBe('2026-09-24');
  });

  it('keeps a 23:30 Guyana slot on the previous UTC date', () => {
    const slot = '2026-09-25T03:30:00.000Z';
    expect(formatAppointmentClock(slot)).toBe('11:30 PM');
    expect(appointmentDayKey(slot)).toBe('2026-09-24');
  });

  it('offers service-job days from the market date and sends a true instant', () => {
    const now = new Date('2026-09-25T02:30:00.000Z'); // Sep 24, 22:30 in Guyana
    expect(upcomingAppointmentDays(now)[0]).toEqual({ key: '2026-09-24', label: 'Today' });
    expect(upcomingAppointmentDays(now)[1]).toEqual({ key: '2026-09-25', label: 'Tomorrow' });
    expect(serviceJobScheduleSelection('2026-09-25', '09:00', now)).toEqual({
      scheduledFor: '2026-09-25T13:00:00.000Z', isPast: false,
    });
  });

  it('rejects a service-job time only once its true instant has passed', () => {
    expect(serviceJobScheduleSelection('2026-09-24', '09:00', new Date('2026-09-24T10:00:00.000Z')).isPast).toBe(false);
    expect(serviceJobScheduleSelection('2026-09-24', '09:00', new Date('2026-09-24T14:00:00.000Z')).isPast).toBe(true);
  });

  it('formats the full slot and the day strip in the market zone', () => {
    expect(formatAppointmentSlot('2026-09-24T13:00:00.000Z')).toBe('Thu, Sep 24, 9:00 AM');
    expect(formatAppointmentSlot('2026-09-25T03:30:00.000Z')).toBe('Thu, Sep 24, 11:30 PM');
    expect(formatAppointmentDay('2026-09-24')).toBe('Thu 24');
    expect(appointmentWeekday('2026-09-24')).toBe(4);
    expect(addAppointmentDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(appointmentInstantOfWallClock('2026-09-24', 23, 30)).toBe('2026-09-25T03:30:00.000Z');
  });

  it('resolves and formats through the zone every app shares', () => {
    expect(GUYANA_TZ).toBe('America/Guyana');
  });
});

describe('one formatter per app', () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
  const surfaces = [
    'modules/shop/screens/MenuItemScreen.tsx',
    'modules/cart/screens/CartScreen.tsx',
    'modules/orders/screens/DeliveryScreen.tsx',
    'modules/orders/screens/OrdersHistoryScreen.tsx',
    'modules/shop/screens/HomeScreen.tsx',
    'modules/services/screens/ServiceJobsScreen.tsx',
    'modules/vendor/screens/VendorScheduleScreen.tsx',
    'modules/vendor/shared.tsx',
  ];

  it('every appointment surface renders through lib/appointmentTime and never in UTC', () => {
    for (const rel of surfaces) {
      const text = src(rel);
      expect(text, rel).toMatch(/from '(\.\.\/)+lib\/appointmentTime'/);
      expect(text, rel).not.toMatch(/timeZone: 'UTC'/);
    }
  });

  it('no phone module carries a second zone or a hand-rolled offset', () => {
    for (const rel of ['modules/vendor/shared.tsx', 'lib/vendorPreviewData.ts']) {
      expect(src(rel), rel).not.toMatch(/GUYANA_OFFSET|America\/Guyana|4 \* 60 \* 60 \* 1000/);
    }
  });
});
