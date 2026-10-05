import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUYANA_TZ } from '@swift/types';
import { addAppointmentDays, appointmentDayKey, formatAppointmentClock, formatAppointmentDay, formatAppointmentSlot } from './appointmentTime';

// Appointment wire values are TRUE UTC instants; this module is the site's ONE
// formatter for them, in the market zone, whatever zone the browser is in.

describe('web appointment times in the market zone', () => {
  it('prints the same Guyana clock and date from true instants in any browser zone', () => {
    expect(formatAppointmentClock('2026-09-24T13:00:00.000Z')).toBe('9:00 AM');
    expect(formatAppointmentSlot('2026-09-25T03:30:00.000Z')).toContain('11:30 PM');
    expect(appointmentDayKey('2026-09-25T03:30:00.000Z')).toBe('2026-09-24');
    expect(formatAppointmentSlot('2026-09-24T13:00:00.000Z')).toBe('Thu, Sep 24, 9:00 AM');
    expect(formatAppointmentDay('2026-09-24')).toBe('Thu 24');
    expect(addAppointmentDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(GUYANA_TZ).toBe('America/Guyana');
  });

  it('every appointment surface renders through lib/appointmentTime', () => {
    for (const rel of ['app/(app)/order/vendor/[id]/page.tsx', 'app/(app)/orders/[id]/page.tsx', 'app/dashboard/orders/page.tsx', 'components/NewOrderTakeover.tsx']) {
      const text = readFileSync(join(process.cwd(), 'src', rel), 'utf8');
      expect(text, rel).toMatch(/from '@\/lib\/appointmentTime'/);
    }
  });
});
