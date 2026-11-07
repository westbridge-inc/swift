/**
 * [FOLLOWUPS · the admin console's gyDate rule, #2155; the phone's documentExpiry.ts, #2161] The day a document
 * expires, as people read it ("28 Oct 2031"). The expiry a person at Swift keys from the document is a calendar day,
 * stored as midnight UTC: printed in the browser's zone it read as the day before in Guyana (UTC-4). A value at
 * exactly 00:00:00.000 UTC is that stored day (read in UTC); any other value is a moment and prints its Guyana day,
 * whatever zone the browser is set to. A fixed month table, the same words as the server and the phone. Not a date: ''.
 * Self-contained on purpose: the documents page carries no other module for it (its size budget).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const GUYANA_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guyana', year: 'numeric', month: 'numeric', day: 'numeric' });

export function documentExpiryDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const storedDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  if (storedDay) return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const parts = GUYANA_DAY.formatToParts(d);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return `${part('day')} ${MONTHS[part('month') - 1]} ${part('year')}`;
}
