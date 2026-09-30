import { GUYANA_TZ } from '@swift/types';

/** Appointment wire values are true instants; every phone surface uses this
 * formatter so the device's zone cannot alter the displayed market time. */
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

/** Date-only calendar arithmetic, independent of the device's clock zone. */
export function addAppointmentDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function appointmentWeekday(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
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

/** A market wall time converted to a true wire instant. */
export function appointmentInstantOfWallClock(dayKey: string, hour: number, minute: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const face = Date.UTC(year!, month! - 1, day!, hour, minute);
  const offsetAt = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: GUYANA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - at;
  };
  let instant = face - offsetAt(face);
  instant = face - offsetAt(instant);
  return new Date(instant).toISOString();
}

export function upcomingAppointmentDays(now = new Date()): Array<{ key: string; label: string }> {
  const today = appointmentDayKey(now);
  return Array.from({ length: 7 }, (_, offset) => {
    const key = addAppointmentDays(today, offset);
    return { key, label: offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : formatAppointmentDay(key) };
  });
}

export function serviceJobScheduleSelection(dayKey: string, time: string, now = new Date()): { scheduledFor: string; isPast: boolean } {
  const [hour, minute] = time.split(':').map(Number);
  const scheduledFor = appointmentInstantOfWallClock(dayKey, hour!, minute!);
  return { scheduledFor, isPast: new Date(scheduledFor).getTime() < now.getTime() };
}
