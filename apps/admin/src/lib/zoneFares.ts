// [ZONE-FARES] The rules the zones screen checks before it asks for a reason.
// The server enforces the same bounds (apps/api fare-zones ZONE_FARE_MIN/MAX)
// and is the authority; this only stops a request the server would refuse.

export const ZONE_FARE_MIN = 100;
export const ZONE_FARE_MAX = 1_000_000;

/** What is wrong with a typed fare, or null: a whole amount within the bounds. */
export function fareProblem(raw: string): string | null {
  if (raw.trim() === '') return 'Enter the fare.';
  const n = Number(raw);
  if (!Number.isInteger(n)) return 'The fare is a whole amount — no cents.';
  if (n < ZONE_FARE_MIN || n > ZONE_FARE_MAX) {
    return `The fare is between ${ZONE_FARE_MIN.toLocaleString('en-GY')} and ${ZONE_FARE_MAX.toLocaleString('en-GY')}.`;
  }
  return null;
}

/** GYD, whole units; a missing amount is a dash, never $0. */
export const gyd = (n: number | null): string => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-GY')}`);
