/**
 * [E20 · DS234] The takeover's "time left to accept", as a person reads it.
 *
 * A food order's deadline is minutes away and reads m:ss. A booking's is
 * slot-relative and can be up to a day away, and "1440:00" is not a time
 * anyone reads — so past an hour the clock reads hours and minutes.
 */
export function acceptClockLabel(remainSecs: number): string {
  const s = Math.max(0, Math.floor(remainSecs));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}
