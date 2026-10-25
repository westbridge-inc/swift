import { GUYANA_TZ } from '@swift/types';

/** Appointment wire values are true instants; browser zone never changes labels. */
export function formatAppointmentClock(value: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: GUYANA_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value));
}

export function formatAppointmentSlot(value: string | Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: GUYANA_TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(value));
}

export function appointmentDayKey(value: string | Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GUYANA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addAppointmentDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** A day-strip label, "Thu 24", for a market calendar date. Noon UTC of that
 *  date is inside the same date in Guyana, so the zone-aware formatter names
 *  the day the key means; the parts are composed so the shape never depends
 *  on the locale's own ordering. */
export function formatAppointmentDay(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GUYANA_TZ, weekday: 'short', day: 'numeric',
  }).formatToParts(new Date(Date.UTC(year!, month! - 1, day!, 12)));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')}`;
}
