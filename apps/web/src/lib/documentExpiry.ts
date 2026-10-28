import { appointmentDayKey } from './appointmentTime';
import { calendarDay } from './store-vat-words';

/**
 * [FOLLOWUPS · the admin console's gyDate rule, #2155; the phone's documentExpiry.ts, #2161] The day a document
 * expires, as people read it ("28 Oct 2031"). The expiry a person at Swift keys from the document is a calendar day,
 * stored as midnight UTC: printed in the browser's zone it read as the day before in Guyana (UTC-4). A value at
 * exactly 00:00:00.000 UTC is that stored day (calendarDay, read in UTC); any other value is a moment and prints its
 * Guyana day (appointmentDayKey), whatever zone the browser is set to. Not a date: ''.
 */
export function documentExpiryDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const storedDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return storedDay ? calendarDay(iso) : calendarDay(`${appointmentDayKey(d)}T00:00:00.000Z`);
}
