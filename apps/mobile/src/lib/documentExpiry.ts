import { appointmentDayKey } from './appointmentTime';
import { calendarDay } from './storeVat';

/**
 * [FOLLOWUPS · the admin console's gyDate rule, #2155] The day a document expires, as the card prints it.
 * The expiry a person at Swift keys from the document is a calendar day, stored as midnight UTC
 * (`new Date('2031-06-30').toISOString()`): printed in the phone's zone it read as the day before in Guyana
 * (UTC-4). A value at exactly 00:00:00.000 UTC is that stored day (calendarDay, read in UTC); any other value is a
 * moment and prints its Guyana day (appointmentDayKey), whatever zone the phone is set to. Same month words as
 * calendarDay ("30 Jun 2031") on every phone. Not a date: ''.
 */
export function documentExpiryDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const storedDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return storedDay ? calendarDay(iso) : calendarDay(`${appointmentDayKey(d)}T00:00:00.000Z`);
}
